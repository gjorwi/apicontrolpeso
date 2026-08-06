const { Resend } = require('resend');
const { loadConfig } = require('./smtpStore');

let resend = null;

function getClient() {
  const key = process.env.RESEND_API_KEY;
  if (!key) return null;
  if (!resend) resend = new Resend(key);
  return resend;
}

function getDefaultFrom() {
  return process.env.RESEND_DEFAULT_FROM || '';
}

async function sendMail({ to, subject, body, fromOverride }) {
  const cfg = loadConfig();
  if (!cfg) {
    const e = new Error('Remitente no configurado');
    e.code = 'NO_SENDER_CONFIGURED';
    throw e;
  }
  const client = getClient();
  if (!client) {
    const e = new Error('El servidor no tiene RESEND_API_KEY configurada');
    e.code = 'NO_RESEND_KEY';
    throw e;
  }

  const senderEmail = fromOverride || cfg.fromEmail || getDefaultFrom();
  if (!senderEmail) {
    const e = new Error('Falta fromEmail (configura en la app o RESEND_DEFAULT_FROM en el servidor)');
    e.code = 'NO_FROM_ADDRESS';
    throw e;
  }
  const fromName = cfg.fromName || 'ControlPeso';
  const from = `"${fromName}" <${senderEmail}>`;
  console.log(`[mailer] sending from="${from}" to=${to} subject="${subject}"`);

  if (process.env.MOCK_MAIL === 'true') {
    console.log(`[mock-mail][resend] to=${to} subject="${subject}" body_len=${body?.length || 0}`);
    return { messageId: 'mock-' + Date.now() };
  }

  try {
    const result = await client.emails.send({
      from,
      to,
      subject,
      text: body,
    });
    if (result?.error) {
      const e = new Error(result.error.message || 'Resend rechazó el envío');
      e.code = classifyResendError(result.error);
      console.error(`[mailer] resend error to=${to} status=${result.error.statusCode} name=${result.error.name} msg=${result.error.message}`);
      throw e;
    }
    console.log(`[mailer] sent via resend to=${to} id=${result?.data?.id}`);
    return { messageId: result?.data?.id };
  } catch (e) {
    if (!e.code) e.code = 'SEND_ERROR';
    console.error(`[mailer] sendMail FAIL to=${to} code=${e.code} msg=${e.message}`);
    throw e;
  }
}

function classifyResendError(err) {
  const name = String(err?.name || '').toLowerCase();
  const msg = String(err?.message || '').toLowerCase();
  const status = err?.statusCode;
  if (name.includes('validation') || status === 422) return 'RESEND_VALIDATION';
  if (msg.includes('api key') || status === 401 || status === 403) return 'RESEND_AUTH';
  if (msg.includes('domain') || msg.includes('from address') || msg.includes('not verified')) return 'RESEND_FROM_NOT_VERIFIED';
  if (status === 429) return 'RESEND_RATE_LIMIT';
  if (status >= 500) return 'RESEND_UPSTREAM';
  return 'RESEND_ERROR';
}

function resetTransport() {
  resend = null;
}

module.exports = { sendMail, resetTransport };
