# Configuración del Bot de WhatsApp — Ámbitos S.L.

Guía paso a paso para poner en marcha el bot de WhatsApp que permite añadir productos a la web desde el móvil.

---

## Arquitectura

```
Tu padre envía WhatsApp con foto + datos
        ↓
    Twilio (recibe el mensaje)
        ↓
    Tu servidor (Node.js en Render/Railway)
        ↓
    Cloudinary (guarda la foto) + Google Sheets (guarda los datos)
        ↓
    productos.html lee Google Sheets y muestra los productos
```

---

## Paso 1 — Crear cuenta en Twilio

1. Ve a https://www.twilio.com/try-twilio y crea una cuenta gratuita
2. Ve a **Console** → copia el **Account SID** y **Auth Token**
3. Ve a **Messaging** → **Try it out** → **Send a WhatsApp message**
4. Te dará un número de sandbox (ej: `+1 415 523 8886`) y un código para unirte (ej: `join xxxxx-xxxxx`)
5. Tu padre tiene que enviar ese código al número de sandbox por WhatsApp para activarlo

> **Nota:** El sandbox es gratuito y funciona perfecto para uso personal. Para un número propio, necesitas aprobar un "WhatsApp Business Profile" en Twilio (~15€/mes).

---

## Paso 2 — Crear cuenta en Cloudinary

1. Ve a https://cloudinary.com/users/register/free y crea una cuenta gratuita
2. En el Dashboard, copia:
   - **Cloud Name**
   - **API Key**
   - **API Secret**

> El plan gratuito incluye 25GB de almacenamiento y 25GB de ancho de banda — más que suficiente.

---

## Paso 3 — Crear Google Sheet + Service Account

### 3.1 — Crear el Google Sheet

1. Ve a https://sheets.google.com y crea un nuevo spreadsheet
2. Nómbralo **"Ámbitos - Productos"**
3. En la primera hoja, renómbrala a **"Productos"** (clic derecho en la pestaña → Cambiar nombre)
4. En la fila 1, escribe estos encabezados:

| A | B | C | D | E | F |
|---|---|---|---|---|---|
| Fecha | Categoría | Nombre | Descripción | Precio | Imagen URL |

5. Copia el **ID del Sheet** de la URL: `https://docs.google.com/spreadsheets/d/`**ESTE_ID_AQUI**`/edit`

### 3.2 — Publicar el Sheet (para que la web pueda leerlo)

1. En el Sheet, ve a **Archivo** → **Compartir** → **Publicar en la web**
2. Selecciona "Hoja 1" y formato "Página web"
3. Haz clic en **Publicar**

### 3.3 — Crear Service Account (para que el bot pueda escribir)

1. Ve a https://console.cloud.google.com
2. Crea un nuevo proyecto o selecciona uno existente
3. Ve a **APIs y servicios** → **Biblioteca**
4. Busca **"Google Sheets API"** y habilítala
5. Ve a **APIs y servicios** → **Credenciales**
6. Clic en **Crear credenciales** → **Cuenta de servicio**
7. Nombre: `ambitos-bot` → Clic en **Crear**
8. Salta los permisos opcionales → **Listo**
9. Haz clic en la cuenta de servicio que acabas de crear
10. Ve a la pestaña **Claves** → **Agregar clave** → **Crear nueva clave** → JSON → **Crear**
11. Se descargará un archivo `.json` — guárdalo bien, lo necesitas

### 3.4 — Compartir el Sheet con el Service Account

1. Abre el archivo `.json` descargado y busca el campo `"client_email"` (algo como `ambitos-bot@tu-proyecto.iam.gserviceaccount.com`)
2. En tu Google Sheet, haz clic en **Compartir**
3. Pega el email del service account y dale permiso de **Editor**
4. Desmarca "Notificar" y haz clic en **Compartir**

---

## Paso 4 — Desplegar el servidor

### Opción A: Render (recomendado, gratis)

1. Ve a https://render.com y crea una cuenta
2. Clic en **New** → **Web Service**
3. Conecta tu repositorio de GitHub (o sube el código)
4. Configura:
   - **Name:** `ambitos-whatsapp-bot`
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Plan:** Free
5. En **Environment Variables**, añade todas las variables del `.env.example`:
   - `TWILIO_ACCOUNT_SID`
   - `TWILIO_AUTH_TOKEN`
   - `CLOUDINARY_CLOUD_NAME`
   - `CLOUDINARY_API_KEY`
   - `CLOUDINARY_API_SECRET`
   - `GOOGLE_SHEET_ID`
   - `GOOGLE_SERVICE_ACCOUNT_JSON` (pega TODO el contenido del archivo .json en una sola línea)
6. Clic en **Create Web Service**
7. Espera a que haga el deploy — te dará una URL tipo `https://ambitos-whatsapp-bot.onrender.com`

### Opción B: Railway

1. Ve a https://railway.app
2. **New Project** → **Deploy from GitHub** o sube el código
3. Configura las mismas variables de entorno
4. Railway te dará una URL pública automáticamente

---

## Paso 5 — Conectar Twilio con tu servidor

