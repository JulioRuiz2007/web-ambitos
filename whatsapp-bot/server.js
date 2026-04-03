require('dotenv').config();
const express = require('express');
const { MessagingResponse } = require('twilio').twiml;
const twilio = require('twilio');
const cloudinary = require('cloudinary').v2;
const { google } = require('googleapis');
const https = require('https');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();

// Stripe webhook needs raw body — must be before other parsers
app.post('/stripe-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send('Webhook Error');
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;

    // Retrieve line items for this session
    const lineItems = await stripe.checkout.sessions.listLineItems(session.id);

    // Build WhatsApp notification
    const shipping = session.shipping_details || {};
    const address = shipping.address || {};
    const customerName = shipping.name || session.customer_details?.name || 'Cliente';
    const customerEmail = session.customer_details?.email || '';
    const customerPhone = session.customer_details?.phone || '';
    const total = (session.amount_total / 100).toFixed(2).replace('.', ',') + '€';

    let msg = '🛒 *NUEVO PEDIDO EN LA WEB*\n\n';
    msg += '👤 *Cliente:* ' + customerName + '\n';
    if (customerEmail) msg += '📧 *Email:* ' + customerEmail + '\n';
    if (customerPhone) msg += '📞 *Teléfono:* ' + customerPhone + '\n';
    msg += '\n📦 *Envío:*\n';
    msg += [address.line1, address.line2, address.postal_code + ' ' + address.city, address.state, address.country].filter(Boolean).join('\n') + '\n';
    msg += '\n── Productos ──\n\n';
    lineItems.data.forEach(item => {
      msg += '• ' + item.quantity + 'x ' + item.description + ' — ' + (item.amount_total / 100).toFixed(2).replace('.', ',') + '€\n';
    });
    msg += '\n💰 *Total: ' + total + '*';
    msg += '\n\n_Pago confirmado por Stripe_';

    // Send WhatsApp notification to owner
    try {
      const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
      await twilioClient.messages.create({
        from: 'whatsapp:' + process.env.TWILIO_WHATSAPP_FROM,
        to: 'whatsapp:' + process.env.OWNER_WHATSAPP_NUMBER,
        body: msg,
      });
      console.log('WhatsApp notification sent to owner');
    } catch (whatsappErr) {
      console.error('Failed to send WhatsApp notification:', whatsappErr.message);
    }
  }

  res.json({ received: true });
});

// Standard parsers (after raw webhook route)
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// CORS — allow frontend to call the API
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ─── Config ───────────────────────────────────────────────

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const CATEGORIAS = {
  '1': { id: 'ordenadores', nombre: 'Ordenadores' },
  '2': { id: 'componentes', nombre: 'Componentes' },
  '3': { id: 'red', nombre: 'Dispositivos de red' },
  '4': { id: 'accesorios', nombre: 'Accesorios' },
};

// ─── Google Sheets auth ───────────────────────────────────

let sheetsClient;

async function getSheetsClient() {
  if (sheetsClient) return sheetsClient;

  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  sheetsClient = google.sheets({ version: 'v4', auth });
  return sheetsClient;
}

async function appendProduct({ categoria, nombre, descripcion, precio, imagenUrl }) {
  const sheets = await getSheetsClient();
  const now = new Date().toLocaleString('es-ES', { timeZone: 'Europe/Madrid' });

  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: 'Productos!A:F',
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [[now, categoria, nombre, descripcion, precio || '', imagenUrl || '']],
    },
  });
}

async function deleteProduct(nombre) {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: 'Productos!A:F',
  });

  const rows = res.data.values || [];
  // Find row by product name (column C = index 2), skip header
  const rowIndex = rows.findIndex((row, i) => i > 0 && row[2] && row[2].toLowerCase() === nombre.toLowerCase());

  if (rowIndex === -1) return false;

  // Delete the row (Sheets API uses 1-based index, +1 for header)
  const sheetId = 0; // First sheet
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    requestBody: {
      requests: [{
        deleteDimension: {
          range: { sheetId, dimension: 'ROWS', startIndex: rowIndex, endIndex: rowIndex + 1 },
        },
      }],
    },
  });
  return true;
}

