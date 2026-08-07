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

function pad2(n) {
  return String(n).padStart(2, '0');
}

function buildApptDateTime(appointment) {
  if (!appointment?.date) return null;
  const date = String(appointment.date);
  const time = String(appointment.time || '09:00');
  const m = time.match(/^(\d{1,2}):(\d{2})/);
  const hh = m ? Number(m[1]) : 9;
  const mm = m ? Number(m[2]) : 0;
  const iso = `${date}T${pad2(hh)}:${pad2(mm)}:00`;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}

function dayBefore9am(appointment) {
  if (!appointment?.date) return null;
  const d = new Date(String(appointment.date) + 'T00:00:00');
  if (isNaN(d.getTime())) return null;
  d.setDate(d.getDate() - 1);
  d.setHours(9, 0, 0, 0);
  return d;
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
  };
}

module.exports = { start, stop, tick, getStatus };
