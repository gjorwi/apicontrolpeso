const syncStore = require('./syncStore');
const deviceStore = require('./deviceStore');
const notificationStore = require('./notificationStore');
const pushService = require('./pushService');
const { sendMail } = require('./mailer');
const { loadConfig } = require('./smtpStore');

let intervalHandle = null;
let running = false;
let lastTickAt = 0;

const TICK_MS = Number(process.env.SCHEDULER_TICK_MS) || 60000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Zona horaria de la clínica. La app guarda fecha/hora en hora local del
// dispositivo (sin zona), así que necesitamos saber dónde interpretarlas.
// Si no se configura, se asume UTC para no cambiar el comportamiento previo.
const APPT_TIMEZONE = process.env.APPT_TIMEZONE || 'UTC';

function pad2(n) {
  return String(n).padStart(2, '0');
}

// Convierte una hora "de pared" local (y,mes0,d,h,min) al instante UTC real
// teniendo en cuenta la zona horaria (y DST) configurada en APPT_TIMEZONE.
function wallToUtc(tz, y, m0, d, hh, mm) {
  const wallMs = Date.UTC(y, m0, d, hh, mm);
  if (!tz || tz === 'UTC' || tz === 'Etc/UTC') return wallMs;
  let utcGuess = wallMs;
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    for (let i = 0; i < 3; i++) {
      const parts = fmt.formatToParts(new Date(utcGuess));
      const map = {};
      for (const p of parts) map[p.type] = p.value;
      const guessWall = Date.UTC(
        Number(map.year), Number(map.month) - 1, Number(map.day),
        Number(map.hour) % 24, Number(map.minute)
      );
      const delta = guessWall - utcGuess;
      utcGuess = wallMs - delta;
    }
    const parts = fmt.formatToParts(new Date(utcGuess));
    const map = {};
    for (const p of parts) map[p.type] = p.value;
    const back = Date.UTC(
      Number(map.year), Number(map.month) - 1, Number(map.day),
      Number(map.hour) % 24, Number(map.minute)
    );
    return Math.abs(back - wallMs) <= 3600000 ? utcGuess : wallMs;
  } catch (e) {
    return wallMs;
  }
}

function buildApptDateTime(appointment) {
  if (!appointment?.date) return null;
  const date = String(appointment.date);
  const time = String(appointment.time || '09:00');
  const dm = date.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!dm) return null;
  const tm = time.match(/^(\d{1,2}):(\d{2})/);
  const y = Number(dm[1]);
  const m0 = Number(dm[2]) - 1;
  const d = Number(dm[3]);
  const hh = tm ? Number(tm[1]) : 9;
  const mm = tm ? Number(tm[2]) : 0;
  const ms = wallToUtc(APPT_TIMEZONE, y, m0, d, hh, mm);
  return isNaN(ms) ? null : new Date(ms);
}

function dayBefore9am(appointment) {
  if (!appointment?.date) return null;
  const date = String(appointment.date);
  const dm = date.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!dm) return null;
  const y = Number(dm[1]);
  const m0 = Number(dm[2]) - 1;
  const d = Number(dm[3]);
  const apptMidnightUtc = wallToUtc(APPT_TIMEZONE, y, m0, d, 0, 0);
  const prevUtc = new Date(apptMidnightUtc - 86400000);
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: APPT_TIMEZONE,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const parts = fmt.formatToParts(prevUtc);
  const map = {};
  for (const p of parts) map[p.type] = p.value;
  const py = Number(map.year);
  const pm0 = Number(map.month) - 1;
  const pd = Number(map.day);
  const ms = wallToUtc(APPT_TIMEZONE, py, pm0, pd, 9, 0);
  return isNaN(ms) ? null : new Date(ms);
}

function buildPushPayload({ patient, appointment, kind }) {
  const dateISO = appointment.date;
  const time = appointment.time || '09:00';
  const date = new Date(dateISO + 'T00:00:00');
  const dateLabel = isNaN(date.getTime())
    ? dateISO
    : date.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' });
  const label = patient?.name || 'tu paciente';
  if (kind === '1d') {
    return {
      title: `Cita mañana: ${label}`,
      body: `Mañana a las ${time} tenés cita con ${label}.`,
      data: { type: 'appointment_reminder', kind, patientId: patient.id, appointmentId: appointment.id },
    };
  }
  if (kind === '1h') {
    return {
      title: `En 1 hora: cita con ${label}`,
      body: `A las ${time} tenés cita con ${label}.`,
      data: { type: 'appointment_reminder', kind, patientId: patient.id, appointmentId: appointment.id },
    };
  }
  return {
    title: 'Recordatorio de cita',
    body: `Cita con ${label}`,
    data: { type: 'appointment_reminder', kind, patientId: patient.id, appointmentId: appointment.id },
  };
}