1. Ve a la consola de Twilio → **Messaging** → **Try it out** → **Send a WhatsApp message**
2. En **Sandbox Configuration**, busca el campo **"When a message comes in"**
3. Pega tu URL del servidor + `/webhook`:
   ```
   https://ambitos-whatsapp-bot.onrender.com/webhook
   ```
4. Método: **POST**
5. Guarda la configuración

---

## Paso 6 — Configurar Stripe (pagos con tarjeta)

### 6.1 — Crear cuenta en Stripe

1. Ve a https://dashboard.stripe.com/register y crea una cuenta
2. Completa la verificación de identidad (necesitas DNI y datos bancarios)
3. En el Dashboard, copia la **Secret Key** (`sk_test_...` para pruebas, `sk_live_...` para producción)

### 6.2 — Configurar el Webhook de Stripe

1. Ve a **Desarrolladores** → **Webhooks** en el Dashboard de Stripe
2. Clic en **Añadir endpoint**
3. URL del endpoint:
   ```
   https://ambitos-whatsapp-bot.onrender.com/stripe-webhook
   ```
4. Eventos a escuchar: selecciona **`checkout.session.completed`**
5. Clic en **Añadir endpoint**
6. Copia el **Signing Secret** (`whsec_...`) — lo necesitas para las variables de entorno

### 6.3 — Añadir variables de entorno

En Render (o Railway), añade estas variables:

- `STRIPE_SECRET_KEY` — tu clave secreta de Stripe
- `STRIPE_WEBHOOK_SECRET` — el signing secret del webhook
- `OWNER_WHATSAPP_NUMBER` — número del dueño con código de país (ej: `+34609659015`)
- `TWILIO_WHATSAPP_FROM` — número de Twilio WhatsApp (sandbox: `+14155238886`)
- `FRONTEND_URL` — URL de la web (ej: `https://ambitos.es`, sin barra final)

### 6.4 — Configurar la URL del servidor en productos.html

En el archivo `productos.html`, busca esta línea:

```javascript
const API_URL = 'https://ambitos-whatsapp-bot.onrender.com';
```

Reemplázala con la URL real de tu servidor en Render.

> **Nota:** Usa `sk_test_...` para pruebas. Stripe te da tarjetas de prueba como `4242 4242 4242 4242` (cualquier fecha futura y CVC). Cuando todo funcione, cambia a `sk_live_...` para cobros reales.

---

## Paso 7 — Configurar productos.html

En el archivo `productos.html`, busca esta línea cerca del final:

```javascript
const GOOGLE_SHEET_ID = 'TU_GOOGLE_SHEET_ID_AQUI';
```

Reemplázala con el ID real de tu Google Sheet.

---

## Paso 8 — Probar

1. Desde el móvil de tu padre, envía el código de activación al número de Twilio por WhatsApp
2. Envía **"hola"** — debería responder con el menú
3. Envía **"nuevo"** → sigue las instrucciones → envía foto, categoría, nombre, descripción, precio
4. Abre el Google Sheet y verifica que aparece la fila nueva
5. Abre productos.html en el navegador y verifica que aparece el producto
6. Añade un producto al carrito y pulsa **"Tramitar pedido"** — debería redirigirte a Stripe
7. Usa la tarjeta de prueba `4242 4242 4242 4242` (cualquier fecha futura, CVC `123`)
8. Tras el pago, deberías ver la página de confirmación y tu padre recibirá un WhatsApp

---

## Uso diario

Tu padre puede:

### Añadir producto (guiado)
1. Enviar **"nuevo"** o directamente una **foto**
2. El bot le va preguntando: categoría → nombre → descripción → precio
3. El producto aparece en la web

### Añadir producto (rápido)
Enviar una foto con esta descripción:
```
1 | Portátil HP 15s | Intel i5, 8GB RAM, SSD 256GB | 459€
```
Donde el primer número es la categoría:
- 1 = Ordenadores
- 2 = Componentes
- 3 = Dispositivos de red
- 4 = Accesorios

### Ver productos
Enviar **"lista"**

### Eliminar producto
Enviar **"borrar"** y luego el nombre exacto del producto

---

## Troubleshooting

- **El bot no responde:** Verifica que la URL del webhook en Twilio es correcta y que el servidor está corriendo
- **Error de Google Sheets:** Verifica que compartiste el Sheet con el email del service account
- **Las fotos no se ven:** Verifica las credenciales de Cloudinary
- **La web no carga productos:** Verifica que el Sheet está publicado y que el ID en productos.html es correcto
- **Error al tramitar pedido:** Verifica que `API_URL` en productos.html apunta a tu servidor y que `STRIPE_SECRET_KEY` está configurada
- **No llega el WhatsApp al hacer un pedido:** Verifica que el número del dueño ha activado el sandbox de Twilio y que `OWNER_WHATSAPP_NUMBER` y `TWILIO_WHATSAPP_FROM` están correctos
- **Stripe rechaza el webhook:** Verifica que `STRIPE_WEBHOOK_SECRET` coincide con el del Dashboard de Stripe
