# ControlPeso · Backend (Mailer + Sync + Encuestas + Push)

Servidor Node/Express para la app móvil **ControlPeso**. Cuatro funciones:

1. **Mailer**: envío de correos vía **Resend** (recordatorios de citas y encuestas de seguimiento).
2. **Sync**: persistencia de los datos del paciente por dispositivo, con **MongoDB Atlas** (o archivo JSON como fallback local).
3. **Encuestas de seguimiento**: envío automático del link por correo, recepción de respuestas, evaluación con IA (criterio médico) y alertas push al médico.
4. **Push**: registro de dispositivos (Expo Push) y notificaciones (alertas de encuesta, recordatorios de citas/medicación, digest diario).

## ¿Por qué existe este servidor?

- **Mailer**: la app no envía correos directamente. Guarda todo localmente (funciona offline) y cuando hay internet, POSTea a este backend, que envía con Resend. La configuración del remitente se guarda **cifrada** (AES-256-GCM) y nunca se expone a la app.
- **Sync**: la app sigue siendo local-first (AsyncStorage). Opcionalmente sincroniza con el servidor para respaldo o consulta desde otro dispositivo.
- **Encuestas**: el servidor programa el envío (L/M/V), genera un link con token por paciente, guarda las respuestas, las evalúa con DeepSeek (con respaldo por reglas locales) y avisa al médico por push si algo requiere atención.
- **Ventajas**: cada dispositivo tiene su propio `deviceId` y snapshot; el SMTP/remitente y los datos sobreviven a un cambio de dispositivo.

## Stack

- Node.js 18+
- Express
- **Resend** (envío de correos por HTTP; no usa SMTP)
- Mongoose 8 (opcional: sin `MONGODB_URI`/`DATABASE_URL` usa archivos JSON en `server/data/`)
- **expo-server-sdk** (notificaciones push vía Expo)
- DeepSeek API (evaluación IA de los reportes)

## Variables de entorno

| Variable | Descripción |
|---|---|
| `NODE_ENV` | `production` o `development` |
| `PORT` | Puerto del servidor (Render asigna `10000`) |
| `API_TOKEN` | Token que la app móvil envía en `Authorization: Bearer ...` |
| `ENCRYPTION_KEY` | 64 chars hex (32 bytes). Generar con `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `MOCK_MAIL` | `true` para no enviar correos reales, solo loguear (útil para dev) |
| `MONGODB_URI` | URI de MongoDB Atlas (opcional). Si está definida, sync, encuestas, dispositivos y config se guardan en Mongo. |
| `DATABASE_URL` | Alternativa a `MONGODB_URI` si el proveedor expone esa variable. |
| `RESEND_API_KEY` | API key de Resend para enviar correos por HTTP. |
| `RESEND_DEFAULT_FROM` | Remitente de respaldo. Se usa si la app aún no guardó config. |
| `RESEND_DEFAULT_NAME` | Nombre del remitente de respaldo (default `ControlPeso`). |
| `APPT_TIMEZONE` | Zona horaria de la clínica para citas, recordatorios y envío de encuestas (ej. `America/Caracas`). |
| `SURVEY_BASE_URL` | **Obligatoria para las encuestas.** URL pública de la app de encuesta (Next.js en Vercel). El link del correo es `{SURVEY_BASE_URL}/responder?t=<token>`. Sin ella, los envíos fallan con `no_url`. |
| `EXPO_ACCESS_TOKEN` | Opcional. Token de Expo para enviar push con más fiabilidad. |
| `DEEPSEEK_API_KEY` | API key de DeepSeek para **Susam** (evaluación de reportes y análisis clínico). La clave vive solo en el servidor. Sin ella, la evaluación cae a reglas locales. |
| `DEEPSEEK_MODEL` | Modelo de DeepSeek (default `deepseek-chat`). |
| `DEEPSEEK_BASE_URL` | Endpoint base de DeepSeek (default `https://api.deepseek.com`). |
| `AI_SURVEY_TIMEOUT_MS` | Timeout de la evaluación IA de reportes (default `60000`). |
| `SCHEDULER_TICK_MS` | Intervalo del scheduler en ms (default `60000`). |

## Endpoints

Autenticación: `Authorization: Bearer <API_TOKEN>` en todas las rutas **excepto** `/health` y las tres rutas públicas de la encuesta (`GET /api/survey/questions`, `GET /api/survey/open`, `POST /api/survey/submit`), que se autentican con el **token del enlace** (`?t=`).

### Salud y mailer
| Método | Ruta | Descripción |
|---|---|---|
| GET | `/health` | Health check para Render (incluye estado del scheduler) |
| GET | `/api/smtp/status` | Indica si hay remitente configurado y desde qué email |
| POST | `/api/smtp/config` | Guarda la configuración del remitente (cifrada) |
| POST | `/api/smtp/test` | Envía un correo de prueba |
| POST | `/api/smtp/send-appointment-email` | Envía el correo de recordatorio de cita (acepta `Idempotency-Key` opcional) |
| POST | `/api/smtp/retry-appointment-email` | Reintenta un correo de cita fallido |

