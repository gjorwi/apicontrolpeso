# ControlPeso · Mailer + Sync Backend

Servidor Node/Express para la app móvil **ControlPeso**. Realiza dos funciones:

1. **Mailer**: intermediario entre la app y un servidor SMTP (Gmail, SendGrid, Resend, etc.) para enviar recordatorios de citas a los pacientes.
2. **Sync**: persistencia de los datos del paciente (pacientes, mediciones, inyecciones, citas) por dispositivo, con almacenamiento en **MongoDB Atlas** (o archivo JSON como fallback para dev local).

## ¿Por qué existe este servidor?

- **Mailer**: la app no envía correos directamente. Guarda todo localmente (funciona offline) y cuando hay internet, **POSTea** `{ to, subject, body }` a este backend, que usa Nodemailer + la configuración SMTP (que guardas una vez desde la app).
- **Sync**: la app sigue siendo local-first (todo se guarda en AsyncStorage del dispositivo). Opcionalmente sincroniza con el servidor para tener respaldo o para consultar desde otro dispositivo.

### Ventajas
- La app nunca almacena la contraseña SMTP (se guarda cifrada en el backend).
- Si el médico cambia de dispositivo, la configuración SMTP y los datos sincronizados se conservan.
- Compatible con cualquier SMTP estándar.
- Sync por dispositivo: cada dispositivo tiene su propio `deviceId` y snapshot.

## Stack
- Node.js 18+
- Express
- Nodemailer (mailer)
- Mongoose 8 (sync, opcional: si no hay `MONGODB_URI` usa archivo JSON)
- Almacenamiento cifrado AES-256-GCM para credenciales SMTP

## Variables de entorno

| Variable | Descripción |
|---|---|
| `NODE_ENV` | `production` o `development` |
| `PORT` | Puerto del servidor (Render asigna `10000`) |
| `API_TOKEN` | Token que la app móvil envía en `Authorization: Bearer ...` |
| `ENCRYPTION_KEY` | 64 chars hex (32 bytes). Generar con `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `MOCK_MAIL` | `true` para no enviar correos reales, solo loguear (útil para dev) |
| `MONGODB_URI` | URI de MongoDB Atlas (opcional). Si está definida, los snapshots de sync se guardan en Mongo. Si no, se usa un archivo JSON local. |

## Endpoints

Todos requieren `Authorization: Bearer <API_TOKEN>` excepto `/health`.

### Salud y mailer
| Método | Ruta | Descripción |
|---|---|---|
| GET | `/health` | Health check para Render |
| GET | `/api/smtp/status` | Indica si hay SMTP configurado y desde qué email |
| POST | `/api/smtp/config` | Guarda la configuración SMTP (cifrada) |
| POST | `/api/smtp/test` | Envía un correo de prueba a un email dado |
| POST | `/api/send-appointment-email` | Envía el correo de recordatorio (usa Idempotency-Key opcional) |

### Sync (datos por dispositivo)
| Método | Ruta | Descripción |
|---|---|---|
| GET | `/api/sync/:deviceId` | Devuelve el snapshot completo del dispositivo `{ data: { patients: [...] }, ts }` |
| POST | `/api/sync/:deviceId` | Recibe `{ ts, patients, deletedPatients }`, hace merge (gana el `updatedAt` más reciente) y devuelve el snapshot fusionado |

#### Ejemplo: push + pull
```bash
curl -X POST https://tu-servidor.onrender.com/api/sync/dev-1234 \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "ts": "2026-08-04T12:00:00.000Z",
    "patients": [
      { "id": "p1", "name": "Ana", "updatedAt": "2026-08-04T12:00:00.000Z", "measurements": [...] }
    ],
    "deletedPatients": []
  }'
