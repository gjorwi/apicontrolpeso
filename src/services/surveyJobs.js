// Trabajos del reporte/encuesta: envío automático (L/M/V), digest de
// pendientes con push al médico, envío manual y cálculo de estados.
const crypto = require('crypto');
const syncStore = require('./syncStore');
const deviceStore = require('./deviceStore');
const surveyStore = require('./surveyStore');
const { sendMail, getEffectiveSender } = require('./mailer');
const { sendPushBatch } = require('./pushService');
const { buildSurveyEmail, EMAIL_RE } = require('./surveyEmail');
const { wallDateStr, wallTimeOfDay, wallWeekday, minutesOf } = require('./wallTime');

const MAX_PUSH_BODY = 300;

function surveyBaseUrl() {
  return String(process.env.SURVEY_BASE_URL || '').trim().replace(/\/+$/, '');
}

function buildLink(token) {
  const base = surveyBaseUrl();
  return base ? `${base}/responder?t=${token}` : '';
}

function firstNameOf(name) {
  const n = String(name || '').trim();
  return n ? n.split(/\s+/)[0] : '';
}

// Pacientes vivos de todos los snapshots (o de un deviceId), deduplicados por
// id conservando la versión más reciente (updatedAt mayor).
async function listAllPatients(deviceId) {
  const snaps = await syncStore.getAll();
  const byId = new Map();
  for (const snap of snaps) {
    if (deviceId && snap.deviceId !== deviceId) continue;
    const patients = Array.isArray(snap.data?.patients) ? snap.data.patients : [];
    for (const p of patients) {
      if (!p || !p.id || p.deletedAt) continue;
      const prev = byId.get(p.id);
      if (!prev || String(p.updatedAt || '') >= String(prev.patient.updatedAt || '')) {
        byId.set(p.id, { patient: p, deviceId: snap.deviceId });
      }
    }
  }
  return Array.from(byId.values());
}

async function findPatient(patientId, deviceId) {
  const all = await listAllPatients(deviceId);
  const found = all.find((x) => x.patient.id === patientId);
  if (found) return found;
  // Si el snapshot del dispositivo no lo tiene, se busca en los demás.
  if (deviceId) return listAllPatients().then((xs) => xs.find((x) => x.patient.id === patientId) || null);
  return null;
}

// --------------------------------------------------------------- envíos

// Crea (o reutiliza) el invite del paciente para `date` y envía el correo.
// Devuelve { ok, reason?, messageId?, mock? }.
async function sendSurveyToPatient({ patient, deviceId, date, source = 'manual', cfg }) {
  const config = cfg || (await surveyStore.getConfig());
  const email = String(patient?.email || '').trim();
  if (!EMAIL_RE.test(email)) return { ok: false, reason: 'no_email' };
  if (!surveyBaseUrl()) {
    console.warn('[survey] SURVEY_BASE_URL no configurada; no se puede armar el link.');
    return { ok: false, reason: 'no_url' };
  }

  const nowIso = new Date().toISOString();
  const ttlHours = Number(config.ttlHours) || 72;
  const expiresAt = new Date(Date.now() + ttlHours * 3600000).toISOString();

  let invite = await surveyStore.getInvite(patient.id, date);
  if (!invite) {
    invite = await surveyStore.createInvite({
      token: crypto.randomBytes(24).toString('hex'),
      patientId: patient.id,
      patientName: String(patient.name || ''),
      deviceId: deviceId || '',
      date,
      email,
      status: 'pending',
      source,
      questionVersion: Number(config.version) || 1,
      expiresAt,
      messageId: '',
      error: '',
      sentAt: '',
      resentAt: '',
      openedAt: '',
      completedAt: '',
      responseId: '',
    });
  }

  if (invite.status === 'completed') return { ok: false, reason: 'already_completed', invite };
  if ((invite.status === 'sent' || invite.status === 'opened') && source === 'auto') {
    return { ok: false, reason: 'already_sent', invite };
  }

  const resend = invite.status === 'sent' || invite.status === 'opened' || !!invite.sentAt;
  const patchBase = { expiresAt, email };

  // Mock local: se registra como enviado para poder probar el flujo completo.
  if (process.env.MOCK_MAIL === 'true') {
    const messageId = 'mock-' + Date.now();
    await surveyStore.markInvite(invite.token, {
      ...patchBase,
      status: 'sent',
      messageId,
      error: '',
      sentAt: invite.sentAt || nowIso,
      resentAt: resend ? nowIso : (invite.resentAt || ''),
    });
    console.log(`[mock-mail][survey] to=${email} date=${date} token=${invite.token.slice(0, 8)}…`);
    return { ok: true, mock: true, messageId, invite };
  }

  if (!getEffectiveSender()) {
    await surveyStore.markInvite(invite.token, { ...patchBase, status: 'skipped', error: 'smtp_not_configured' });
    return { ok: false, reason: 'smtp_not_configured', invite };
  }

  try {
    const { subject, body, html } = buildSurveyEmail({
      patient,
      url: buildLink(invite.token),
      date,
      signature: config.signature || 'Doctora Flor',
      expiresAt,
    });
    const info = await sendMail({ to: email, subject, body, html });
    await surveyStore.markInvite(invite.token, {
      ...patchBase,
      status: 'sent',
      messageId: info.messageId || '',
      error: '',
      sentAt: invite.sentAt || nowIso,
      resentAt: resend ? nowIso : (invite.resentAt || ''),
      source: invite.source === 'manual' || source === 'manual' ? 'manual' : invite.source,
    });
    console.log(`[survey] email sent to=${email} date=${date} source=${source} id=${info.messageId}`);
    return { ok: true, messageId: info.messageId, invite };
  } catch (e) {
    await surveyStore.markInvite(invite.token, { ...patchBase, status: 'failed', error: String(e.message || e).slice(0, 200) });
    console.error(`[survey] email FAIL to=${email} date=${date} code=${e.code} msg=${e.message}`);
    return { ok: false, reason: 'send_failed', error: e.message, invite };
  }
}