### Encuestas de seguimiento
| Método | Ruta | Auth | Descripción |
|---|---|---|---|
| GET | `/api/survey/questions?t=` | token del enlace | Devuelve las preguntas; marca la invitación como `opened`; `410` si venció |
| GET | `/api/survey/open?t=` | token del enlace | Métrica de apertura del link |
| POST | `/api/survey/submit` | token del enlace | Guarda `{ t, answers: [{questionId, value}] }` y lanza la evaluación IA en background. `409` si ya respondió, `410` si venció |
| GET | `/api/survey/overview?date=&deviceId=` | Bearer | Tabla del día: estado por paciente + `counts.alerts` |
| GET | `/api/survey/pending?date=` | Bearer | Pacientes sin reporte en la fecha (base del digest) |
| GET | `/api/survey/patients/:patientId?deviceId=` | Bearer | Historial de invitaciones y respuestas del paciente |
| POST | `/api/survey/send` | Bearer | Envío/reenvío manual del correo `{ patientId, deviceId?, date? }` |
| GET | `/api/survey/config` | Bearer | Configuración vigente (días, horarios, preguntas) |
| PUT | `/api/survey/config` | Bearer | Edita la configuración (incrementa `version`) |

**Flujo**: el scheduler (cada `SCHEDULER_TICK_MS`) llama a `surveyJobs.run()` → en días pautados (default L/M/V) entre `time` (09:00) y `lateUntil` (21:00) envía el correo con link a los pacientes que no respondieron → el paciente responde en la app de encuesta → se guarda en `survey_responses` → `evaluateAndNotify` llama a DeepSeek (triaje médico) con respaldo de reglas por severidad → si `alerta` es true, push `survey_alert` a todos los dispositivos registrados → a las `digestTime` (18:00), digest `survey_pending` con los pacientes sin reporte.

**Reintentos**: si el proceso se cae durante la llamada a la IA, la respuesta queda `aiStatus='pending'` y el scheduler la reintenta (`retryPendingEvaluations`, máx. 3 por tick) sin duplicar alerts push.

### Dispositivos (push)
| Método | Ruta | Descripción |
|---|---|---|
| POST | `/api/devices/register` | `{ deviceId, pushToken, platform }` — registra el token Expo del móvil |
| POST | `/api/devices/unregister` | Quita el dispositivo |
| GET | `/api/devices/status?deviceId=` | Estado del registro |
| POST | `/api/devices/test-push` | Envía push de prueba y devuelve el ticket real de Expo |

### Susam (IA con DeepSeek)
| Método | Ruta | Descripción |
|---|---|---|
| POST | `/api/ai/evaluate` | Recibe `{ patient, metrics, recommendations }`, construye el prompt profesional y llama a DeepSeek. Devuelve `{ ok, content, model, usage }`. Requiere `DEEPSEEK_API_KEY`. Rate limit: 6/min. |

Flujo: la app (botón **Susam** en la ficha del paciente) envía los datos → el servidor arma el prompt → DeepSeek analiza → la app muestra el resultado y el médico puede guardarlo en `patient.analyses[]`.

### Sync (datos por dispositivo)
| Método | Ruta | Descripción |
|---|---|---|
| GET | `/api/sync/discover` | Lista los `deviceId` con snapshot guardado |
| GET | `/api/sync/:deviceId` | Devuelve el snapshot completo `{ data: { patients: [...] }, ts }` |
| POST | `/api/sync/:deviceId` | Recibe `{ ts, patients, deletedPatients }`, hace merge (gana el `updatedAt` más reciente) y devuelve el snapshot fusionado. También despierta un tick del scheduler al detalle |
| GET | `/api/sync/:deviceId/appointments` | Citas con su estado de notificación (`notify`) |

#### Cómo funciona el merge
- Cada paciente/medición/inyección/cita tiene un campo `updatedAt` (ISO 8601) generado por la app al crear/editar.
- Para cada paciente entrante: si el snapshot previo tiene el mismo `id` con `updatedAt` mayor, se conserva el previo; si no, se reemplaza con el entrante.
- Los pacientes en `deletedPatients` (o con `deletedAt`) se eliminan del snapshot.
- El resultado se devuelve para que la app lo adopte.

## Persistencia

Con `MONGODB_URI`/`DATABASE_URL` se usan colecciones de Mongo; sin ellas, archivos JSON en `server/data/` (efímeros en Render free):

| Colección | Archivo fallback | Contenido |
|---|---|---|
| `sync_snapshots` | `sync.json` | Snapshot por `deviceId` |
| `survey_invites` / `survey_responses` / `survey_dispatch` / `survey_settings` | `survey.json` / `survey_config.json` | Invitaciones (tokens), respuestas + evaluación IA, trabajos únicos por día, configuración |
| `devices` | `devices.json` | Tokens push por dispositivo |
| `notification_states` | `notifications.json` | Estado de notificaciones de citas (dedupe) |
| `smtp_config` | `smtp.enc` | Remitente cifrado (AES-256-GCM) |

## Setup local

