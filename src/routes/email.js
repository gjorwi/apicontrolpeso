const express = require('express');
const { sendMail, resetTransport } = require('../services/mailer');
const { saveConfig, getPublicConfig, loadConfig } = require('../services/smtpStore');
const { rateLimit, idempotencyStore } = require('../middleware/limiters');
const requireAuth = require('../middleware/auth');
const syncStore = require('../services/syncStore');
const notificationStore = require('../services/notificationStore');

const router = express.Router();

function buildAppointmentEmail(appointment, patient, kind = '1d') {
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

router.get('/status', requireAuth, (req, res) => {
  const pub = getPublicConfig();
  if (!pub) return res.json({ configured: false, provider: 'resend' });
  return res.json({
    configured: true,
    provider: 'resend',
    fromEmail: pub.fromEmail,
    fromName: pub.fromName,
    updatedAt: pub.updatedAt,
  });
});

router.post('/config', requireAuth, rateLimit({ max: 10 }), (req, res) => {
  try {
    const input = req.body?.config || req.body || {};
    const saved = saveConfig({
      fromEmail: input.fromEmail,
      fromName: input.fromName,
    });
    resetTransport();
    return res.json({ ok: true, fromEmail: saved.fromEmail, fromName: saved.fromName });
  } catch (e) {
    console.error('[resend] saveConfig error:', e?.message || e);
    if (String(e.message || '').toLowerCase().includes('requerido') || String(e.message || '').includes('inválido')) {
      return res.status(400).json({ error: 'VALIDATION', message: e.message });
    }
    if (String(e.message || '').includes('ENCRYPTION_KEY')) {
      return res.status(500).json({ error: 'SERVER_MISCONFIG', message: 'Servidor sin ENCRYPTION_KEY. Revisar .env.' });
    }
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'No se pudo guardar la configuración.' });
  }
});

router.post('/test', requireAuth, rateLimit({ max: 5 }), async (req, res) => {
  const testEmail = (req.body?.testEmail || '').trim();
  if (!testEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(testEmail)) {
    return res.status(400).json({ error: 'INVALID_EMAIL', message: 'Email de prueba inválido.' });
  }
  if (process.env.MOCK_MAIL === 'true') {
    console.log(`[mock-mail][resend] test to=${testEmail}`);
    return res.json({ ok: true, mock: true });
  }
  if (!process.env.RESEND_API_KEY) {
    return res.status(500).json({
      error: 'NO_RESEND_KEY',
      message: 'Servidor sin RESEND_API_KEY. Configurala en Render → Environment.',
    });
  }
  try {
    const info = await sendMail({
      to: testEmail,
      subject: 'Prueba de ControlPeso',
      body: 'Este es un correo de prueba del sistema ControlPeso. Si lo recibes, la integración con Resend funciona correctamente.',
    });
    return res.json({ ok: true, messageId: info.messageId });
  } catch (e) {
    if (e.code === 'NO_SENDER_CONFIGURED') {
      return res.status(409).json({ error: 'NO_SENDER_CONFIGURED', message: 'Configura el remitente en la app antes de probar.' });
    }
    if (e.code === 'NO_RESEND_KEY') {
      return res.status(500).json({ error: 'NO_RESEND_KEY', message: 'Servidor sin RESEND_API_KEY.' });
    }
    if (e.code === 'RESEND_AUTH') {
      return res.status(500).json({ error: 'RESEND_AUTH', message: 'RESEND_API_KEY inválida o revocada.' });
    }
    if (e.code === 'RESEND_FROM_NOT_VERIFIED') {
      return res.status(400).json({
        error: 'RESEND_FROM_NOT_VERIFIED',
        message: 'El remitente no está verificado en Resend. Verificá el dominio o usá uno del sandbox onresend.dev.',
      });
    }
    if (e.code === 'RESEND_VALIDATION') {
      return res.status(400).json({ error: 'RESEND_VALIDATION', message: e.message });
    }
    if (e.code === 'RESEND_RATE_LIMIT') {
      return res.status(429).json({ error: 'RESEND_RATE_LIMIT', message: 'Límite de envío de Resend alcanzado. Reintentá más tarde.' });
    }
    return res.status(500).json({ error: 'SEND_ERROR', message: e.message || 'Falló el envío.' });
  }
});

