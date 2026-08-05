const express = require('express');
const { sendMail, resetTransport } = require('../services/mailer');
const { saveConfig, getPublicConfig, loadConfig } = require('../services/smtpStore');
const { rateLimit, idempotencyStore } = require('../middleware/limiters');
const requireAuth = require('../middleware/auth');

const router = express.Router();

router.get('/status', requireAuth, (req, res) => {
  const pub = getPublicConfig();
  if (!pub) return res.json({ configured: false });
  return res.json({ configured: true, fromEmail: pub.fromEmail, fromName: pub.fromName, host: pub.host, port: pub.port, secure: pub.secure, user: pub.user, updatedAt: pub.updatedAt });
});

router.post('/config', requireAuth, rateLimit({ max: 10 }), (req, res) => {
  try {
    const cfg = req.body?.config;
    if (!cfg || typeof cfg !== 'object') return res.status(400).json({ error: 'INVALID_BODY', message: 'Falta config.' });
    const saved = saveConfig(cfg);
    resetTransport();
    return res.json({ ok: true, fromEmail: saved.fromEmail, fromName: saved.fromName });
  } catch (e) {
    if (String(e.message).toLowerCase().includes('requerido')) {
      return res.status(400).json({ error: 'VALIDATION', message: e.message });
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
    console.log(`[mock-mail] test to=${testEmail}`);
    return res.json({ ok: true, mock: true });
  }
  try {
    const info = await sendMail({ to: testEmail, subject: 'Prueba de ControlPeso', body: 'Este es un correo de prueba del sistema ControlPeso. Si lo recibes, la configuración SMTP es correcta.' });
    return res.json({ ok: true, messageId: info.messageId });
  } catch (e) {
    if (e.code === 'NO_SMTP_CONFIGURED') {
      return res.status(409).json({ error: 'NO_SMTP_CONFIGURED', message: 'Configura SMTP antes de probar.' });
    }
    if (e.code === 'SMTP_AUTH') {
      return res.status(400).json({ error: 'SMTP_AUTH', message: 'Credenciales inválidas. Verifica usuario y contraseña (App Password si usas Gmail con 2FA).' });
    }
    return res.status(500).json({ error: 'SMTP_ERROR', message: e.message || 'Falló el envío.' });
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
    console.log(`[mock-mail] to=${to} subject="${subject}" body_len=${body.length}`);
    return res.json({ ok: true, mock: true });
  }

  const cfg = loadConfig();
  if (!cfg) {
    return res.status(409).json({ error: 'NO_SMTP_CONFIGURED', message: 'SMTP no configurado en el servidor.' });
  }

  try {
    const info = await sendMail({ to, subject, body });
    return res.json({ ok: true, messageId: info.messageId });
  } catch (e) {
    if (e.code === 'SMTP_AUTH') {
      return res.status(400).json({ error: 'SMTP_AUTH', message: 'Credenciales SMTP inválidas.' });
    }
    return res.status(500).json({ error: 'SMTP_ERROR', message: e.message || 'No se pudo enviar el correo.' });
  }
});

module.exports = router;