```bash
cd server
npm install
cp .env.example .env
# Edita .env: API_TOKEN, ENCRYPTION_KEY, SURVEY_BASE_URL, DEEPSEEK_API_KEY (y MONGODB_URI si quieres)
npm run dev
```

Para probar el envío de correos sin correos reales usa `MOCK_MAIL=true`.

## Deploy en Render (Free Tier)

### Opción A: desde el dashboard
1. Sube el repositorio a GitHub.
2. En Render, **New → Web Service** → conecta el repo.
3. **Root directory:** `server`
4. **Build command:** `npm install`
5. **Start command:** `npm start`
6. **Plan:** Free
7. **Environment variables:** `API_TOKEN`, `ENCRYPTION_KEY`, `NODE_ENV=production`, `MOCK_MAIL=false`, `MONGODB_URI`, `RESEND_API_KEY`, `RESEND_DEFAULT_FROM`, `RESEND_DEFAULT_NAME`, `APPT_TIMEZONE`, `SURVEY_BASE_URL`, `DEEPSEEK_API_KEY`, `EXPO_ACCESS_TOKEN` (opcional).
8. Deploy. Anota la URL (ej. `https://apicontrolpeso.onrender.com`).

### Opción B: con render.yaml
1. Sube el repositorio.
2. En Render, **New → Blueprint** → selecciona el repo.
3. Render detectará `server/render.yaml` y configurará el servicio (los valores secretos quedan en `sync: false`: `API_TOKEN`, `ENCRYPTION_KEY`, `MONGODB_URI`, `RESEND_API_KEY`, `EXPO_ACCESS_TOKEN`, `SURVEY_BASE_URL`, `DEEPSEEK_API_KEY`).
4. Tras el primer deploy, ve a **Environment** y rellena esos valores.

### Desplegar la app de encuesta (Vercel)
1. Sube la carpeta `encuesta/` como proyecto en [Vercel](https://vercel.com).
2. En **Settings → Environment Variables**: `NEXT_PUBLIC_API_URL=https://apicontrolpeso.onrender.com`.
3. Copia el dominio asignado (ej. `https://encuesta-controlpeso.vercel.app`) a `SURVEY_BASE_URL` en Render → redeploy.

### Persistencia con MongoDB Atlas
1. Crea un cluster gratuito en [MongoDB Atlas](https://www.mongodb.com/cloud/atlas).
2. Obtén la URI de conexión.
3. Añádela como `MONGODB_URI` en Render (Environment).
4. El servidor persistirá sync, encuestas, dispositivos y config en Mongo.

### Configurar la app móvil
1. **Configuración → Servidor y sincronización**
2. Ingresa la **URL del API** (ej. `https://apicontrolpeso.onrender.com`) y el **API Token**.
3. **Probar conexión** → **Guardar** → **Sincronizar ahora**.
4. En **Configuración** usa **Probar push** para verificar el registro de notificaciones.

## Limitaciones del free tier de Render

- El servicio se duerme tras 15 min sin uso → el primer request puede tardar ~30s.
- **Filesystem efímero**: sin MongoDB, los datos de sync/encuestas/dispositivos se pierden al redeploy. Con `MONGODB_URI` todo persiste.
- Cada request que sincroniza despierta un tick del scheduler, lo que ayuda a recuperar el envío de encuestas tras dormir.

## Seguridad

- HTTPS obligatorio en producción.
- La config del remitente se guarda cifrada (AES-256-GCM) y **nunca** se loguea ni se envía a la app.
- `API_TOKEN` requerido en todas las rutas excepto `/health` y las 3 rutas públicas de encuesta (autenticadas por el token del enlace, con TTL de 72 h).
- Rate limit por IP: encuesta (questions 30/min, open 60/min, submit 10/min), correos 60/min, IA 6/min.
- Idempotency-Key previene duplicados si la app reintenta el correo de cita.

## Troubleshooting

| Error | Causa probable | Solución |
|---|---|---|
| `NO_SMTP_CONFIGURED` | No hay remitente en el servidor ni `RESEND_DEFAULT_FROM` | La app lo auto-configura al abrir Configuración; o setea `RESEND_DEFAULT_FROM` en Render |
| `RATE_LIMIT` | Demasiados envíos | Espera unos minutos |
| `UNAUTHORIZED` en sync | Token incorrecto o sin header | Verifica `API_TOKEN` en la app y en Render |
| Datos de sync se borran | Filesystem efímero sin Mongo | Configura `MONGODB_URI` apuntando a MongoDB Atlas |
| Envío de encuesta falla con `no_url` | Falta `SURVEY_BASE_URL` | Define la URL de la app de encuesta en Render y redeployea |
| `AI_NOT_CONFIGURED` / evaluaciones en `error` | Falta `DEEPSEEK_API_KEY` | Añade la clave en Render; el scheduler reintenta solo las pendientes |
| Push no llega al móvil | Dispositivo sin registrar o token inválido | En la app: **Configuración → Probar push**; verifica `EXPO_ACCESS_TOKEN` |
| Link del correo vencido (410) | Token con TTL de 72 h | Usa **Reenviar reporte** desde la ficha del paciente |