router.post('/send-appointment-email', requireAuth, idempotencyStore(), rateLimit({ max: 60 }), async (req, res) => {
  const { to, subject, body } = req.body || {};
  if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
    return res.status(400).json({ error: 'INVALID_TO', message: 'Email destino inválido.' });
  }
  if (!subject || typeof subject !== 'string' || subject.length > 200) {
    return res.status(400).json({ error: 'INVALID_SUBJECT', message: 'Asunto requerido (máx 200 chars).' });
  }
  if (!body || typeof body !== 'string' || body.length > 10000) {
    return res.status(400).json({ error: 'INVALID_BODY', message: 'Cuerpo requerido (máx 10000 chars).' });
  }

  if (process.env.MOCK_MAIL === 'true') {
    console.log(`[mock-mail][resend] to=${to} subject="${subject}" body_len=${body.length}`);
    return res.json({ ok: true, mock: true });
  }

  if (!process.env.RESEND_API_KEY) {
    return res.status(500).json({ error: 'NO_RESEND_KEY', message: 'Servidor sin RESEND_API_KEY.' });
  }
  if (!loadConfig()) {
    return res.status(409).json({ error: 'NO_SENDER_CONFIGURED', message: 'Remitente no configurado en el servidor.' });
  }

  try {
    const info = await sendMail({ to, subject, body });
    return res.json({ ok: true, messageId: info.messageId });
  } catch (e) {
    if (e.code === 'RESEND_FROM_NOT_VERIFIED') {
      return res.status(400).json({ error: 'RESEND_FROM_NOT_VERIFIED', message: 'Remitente no verificado en Resend.' });
    }
    if (e.code === 'RESEND_RATE_LIMIT') {
      return res.status(429).json({ error: 'RESEND_RATE_LIMIT', message: 'Límite de Resend alcanzado.' });
    }
    return res.status(500).json({ error: 'SEND_ERROR', message: e.message || 'No se pudo enviar el correo.' });
  }
});

router.post('/retry-appointment-email', requireAuth, rateLimit({ max: 30 }), async (req, res) => {
  const { deviceId, patientId, appointmentId, kind } = req.body || {};
  const emailKind = kind === '1h' ? '1h' : '1d';
  if (!deviceId || !patientId || !appointmentId) {
    return res.status(400).json({ error: 'INVALID_BODY', message: 'Falta deviceId, patientId o appointmentId.' });
  }

  const snap = await syncStore.get(deviceId);
  if (!snap) {
    return res.status(404).json({ error: 'NO_SNAPSHOT', message: 'No hay datos sincronizados para este dispositivo.' });
  }
  const patients = Array.isArray(snap.data?.patients) ? snap.data.patients : [];
  const patient = patients.find((p) => p.id === patientId);
  if (!patient) {
    return res.status(404).json({ error: 'NO_PATIENT', message: 'Paciente no encontrado en el snapshot.' });
  }
  const appointment = (patient.appointments || []).find((a) => a.id === appointmentId);
  if (!appointment) {
    return res.status(404).json({ error: 'NO_APPOINTMENT', message: 'Cita no encontrada.' });
  }

  const field = emailKind === '1h' ? 'email1h' : 'email1d';
  const now = new Date().toISOString();
  const setState = (patch) =>
    notificationStore.setState(deviceId, appointmentId, { patientId, [field]: patch });

  if (!patient.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(patient.email)) {
    await setState({ status: 'no_email', at: now, attempts: 0, error: null });
    return res.status(409).json({ error: 'NO_PATIENT_EMAIL', message: 'El paciente no tiene email.' });
  }

  if (process.env.MOCK_MAIL === 'true') {
    const { subject } = buildAppointmentEmail(appointment, patient, emailKind);
    console.log(`[mock-mail][resend][retry] to=${patient.email} subject="${subject}"`);
    await setState({ status: 'sent', at: now, attempts: 0, messageId: 'mock-' + Date.now(), error: null, nextRetryAt: null });
    return res.json({ ok: true, mock: true, kind: emailKind, emailStatus: 'sent' });
  }

  if (!process.env.RESEND_API_KEY) {
    return res.status(500).json({ error: 'NO_RESEND_KEY', message: 'Servidor sin RESEND_API_KEY.' });
  }
  if (!loadConfig()) {
    return res.status(409).json({ error: 'NO_SENDER_CONFIGURED', message: 'Remitente no configurado en el servidor.' });
  }

  try {
    const { subject, body } = buildAppointmentEmail(appointment, patient, emailKind);
    const info = await sendMail({ to: patient.email, subject, body });
    await setState({ status: 'sent', at: now, attempts: 0, messageId: info.messageId || null, error: null, nextRetryAt: null });
    console.log(`[retry] email sent device=${deviceId} appt=${appointmentId} kind=${emailKind} to=${patient.email} id=${info.messageId}`);
    return res.json({ ok: true, kind: emailKind, emailStatus: 'sent', messageId: info.messageId });
  } catch (e) {
    await setState({ status: 'failed', at: now, attempts: 1, error: e.message || 'Error de envío', nextRetryAt: null });
    console.error(`[retry] email FAIL device=${deviceId} appt=${appointmentId} kind=${emailKind} code=${e.code} msg=${e.message}`);
    if (e.code === 'RESEND_FROM_NOT_VERIFIED') {
      return res.status(400).json({ error: 'RESEND_FROM_NOT_VERIFIED', message: 'Remitente no verificado en Resend.' });
    }
    if (e.code === 'RESEND_AUTH') {
      return res.status(500).json({ error: 'RESEND_AUTH', message: 'RESEND_API_KEY inválida.' });
    }
    if (e.code === 'RESEND_RATE_LIMIT') {
      return res.status(429).json({ error: 'RESEND_RATE_LIMIT', message: 'Límite de Resend alcanzado.' });
    }
    return res.status(500).json({ error: 'SEND_ERROR', message: e.message || 'No se pudo enviar el correo.' });
  }
});

module.exports = router;
