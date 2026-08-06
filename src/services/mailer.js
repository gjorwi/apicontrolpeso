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
  const senderEmail = fromOverride || cfg.fromEmail || cfg.user;
  const fromName = cfg.fromName || cfg.user;
  const from = `"${fromName}" <${senderEmail}>`;

  if (cfg.user && senderEmail && cfg.user.toLowerCase() !== senderEmail.toLowerCase()) {
    console.warn(`[mailer] from (${senderEmail}) != auth user (${cfg.user}). Esto suele activar filtros anti-spoofing.`);
  }

  const domain = String(senderEmail).split('@')[1] || '';
  const messageIdDomain = domain || 'localhost';

  const headers = {
    'Reply-To': senderEmail,
    'X-Priority': '3',
    'X-Mailer': 'ControlPeso/1.0',
    'List-Unsubscribe': `<mailto:${senderEmail}?subject=unsubscribe>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };

  try {
    const info = await transport.sendMail({
      from,
      to,
      subject,
      text: body,
      headers,
      envelope: { from: senderEmail, to },
      messageId: `<${Date.now()}.${Math.random().toString(36).slice(2)}@${messageIdDomain}>`,
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
