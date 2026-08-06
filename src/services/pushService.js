const ExpoModule = require('expo-server-sdk');
const Expo = ExpoModule.Expo || ExpoModule.default || ExpoModule;

let expo = null;

function getClient() {
  if (!expo) expo = new Expo();
  return expo;
}

const PUSH_TOKEN_RE = /^(Exponent|Expo)PushToken\[[A-Za-z0-9_\-]+\]$/;

function isValidToken(token) {
  if (typeof token !== 'string') return false;
  return PUSH_TOKEN_RE.test(token);
}

async function sendPush({ token, title, body, data = {}, sound = 'default', channelId }) {
  if (!token) {
    return { ok: false, error: 'NO_TOKEN' };
  }
  if (!isValidToken(token)) {
    return { ok: false, error: 'INVALID_TOKEN' };
  }
  const client = getClient();
  const message = {
    to: token,
    sound,
    title: title || '',
    body: body || '',
    data,
    ...(channelId ? { channelId } : {}),
  };
  try {
    const ticketChunk = await client.sendPushNotificationsAsync([message]);
    const ticket = ticketChunk[0];
    if (!ticket) {
      return { ok: false, error: 'NO_TICKET' };
    }
    if (ticket.status === 'ok') {
      return { ok: true, ticketId: ticket.id };
    }
    if (ticket.status === 'error') {
      const errCode = ticket.details?.error || 'UNKNOWN';
      console.warn(`[push] ticket error token=${token.slice(0, 20)}... code=${errCode} msg=${ticket.message || ''}`);
      return { ok: false, error: errCode, message: ticket.message || '' };
    }
    return { ok: false, error: 'UNKNOWN_TICKET_STATUS' };
  } catch (e) {
    console.error(`[push] sendPush FAIL token=${token.slice(0, 20)}... msg=${e?.message}`);
    return { ok: false, error: 'EXCEPTION', message: e?.message };
  }
}

async function sendPushBatch(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return { sent: 0, failed: 0, results: [] };
  const client = getClient();
  const valid = messages.filter((m) => m && m.token && isValidToken(m.token));
  const chunks = client.chunkPushNotifications(
    valid.map((m) => ({
      to: m.token,
      sound: m.sound || 'default',
      title: m.title || '',
      body: m.body || '',
      data: m.data || {},
      ...(m.channelId ? { channelId: m.channelId } : {}),
    }))
  );
  let sent = 0;
  let failed = 0;
  const results = [];
  for (const chunk of chunks) {
    try {
      const tickets = await client.sendPushNotificationsAsync(chunk);
      tickets.forEach((t, i) => {
        if (t.status === 'ok') {
          sent++;
          results.push({ ok: true, token: chunk[i].to, ticketId: t.id });
        } else {
          failed++;
          const errCode = t.details?.error || 'UNKNOWN';
          results.push({ ok: false, token: chunk[i].to, error: errCode, message: t.message || '' });
          if (errCode === 'DeviceNotRegistered') {
            console.warn(`[push] DeviceNotRegistered: ${chunk[i].to.slice(0, 20)}... will cleanup`);
          }
        }
      });
    } catch (e) {
      console.error('[push] chunk error:', e?.message);
      chunk.forEach((m) => results.push({ ok: false, token: m.to, error: 'EXCEPTION', message: e?.message }));
      failed += chunk.length;
    }
  }
  return { sent, failed, results };
}

module.exports = { sendPush, sendPushBatch, isValidToken };