// ------------------------------------------------- envío automático del día

async function dispatchDay(date, cfg) {
  const patients = await listAllPatients();
  const result = { total: patients.length, sent: 0, skipped: 0, failed: 0, noEmail: 0, already: 0 };
  for (const { patient, deviceId } of patients) {
    try {
      const r = await sendSurveyToPatient({ patient, deviceId, date, source: 'auto', cfg });
      if (r.ok) result.sent++;
      else if (r.reason === 'no_email') result.noEmail++;
      else if (r.reason === 'already_sent' || r.reason === 'already_completed') result.already++;
      else if (r.reason === 'send_failed') result.failed++;
      else result.skipped++;
    } catch (e) {
      result.failed++;
      console.error(`[survey] dispatch error patient=${patient.id}:`, e.message);
    }
  }
  console.log(`[survey] dispatch ${date} sent=${result.sent} already=${result.already} noEmail=${result.noEmail} failed=${result.failed} skipped=${result.skipped}`);
  return result;
}

// ------------------------------------------------------ digest de pendientes

function statusFor(patient, date, invite, response) {
  if (response) return 'completed';
  const email = String(patient.email || '').trim();
  if (!invite) return EMAIL_RE.test(email) ? 'not_sent' : 'no_email';
  if (invite.status === 'completed') return 'completed';
  if (invite.status === 'failed') return 'failed';
  if (invite.status === 'skipped') return 'smtp_not_configured';
  if (!EMAIL_RE.test(email)) return 'no_email';
  return 'sent'; // sent | opened | pending
}

// Estado de todos los pacientes para una fecha (+ último reporte conocido).
async function getOverview({ date, deviceId } = {}) {
  const finalDate = date || wallDateStr(new Date());
  const [patients, invites, responses, recent] = await Promise.all([
    listAllPatients(deviceId),
    surveyStore.listInvites({ date: finalDate, limit: 2000 }),
    surveyStore.listResponses({ date: finalDate, limit: 2000 }),
    surveyStore.listResponses({ limit: 500 }),
  ]);

  const inviteByPatient = new Map(invites.map((i) => [i.patientId, i]));
  const responseByPatient = new Map(responses.map((r) => [r.patientId, r]));

  const latestByPatient = new Map();
  for (const r of recent) {
    const prev = latestByPatient.get(r.patientId);
    if (!prev || String(r.createdAt || '') > String(prev.createdAt || '')) {
      latestByPatient.set(r.patientId, r);
    }
  }

  const items = patients.map(({ patient, deviceId: dev }) => {
    const invite = inviteByPatient.get(patient.id) || null;
    const response = responseByPatient.get(patient.id) || null;
    const last = latestByPatient.get(patient.id) || null;
    return {
      patientId: patient.id,
      name: patient.name || '(sin nombre)',
      email: String(patient.email || '').trim(),
      deviceId: dev,
      status: statusFor(patient, finalDate, invite, response),
      sentAt: invite?.sentAt || null,
      resentAt: invite?.resentAt || null,
      source: invite?.source || null,
      completedAt: response?.createdAt || invite?.completedAt || null,
      lastResponse: last
        ? {
            id: last.responseId,
            date: last.date,
            createdAt: last.createdAt,
            aiStatus: last.aiStatus,
            nivel: last.ai?.nivel || null,
            alerta: !!last.ai?.alerta,
            motivo: last.ai?.motivo || null,
            accion: last.ai?.accion || null,
          }
        : null,
    };
  });

  items.sort((a, b) => a.name.localeCompare(b.name, 'es'));

  const counts = { completed: 0, sent: 0, not_sent: 0, no_email: 0, failed: 0, smtp_not_configured: 0, alerts: 0 };
  for (const it of items) {
    counts[it.status] = (counts[it.status] || 0) + 1;
    if (it.lastResponse?.alerta) counts.alerts++;
  }

  return { date: finalDate, items, counts };
}