function buildEmailPayload({ patient, appointment, kind = '1d' }) {
  const dateISO = appointment.date;
  const time = appointment.time || '09:00';
  const date = new Date(dateISO + 'T00:00:00');
  const dateLabel = isNaN(date.getTime())
    ? dateISO
    : date.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const typeLabel = 'Control de peso y aplicación de inyección';
  const medName = patient?.injectionMed ? patient.injectionMed : null;
  const medLine = medName ? `\nMedicamento: ${medName}` : '';
  const notes = appointment.notes ? `\nNotas: ${appointment.notes}` : '';
  const subject = kind === '1h'
    ? `Recordatorio: tu cita es hoy en 1 hora (${time})`
    : `Recordatorio de cita - ${dateLabel}`;
  const intro = kind === '1h'
    ? 'Te recordamos que tu cita es HOY, en 1 hora.'
    : 'Te recordamos tu cita programada.';
  const body = `Hola ${patient?.name || ''},

${intro}

Detalles de la cita:
- Tipo: ${typeLabel}
- Fecha: ${dateLabel}
- Hora: ${time}${medLine}${notes}

En esta cita realizaremos control de peso, medidas corporales${medName ? ` y aplicación de ${medName}` : ''}.

Por favor, confirma tu asistencia respondiendo a este mensaje. Te recomendamos asistir en ayunas y con ropa cómoda.

Saludos cordiales.`;
  return { subject, body };
}

const MIN_HOURS_FOR_1D_REMINDER = 12;
const MIN_MINUTES_FOR_1H_REMINDER = 5;
const MAX_EMAIL_ATTEMPTS = 5;
const MAX_PUSH_ATTEMPTS = 10;
const EMAIL_BACKOFF_MIN = [5, 30, 120, 720, 1440];
const PUSH_BACKOFF_MIN = [5, 30, 120, 720, 1440, 2880, 5760, 11520, 23040, 46080];
const CLAIM_LOST = Symbol('claim_lost');

function nowISO() {
  return new Date().toISOString();
}

function retryAfter(attempts, table) {
  const idx = Math.min(Math.max(attempts - 1, 0), table.length - 1);
  return new Date(Date.now() + table[idx] * 60 * 1000).toISOString();
}

function shouldSend(cur) {
  if (!cur) return true;
  if (cur.status === 'sent' || cur.status === 'skipped') return false;
  if (cur.gaveUp) return false;
  if (cur.nextRetryAt && new Date(cur.nextRetryAt).getTime() > Date.now()) return false;
  return true;
}

async function tryEmail(field, kind, cur, ctx) {
  const { deviceId, patient, appointment } = ctx;
  if (!patient.email) {
    return { status: 'no_email', at: nowISO(), attempts: 0, error: null };
  }
  if (process.env.MOCK_MAIL === 'true' || !loadConfig()) {
    return { status: 'skipped', at: nowISO(), attempts: cur?.attempts || 0, error: 'smtp_not_configured' };
  }
  const claimed = await notificationStore.claimAction(deviceId, appointment.id, field);
  if (!claimed) {
    return CLAIM_LOST;
  }
  let attempts = cur?.attempts || 0;
  try {
    const { subject, body } = buildEmailPayload({ patient, appointment, kind });
    const info = await sendMail({ to: patient.email, subject, body });
    return { status: 'sent', at: nowISO(), attempts: 0, messageId: info.messageId || null, error: null, nextRetryAt: null, gaveUp: false };
  } catch (e) {
    attempts++;
    const failed = { status: 'failed', at: nowISO(), attempts, error: e.message };
    if (attempts >= MAX_EMAIL_ATTEMPTS) {
      failed.gaveUp = true;
      failed.nextRetryAt = null;
    } else {
      failed.gaveUp = false;
      failed.nextRetryAt = retryAfter(attempts, EMAIL_BACKOFF_MIN);
    }
    console.error(`[scheduler] email fail device=${deviceId} appt=${appointment.id} kind=${kind} err=${e.message}`);
    return failed;
  }
}

async function tryPush(field, kind, cur, ctx) {
  const { deviceId, device, patient, appointment } = ctx;
  if (!device.pushToken) {
    return { status: 'skipped', at: nowISO(), attempts: 0, error: 'NO_TOKEN' };
  }
  const claimed = await notificationStore.claimAction(deviceId, appointment.id, field);
  if (!claimed) {
    return CLAIM_LOST;
  }
  const res = await pushService.sendPush({
    token: device.pushToken,
    ...buildPushPayload({ patient, appointment, kind }),
  });
  if (res.ok) {
    return { status: 'sent', at: nowISO(), attempts: 0, error: null, nextRetryAt: null, gaveUp: false };
  }
  const attempts = (cur?.attempts || 0) + 1;
  const failed = { status: 'failed', at: nowISO(), attempts, error: res.error || 'UNKNOWN' };
  if (attempts >= MAX_PUSH_ATTEMPTS) {
    failed.gaveUp = true;
    failed.nextRetryAt = null;
  } else {
    failed.gaveUp = false;
    failed.nextRetryAt = retryAfter(attempts, PUSH_BACKOFF_MIN);
  }
  console.error(`[scheduler] push fail device=${deviceId} appt=${appointment.id} kind=${kind} err=${failed.error}`);
  return failed;
}