```
Respuesta: `{ ok, accepted, ts, data: { patients: [...] } }`.

#### Cómo funciona el merge
- Cada paciente/medición/inyección/cita tiene un campo `updatedAt` (ISO 8601) generado por la app al crear/editar.
- En el servidor, para cada paciente entrante: si el snapshot previo tiene el mismo `id` con `updatedAt` mayor, se conserva el previo; si no, se reemplaza con el entrante.
- Los pacientes en `deletedPatients` (o con `deletedAt` en el array `patients`) se eliminan del snapshot.
- El resultado se devuelve para que la app lo adopte.

## Setup local

```bash
cd server
npm install
cp .env.example .env
# Edita .env y rellena API_TOKEN y ENCRYPTION_KEY (y opcionalmente MONGODB_URI)
npm run dev
```

Sin `MONGODB_URI`, el sync se guarda en `server/data/sync.json` (útil para dev; **en Render free tier este archivo es efímero** y se pierde al reiniciar/redeployar).

## Deploy en Render (Free Tier)

### Opción A: desde el dashboard
1. Sube el repositorio a GitHub.
2. En Render, **New → Web Service** → conecta el repo.
3. **Root directory:** `server`
4. **Build command:** `npm install`
5. **Start command:** `npm start`
6. **Plan:** Free
7. **Environment variables:** añade `API_TOKEN`, `ENCRYPTION_KEY`, `NODE_ENV=production`, `MOCK_MAIL=false`, `MONGODB_URI` (opcional).
8. Deploy. Anota la URL (ej. `https://controlpeso-mailer.onrender.com`).

### Opción B: con render.yaml
1. Sube el repositorio.
2. En Render, **New → Blueprint** → selecciona el repo.
3. Render detectará `server/render.yaml` y configurará el servicio automáticamente.
4. Tras el primer deploy, ve a **Environment** y rellena `API_TOKEN` y `ENCRYPTION_KEY` (y `MONGODB_URI` si quieres persistencia real).

### Persistencia del sync con MongoDB Atlas
1. Crea un cluster gratuito en [MongoDB Atlas](https://www.mongodb.com/cloud/atlas).
2. Obtén la URI de conexión (`mongodb+srv://user:pass@cluster.mongodb.net/controlpeso`).
3. Añádela como `MONGODB_URI` en Render (Environment).
4. El servidor la detectará automáticamente y persistirá en `sync_snapshots`.

### Configurar la app móvil
Una vez desplegado, desde la app:
1. **Configuración → Servidor y sincronización**
2. Ingresa la **URL del API** (ej. `https://apicontrolpeso.onrender.com`) y el **API Token**.
3. Pulsa **Probar conexión** para verificar.
4. Pulsa **Guardar**.
5. Pulsa **Sincronizar ahora** o espera a que la app sincronice automáticamente al detectar conexión.

## Cómo generar un App Password de Gmail

1. Activa la verificación en 2 pasos en tu cuenta Google.
2. Ve a https://myaccount.google.com/apppasswords
3. Genera una contraseña para "Correo / Otro dispositivo".
4. Usa esa contraseña de 16 caracteres en la app, NO tu contraseña normal de Gmail.

## Limitaciones del free tier de Render

- El servicio se duerme tras 15 min sin uso → el primer request puede tardar ~30s.
- 750 horas/mes de uptime (más que suficiente para un consultorio).
- Sin tarjeta requerida para el free tier.
- **Filesystem efímero**: sin MongoDB, los snapshots de sync y la config SMTP se pierden al redeploy. **Recomendado**: usar MongoDB Atlas (free 1GB) para el sync.

## Seguridad
- HTTPS obligatorio en producción.
- La contraseña SMTP **nunca** se loguea ni se envía a la app.
- Token de autenticación (`API_TOKEN`) requerido en todas las rutas excepto `/health`.
- Rate limit: 60 emails/min, 10 configs/hora, 5 tests/hora.
- Idempotency-Key previene duplicados si la app reintenta.

## Troubleshooting

| Error | Causa probable | Solución |
|---|---|---|
| `SMTP_AUTH` | Usuario o contraseña incorrectos | Verifica usuario y usa App Password si es Gmail con 2FA |
| `NO_SMTP_CONFIGURED` | No se guardó la config en el backend | Configura SMTP desde la app |
| `RATE_LIMIT` | Demasiados envíos | Espera unos minutos |
| `ECONNREFUSED` | Puerto SMTP bloqueado | Usa 587 (STARTTLS) o 465 (SSL/TLS) |
| `Greeting never received` | Timeout de conexión | Verifica host y firewall |
| `UNAUTHORIZED` en sync | Token incorrecto o sin header | Verifica `API_TOKEN` en la app y en Render |
| Datos de sync se borran | Filesystem efímero sin Mongo | Configura `MONGODB_URI` apuntando a MongoDB Atlas |
