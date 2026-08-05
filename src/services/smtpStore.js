const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const AUTH_TAG_LEN = 16;
const DATA_FILE = path.join(__dirname, '..', '..', 'data', 'smtp.enc');

function getKey() {
  const hex = process.env.ENCRYPTION_KEY || '';
  if (!hex || hex.length !== 64) {
    throw new Error('ENCRYPTION_KEY must be 64 hex chars (32 bytes).');
  }
  return Buffer.from(hex, 'hex');
}

function ensureDir() {
  const dir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function encrypt(obj) {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const plaintext = Buffer.from(JSON.stringify(obj), 'utf8');
  const enc = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, enc]).toString('base64');
}

function decrypt(b64) {
  const key = getKey();
  const buf = Buffer.from(b64, 'base64');
  const iv = buf.subarray(0, IV_LEN);
  const authTag = buf.subarray(IV_LEN, IV_LEN + AUTH_TAG_LEN);
  const enc = buf.subarray(IV_LEN + AUTH_TAG_LEN);
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(authTag);
  const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
  return JSON.parse(dec.toString('utf8'));
}

let cache = null;

function loadConfig() {
  if (cache) return cache;
  try {
    if (!fs.existsSync(DATA_FILE)) return null;
    const b64 = fs.readFileSync(DATA_FILE, 'utf8');
    const cfg = decrypt(b64);
    cache = cfg;
    return cfg;
  } catch (e) {
    console.warn('[smtpStore] failed to load config:', e.message);
    return null;
  }
}

function saveConfig(cfg) {
  ensureDir();
  const sanitized = {
    host: String(cfg.host || '').trim(),
    port: Number(cfg.port) || 587,
    secure: !!cfg.secure,
    user: String(cfg.user || '').trim(),
    pass: String(cfg.pass || ''),
    fromName: String(cfg.fromName || 'ControlPeso').trim(),
    fromEmail: String(cfg.fromEmail || cfg.user || '').trim(),
    updatedAt: new Date().toISOString(),
  };
  if (!sanitized.host) throw new Error('host requerido');
  if (!sanitized.user) throw new Error('user requerido');
  if (!sanitized.pass) throw new Error('pass requerido');
  if (!sanitized.fromEmail) throw new Error('fromEmail requerido');
  const b64 = encrypt(sanitized);
  fs.writeFileSync(DATA_FILE, b64, 'utf8');
  cache = sanitized;
  return sanitized;
}

function getPublicConfig() {
  const cfg = loadConfig();
  if (!cfg) return null;
  const { pass, ...pub } = cfg;
  return pub;
}

module.exports = { loadConfig, saveConfig, getPublicConfig };
