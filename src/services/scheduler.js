const syncStore = require('./syncStore');
const deviceStore = require('./deviceStore');
const pushService = require('./pushService');
const { sendMail } = require('./mailer');
const { loadConfig } = require('./smtpStore');

let intervalHandle = null;
let running = false;
let lastTickAt = 0;

const TICK_MS = Number(process.env.SCHEDULER_TICK_MS) || 60000;

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

async function updateApptInSnapshot(deviceId, patientId, appointmentId, patch) {
  const snap = await syncStore.get(deviceId);
  if (!snap) return false;
  const patients = Array.isArray(snap.data?.patients) ? snap.data.patients : [];
  let changed = false;
  for (const p of patients) {
    if (p.id !== patientId) continue;
    const appts = Array.isArray(p.appointments) ? p.appointments : [];
    for (const a of appts) {
      if (a.id !== appointmentId) continue;
      Object.assign(a, patch);
      changed = true;
      break;
    }
    if (changed) break;
  }
  if (!changed) return false;
  await syncStore.set(deviceId, { data: { patients }, ts: new Date().toISOString() });
  return true;
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

function buildEmailPayload({ patient, appointment }) {
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
  const subject = `Recordatorio de cita - ${dateLabel}`;
  const body = `Hola ${patient?.name || ''},

Te recordamos tu cita programada.

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

async function processAppointment(deviceId, patient, appointment, device) {
  if (!appointment || appointment.status !== 'pending') return;
  if (!patient?.email && !device?.pushToken) return;

  const apptTime = buildApptDateTime(appointment);
  if (!apptTime) return;
  const now = new Date();

  if (apptTime.getTime() <= now.getTime()) {
    return;
  }

  const hoursUntilAppt = (apptTime.getTime() - now.getTime()) / (60 * 60 * 1000);
  const minutesUntilAppt = (apptTime.getTime() - now.getTime()) / (60 * 1000);

  const oneDayBefore = dayBefore9am(appointment);
  if (
    oneDayBefore
    && now.getTime() >= oneDayBefore.getTime()
    && hoursUntilAppt >= MIN_HOURS_FOR_1D_REMINDER
    && !appointment.notified1dAt
  ) {
    let emailResult = null;
    if (patient.email && process.env.MOCK_MAIL !== 'true' && loadConfig()) {
      try {
        const { subject, body } = buildEmailPayload({ patient, appointment });
        const info = await sendMail({ to: patient.email, subject, body });
        emailResult = { ok: true, messageId: info.messageId };
      } catch (e) {
        emailResult = { ok: false, error: e.message };
        console.error(`[scheduler] email fail device=${deviceId} appt=${appointment.id} err=${e.message}`);
      }
    }
    const pushResult = device.pushToken
      ? await pushService.sendPush({
          token: device.pushToken,
          ...buildPushPayload({ patient, appointment, kind: '1d' }),
        })
      : { ok: false, error: 'NO_TOKEN' };
    const patch = {
      notified1dAt: new Date().toISOString(),
    };
    if (emailResult) {
      if (emailResult.ok) {
        patch.emailStatus = 'sent';
        patch.emailSentAt = new Date().toISOString();
        patch.emailMessageId = emailResult.messageId || null;
        patch.emailLastError = null;
      } else {
        patch.emailStatus = 'failed';
        patch.emailLastError = emailResult.error;
      }
    }
    await updateApptInSnapshot(deviceId, patient.id, appointment.id, patch);
    console.log(
      `[scheduler] 1d device=${deviceId} appt=${appointment.id} hoursUntil=${hoursUntilAppt.toFixed(1)} email=${emailResult ? (emailResult.ok ? 'sent' : 'fail') : 'skip'} push=${pushResult.ok ? 'ok' : pushResult.error}`
    );
  }

  const oneHourBefore = new Date(apptTime.getTime() - 60 * 60 * 1000);
  if (
    now.getTime() >= oneHourBefore.getTime()
    && minutesUntilAppt >= MIN_MINUTES_FOR_1H_REMINDER
    && !appointment.notified1hAt
  ) {
    const pushResult = device.pushToken
      ? await pushService.sendPush({
          token: device.pushToken,
          ...buildPushPayload({ patient, appointment, kind: '1h' }),
        })
      : { ok: false, error: 'NO_TOKEN' };
    await updateApptInSnapshot(deviceId, patient.id, appointment.id, {
      notified1hAt: new Date().toISOString(),
    });
    console.log(
      `[scheduler] 1h device=${deviceId} appt=${appointment.id} minutesUntil=${minutesUntilAppt.toFixed(1)} push=${pushResult.ok ? 'ok' : pushResult.error}`
    );
  }
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
