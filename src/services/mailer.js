const nodemailer = require('nodemailer');
const { loadConfig } = require('./smtpStore');

let transport = null;
let lastConfigSig = null;

function getTransport() {
  const cfg = loadConfig();
  if (!cfg) return null;
  const sig = `${cfg.host}|${cfg.port}|${cfg.user}|${cfg.secure}`;
  if (transport && lastConfigSig === sig) return transport;
  try {
    transport = nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: !!cfg.secure,
      auth: { user: cfg.user, pass: cfg.pass },
      connectionTimeout: 10000,
      socketTimeout: 15000,
    });
    lastConfigSig = sig;
    return transport;
  } catch (e) {
    console.error('[mailer] createTransport error:', e.message);
    transport = null;
    return null;
  }
}

function resetTransport() {
  transport = null;
  lastConfigSig = null;
}

function isAuthError(err) {
  const msg = String(err?.message || err || '').toLowerCase();
  return msg.includes('invalid login') || msg.includes('authentication') || msg.includes('auth') || msg.includes('535') || msg.includes('credential');
}

async function sendMail({ to, subject, body, fromOverride }) {
  const cfg = loadConfig();
  if (!cfg) {
    const e = new Error('SMTP no configurado');
    e.code = 'NO_SMTP_CONFIGURED';
    throw e;
  }
  const transport = getTransport();
  if (!transport) {
    const e = new Error('No se pudo inicializar SMTP');
    e.code = 'SMTP_INIT_ERROR';
    throw e;
  }
  const from = fromOverride || `"${cfg.fromName}" <${cfg.fromEmail}>`;
  try {
    const info = await transport.sendMail({
      from,
      to,
      subject,
      text: body,
    });
    return { messageId: info.messageId };
  } catch (e) {
    if (isAuthError(e)) {
      e.code = 'SMTP_AUTH';
    } else {
      e.code = e.code || 'SMTP_ERROR';
    }
    throw e;
  }
}

module.exports = { sendMail, resetTransport };