async function listProducts() {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: 'Productos!A:F',
  });

  const rows = res.data.values || [];
  // Skip header row
  return rows.slice(1).map(row => ({
    fecha: row[0] || '',
    categoria: row[1] || '',
    nombre: row[2] || '',
    descripcion: row[3] || '',
    precio: row[4] || '',
    imagenUrl: row[5] || '',
  }));
}

// ─── Cloudinary upload ────────────────────────────────────

function downloadTwilioMedia(url) {
  return new Promise((resolve, reject) => {
    const sid = process.env.TWILIO_ACCOUNT_SID;
    const token = process.env.TWILIO_AUTH_TOKEN;
    const auth = Buffer.from(`${sid}:${token}`).toString('base64');

    https.get(url, { headers: { Authorization: `Basic ${auth}` } }, (res) => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return downloadTwilioMedia(res.headers.location).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

async function uploadImage(twilioMediaUrl) {
  const buffer = await downloadTwilioMedia(twilioMediaUrl);
  const base64 = `data:image/jpeg;base64,${buffer.toString('base64')}`;

  const result = await cloudinary.uploader.upload(base64, {
    folder: 'ambitos-productos',
    transformation: [
      { width: 800, height: 600, crop: 'fill', quality: 'auto', fetch_format: 'auto' },
    ],
  });
  return result.secure_url;
}

// ─── Conversation state ───────────────────────────────────

const sessions = new Map();
const SESSION_TIMEOUT = 15 * 60 * 1000; // 15 minutes

function getSession(from) {
  const session = sessions.get(from) || { step: 'IDLE', data: {} };
  session.updatedAt = Date.now();
  sessions.set(from, session);
  return session;
}

function resetSession(from) {
  sessions.set(from, { step: 'IDLE', data: {}, updatedAt: Date.now() });
}

// Cleanup stale sessions every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, session] of sessions) {
    if (now - session.updatedAt > SESSION_TIMEOUT) sessions.delete(key);
  }
}, 5 * 60 * 1000);

// ─── Webhook ──────────────────────────────────────────────

app.post('/webhook', async (req, res) => {
  const twiml = new MessagingResponse();
  const from = req.body.From;
  const body = (req.body.Body || '').trim();
  const numMedia = parseInt(req.body.NumMedia || '0', 10);
  const mediaUrl = req.body.MediaUrl0;
  const session = getSession(from);

  try {
    // ── Quick-add: photo with formatted caption ──
    // Format: "categoría_num | nombre | descripción | precio"
    if (numMedia > 0 && body.includes('|') && session.step === 'IDLE') {
      const parts = body.split('|').map(s => s.trim());
      if (parts.length >= 3) {
        const catKey = parts[0];
        const cat = CATEGORIAS[catKey];
        if (cat) {
          const imagenUrl = await uploadImage(mediaUrl);
          await appendProduct({
            categoria: cat.id,
            nombre: parts[1],
            descripcion: parts[2],
            precio: parts[3] || '',
            imagenUrl,
          });
          twiml.message(
            `✅ *Producto añadido*\n\n` +
            `📦 ${parts[1]}\n` +
            `📂 ${cat.nombre}\n` +
            (parts[3] ? `💰 ${parts[3]}\n` : '') +
            `\n_Aparecerá en la web en unos segundos._`
          );
          resetSession(from);
          return res.type('text/xml').send(twiml.toString());
        }
      }
    }

    // ── Cancel ──
    if (['cancelar', 'salir', 'cancel'].includes(body.toLowerCase())) {
      resetSession(from);
      twiml.message('❌ Operación cancelada. Envía *HOLA* para ver el menú.');
      return res.type('text/xml').send(twiml.toString());
    }

    // ── State machine ──
    switch (session.step) {

      case 'IDLE': {
        const cmd = body.toLowerCase();

        if (['nuevo', 'añadir', 'add', '1'].includes(cmd)) {
          session.step = 'WAITING_PHOTO';
          sessions.set(from, session);
          twiml.message('📸 Envía la *foto* del producto.\n\n_O envía CANCELAR para salir._');
        }
        else if (['lista', 'ver', 'list', '2'].includes(cmd)) {
          const products = await listProducts();
          if (products.length === 0) {
            twiml.message('📋 No hay productos registrados todavía.');
          } else {
            let msg = `📋 *Productos (${products.length})*\n\n`;
            products.forEach((p, i) => {
              msg += `${i + 1}. *${p.nombre}*\n   📂 ${p.categoria}${p.precio ? ` · 💰 ${p.precio}` : ''}\n\n`;
            });
            twiml.message(msg.trim());
          }
        }
        else if (['borrar', 'eliminar', 'delete', '3'].includes(cmd)) {
          session.step = 'WAITING_DELETE_NAME';
          sessions.set(from, session);
          twiml.message('🗑️ Escribe el *nombre exacto* del producto que quieres eliminar.\n\n_Envía LISTA para ver los productos. Envía CANCELAR para salir._');
        }
        else if (numMedia > 0) {
          // Photo sent without command — start add flow with photo
          const imagenUrl = await uploadImage(mediaUrl);
          session.data.imagenUrl = imagenUrl;
          session.step = 'WAITING_CATEGORY';
          sessions.set(from, session);
          twiml.message(
            `📸 ¡Foto recibida!\n\n` +
            `¿En qué *categoría* va?\n\n` +
            `1️⃣ Ordenadores\n` +
            `2️⃣ Componentes\n` +
            `3️⃣ Dispositivos de red\n` +
            `4️⃣ Accesorios\n\n` +
            `_Responde con el número._`
          );
        }
        else {
          twiml.message(
            `👋 *¡Hola! Soy el asistente de Ámbitos.*\n\n` +
            `¿Qué quieres hacer?\n\n` +
            `1️⃣ *Nuevo* — Añadir un producto\n` +
            `2️⃣ *Lista* — Ver productos\n` +
            `3️⃣ *Borrar* — Eliminar un producto\n\n` +
            `_También puedes enviar una foto directamente para empezar a añadir un producto._\n\n` +
            `💡 *Atajo rápido:* Envía una foto con esta descripción:\n` +
            `\`1 | Nombre | Descripción | Precio\`\n` +
            `_(el número es la categoría)_`
          );
        }
        break;
      }

      case 'WAITING_PHOTO': {
        if (numMedia > 0) {
          const imagenUrl = await uploadImage(mediaUrl);
          session.data.imagenUrl = imagenUrl;
          session.step = 'WAITING_CATEGORY';
          sessions.set(from, session);
          twiml.message(
            `📸 ¡Foto recibida!\n\n` +
            `¿En qué *categoría* va?\n\n` +
            `1️⃣ Ordenadores\n` +
            `2️⃣ Componentes\n` +
            `3️⃣ Dispositivos de red\n` +
            `4️⃣ Accesorios\n\n` +
            `_Responde con el número._`
          );
        } else {
          twiml.message('⚠️ No he recibido ninguna foto. Envía la *imagen del producto*.\n\n_Envía CANCELAR para salir._');
        }
        break;
      }

      case 'WAITING_CATEGORY': {
        const cat = CATEGORIAS[body];
        if (cat) {
          session.data.categoria = cat.id;
          session.data.categoriaNombre = cat.nombre;
          session.step = 'WAITING_NAME';
          sessions.set(from, session);
          twiml.message(`📂 Categoría: *${cat.nombre}*\n\n¿Cuál es el *nombre* del producto?`);
        } else {
          twiml.message('⚠️ Responde con un número del *1 al 4*.\n\n1️⃣ Ordenadores\n2️⃣ Componentes\n3️⃣ Dispositivos de red\n4️⃣ Accesorios');
        }
        break;
      }

      case 'WAITING_NAME': {
        session.data.nombre = body;
        session.step = 'WAITING_DESCRIPTION';
        sessions.set(from, session);
        twiml.message(`✏️ Nombre: *${body}*\n\nEscribe una *descripción breve* del producto.`);
        break;
      }

      case 'WAITING_DESCRIPTION': {
        session.data.descripcion = body;
        session.step = 'WAITING_PRICE';
        sessions.set(from, session);
        twiml.message(`📝 ¡Perfecto!\n\n¿*Precio*? Escribe el precio o envía *NO* si no quieres mostrar precio.`);
        break;
      }

      case 'WAITING_PRICE': {
        const precio = ['no', 'sin', 'n', '-'].includes(body.toLowerCase()) ? '' : body;
        session.data.precio = precio;

        // Save to Google Sheets
        await appendProduct({
          categoria: session.data.categoria,
          nombre: session.data.nombre,
          descripcion: session.data.descripcion,
          precio,
          imagenUrl: session.data.imagenUrl,
        });

        twiml.message(
          `✅ *¡Producto añadido!*\n\n` +
          `📦 *${session.data.nombre}*\n` +
          `📂 ${session.data.categoriaNombre}\n` +
          `📝 ${session.data.descripcion}\n` +
          (precio ? `💰 ${precio}\n` : '') +
          `\n_Aparecerá en la web en unos segundos._\n\n` +
          `Envía *NUEVO* para añadir otro producto.`
        );
        resetSession(from);
        break;
      }

      case 'WAITING_DELETE_NAME': {
        const deleted = await deleteProduct(body);
        if (deleted) {
          twiml.message(`✅ Producto *"${body}"* eliminado correctamente.`);
        } else {
          twiml.message(`⚠️ No encontré ningún producto con el nombre *"${body}"*.\n\nEnvía *LISTA* para ver los productos actuales.`);
        }
        resetSession(from);
        break;
      }

      default:
        resetSession(from);
        twiml.message('⚠️ Algo salió mal. Envía *HOLA* para empezar de nuevo.');
    }
  } catch (err) {
    console.error('Error en webhook:', err);
    twiml.message('❌ Ha ocurrido un error. Inténtalo de nuevo en unos momentos.');
    resetSession(from);
  }

  res.type('text/xml').send(twiml.toString());
});

// ─── Stripe Checkout ─────────────────────────────────────

app.post('/create-checkout', async (req, res) => {
  try {
    const { items, successUrl, cancelUrl } = req.body;

    if (!items || !items.length) {
      return res.status(400).json({ error: 'No items provided' });
    }

    const line_items = items.map(item => {
      const price = parseFloat((item.price || '').replace(/[^0-9.,]/g, '').replace(',', '.'));
      if (isNaN(price) || price <= 0) {
        throw new Error('Producto sin precio válido: ' + item.name);
      }
      return {
        price_data: {
          currency: 'eur',
          product_data: {
            name: item.name,
            ...(item.img ? { images: [item.img] } : {}),
          },
          unit_amount: Math.round(price * 100),
        },
        quantity: item.qty,
      };
    });

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items,
      mode: 'payment',
      success_url: successUrl || process.env.FRONTEND_URL + '/pedido-confirmado.html',
      cancel_url: cancelUrl || process.env.FRONTEND_URL + '/productos.html',
      shipping_address_collection: { allowed_countries: ['ES'] },
      phone_number_collection: { enabled: true },
      locale: 'es',
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Error creating checkout session:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Health check ─────────────────────────────────────────

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'Ámbitos WhatsApp Bot' });
});

// ─── Start ────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Bot de WhatsApp escuchando en puerto ${PORT}`);
  console.log(`Webhook URL: http://localhost:${PORT}/webhook`);
});