async function processAppointment(deviceId, patient, appointment, device) {
  if (!appointment || appointment.status !== 'pending') return;
  if (!patient?.email && !device?.pushToken) return;

  const apptTime = buildApptDateTime(appointment);
  if (!apptTime) return;
  const now = new Date();
  if (apptTime.getTime() <= now.getTime()) return;

  const hoursUntilAppt = (apptTime.getTime() - now.getTime()) / (60 * 60 * 1000);
  const minutesUntilAppt = (apptTime.getTime() - now.getTime()) / (60 * 1000);

  const oneDayBefore = dayBefore9am(appointment);
  const in1dWindow = !!(
    oneDayBefore
    && now.getTime() >= oneDayBefore.getTime()
    && hoursUntilAppt >= MIN_HOURS_FOR_1D_REMINDER
  );
  const oneHourBefore = new Date(apptTime.getTime() - 60 * 60 * 1000);
  const in1hWindow = now.getTime() >= oneHourBefore.getTime() && minutesUntilAppt >= MIN_MINUTES_FOR_1H_REMINDER;

  const ctx = { deviceId, device, patient, appointment };
  const stored = (await notificationStore.getState(deviceId, appointment.id)) || {};

  const decide = async (field, kind, existing, inWindow, sendFn) => {
    if (!inWindow) return existing || null;
    if (!shouldSend(existing)) return existing || null;
    return sendFn(field, kind, existing, ctx);
  };

  const results = {
    push1d: await decide('push1d', '1d', stored.push1d, in1dWindow, tryPush),
    push1h: await decide('push1h', '1h', stored.push1h, in1hWindow, tryPush),
    email1d: await decide('email1d', '1d', stored.email1d, in1dWindow, tryEmail),
    email1h: await decide('email1h', '1h', stored.email1h, in1hWindow, tryEmail),
  };

  const patch = { patientId: patient.id };
  for (const [k, v] of Object.entries(results)) {
    if (v !== CLAIM_LOST) patch[k] = v ?? null;
  }
  await notificationStore.setState(deviceId, appointment.id, patch);

  console.log(
    `[scheduler] appt device=${deviceId} appt=${appointment.id} hoursUntil=${hoursUntilAppt.toFixed(1)} p1d=${results.push1d?.status || '-'} p1h=${results.push1h?.status || '-'} e1d=${results.email1d?.status || '-'} e1h=${results.email1h?.status || '-'}`
  );
}

async function tick() {
  if (running) return { skipped: 'already_running' };
  running = true;
  const startedAt = Date.now();
  let devicesProcessed = 0;
  let apptsProcessed = 0;
  try {
    const devices = await deviceStore.listAllDevices();
    for (const device of devices) {
      devicesProcessed++;
      const snap = await syncStore.get(device.deviceId);
      if (!snap) continue;
      const patients = Array.isArray(snap.data?.patients) ? snap.data.patients : [];
      for (const patient of patients) {
        const appts = Array.isArray(patient.appointments) ? patient.appointments : [];
        for (const appt of appts) {
          await processAppointment(device.deviceId, patient, appt, device);
          apptsProcessed++;
        }
      }
    }
    lastTickAt = Date.now();
    const ms = lastTickAt - startedAt;
    console.log(`[scheduler] tick devices=${devicesProcessed} appts=${apptsProcessed} in ${ms}ms`);
    return { devices: devicesProcessed, appts: apptsProcessed, ms };
  } catch (e) {
    console.error('[scheduler] tick FAIL:', e?.message);
    return { error: e.message };
  } finally {
    running = false;
  }
}

function start() {
  if (intervalHandle) return;
  console.log(`[scheduler] starting (tick=${TICK_MS}ms)`);
  setTimeout(() => {
    tick().catch((e) => console.error('[scheduler] initial tick FAIL:', e?.message));
  }, 5000);
  intervalHandle = setInterval(() => {
    tick().catch((e) => console.error('[scheduler] interval tick FAIL:', e?.message));
  }, TICK_MS);
}

function stop() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}

function getStatus() {
  return {
    running: !!intervalHandle,
    tickMs: TICK_MS,
    lastTickAt,
    inFlight: running,
    apptTimezone: APPT_TIMEZONE,
  };
}

module.exports = { start, stop, tick, getStatus };