async function computePending(date, deviceId) {
  const overview = await getOverview({ date, deviceId });
  const items = overview.items.filter((i) => i.status !== 'completed');
  return { date: overview.date, items, counts: overview.counts, total: overview.items.length };
}

async function runDigest(date) {
  const claimed = await surveyStore.claimDispatch(date, 'digest');
  if (!claimed) return { skipped: 'claimed' };

  const pending = await computePending(date);
  let pushed = 0;
  if (pending.items.length) {
    const devices = (await deviceStore.listAllDevices()).filter((d) => d.pushToken);
    if (devices.length) {
      const names = pending.items.slice(0, 8).map((i) => i.name);
      let body = `${pending.items.length} de ${pending.total || pending.items.length} paciente(s) sin reporte hoy: ${names.join(', ')}`;
      if (pending.items.length > 8) body += ` y ${pending.items.length - 8} más`;
      const res = await sendPushBatch(
        devices.map((d) => ({
          token: d.pushToken,
          title: 'Reportes de seguimiento pendientes',
          body: body.slice(0, MAX_PUSH_BODY),
          data: { type: 'survey_pending', date, count: pending.items.length },
        }))
      );
      pushed = res?.sent || 0;
    }
  }

  await surveyStore.setDispatchSummary(date, 'digest', {
    pending: pending.items.length,
    total: pending.total,
    pushed,
    at: new Date().toISOString(),
  });
  console.log(`[survey] digest ${date} pending=${pending.items.length} pushed=${pushed}`);
  return { pending: pending.items.length, pushed };
}

// ------------------------------------------------------------ job del tick

async function run(now = new Date()) {
  const cfg = await surveyStore.getConfig();
  if (cfg.enabled === false) return { skipped: 'disabled' };

  const date = wallDateStr(now);
  const dow = wallWeekday(now);
  const out = { date };
  if (!Array.isArray(cfg.days) || !cfg.days.includes(dow)) {
    out.skipped = 'not_scheduled_day';
    return out;
  }

  const mins = minutesOf(wallTimeOfDay(now));
  const sendFrom = minutesOf(cfg.time || '09:00');
  const sendUntil = minutesOf(cfg.lateUntil || '21:00');
  if (mins >= sendFrom && mins < sendUntil) {
    out.send = await dispatchDay(date, cfg);
  }

  const digestAt = minutesOf(cfg.digestTime || '18:00');
  if (mins >= digestAt) {
    out.digest = await runDigest(date);
  }
  return out;
}

// ------------------------------------------------------------- reportes

async function getPatientReport(patientId, deviceId) {
  const found = await findPatient(patientId, deviceId);
  const [invites, responses] = await Promise.all([
    surveyStore.listInvites({ patientId, limit: 100 }),
    surveyStore.listResponses({ patientId, limit: 100 }),
  ]);
  invites.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  responses.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  return {
    patient: found
      ? { id: found.patient.id, name: found.patient.name || '', email: found.patient.email || '', deviceId: found.deviceId }
      : { id: patientId, name: '', email: '', deviceId: deviceId || '' },
    invites,
    responses,
  };
}

// Envío manual desde la app del médico (hoy por defecto).
async function manualSend({ patientId, deviceId, date }) {
  const finalDate = date || wallDateStr(new Date());
  const found = await findPatient(patientId, deviceId);
  if (!found) return { ok: false, reason: 'no_patient' };
  const result = await sendSurveyToPatient({
    patient: found.patient,
    deviceId: found.deviceId,
    date: finalDate,
    source: 'manual',
  });
  return { ...result, date: finalDate, patientId };
}

module.exports = {
  run,
  listAllPatients,
  findPatient,
  sendSurveyToPatient,
  getOverview,
  computePending,
  getPatientReport,
  manualSend,
  buildLink,
  statusFor,
};
