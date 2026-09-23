const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const AUTH_TAG_LEN = 16;
const DATA_FILE = path.join(__dirname, '..', '..', 'data', 'smtp.enc');
const MONGO_KEY = 'smtp';

let SmtpConfigModel = null;
let mongoReady = false;

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

function readFileConfig() {
  try {
    if (!fs.existsSync(DATA_FILE)) return null;
    const b64 = fs.readFileSync(DATA_FILE, 'utf8');
    return decrypt(b64);
  } catch (e) {
    console.warn('[smtpStore] failed to load file config:', e.message);
    return null;
  }
}

function loadConfig() {
  if (cache) return cache;
  const fileCfg = readFileConfig();
  if (fileCfg) cache = fileCfg;
  return cache;
}

// Persiste la config en MongoDB (sobrevive redeploys de Render) y mantiene el
// archivo cifrado como cache secundario para dev local sin MONGODB_URI.
async function initDb() {
  const uri = process.env.MONGODB_URI || process.env.DATABASE_URL || '';
  if (!uri) {
    console.log('[smtpStore] sin MONGODB_URI: la config SMTP se guarda solo en archivo (efímero en Render)');
    return false;
  }
  try {
    const mongoose = require('mongoose');
    if (mongoose.connection.readyState !== 1) {
      await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
    }
    const schema = new mongoose.Schema(
      {
        key: { type: String, required: true, unique: true },
        provider: { type: String, default: 'resend' },
        fromEmail: { type: String, required: true },
        fromName: { type: String, default: 'ControlPeso' },
        updatedAt: { type: String, default: '' },
      },
      { collection: 'smtp_config', minimize: false }
    );
    SmtpConfigModel = mongoose.models.SmtpConfig || mongoose.model('SmtpConfig', schema);
    mongoReady = true;

    const doc = await SmtpConfigModel.findOne({ key: MONGO_KEY }).lean();
    if (doc && doc.fromEmail) {
      cache = {
        provider: doc.provider || 'resend',
        fromEmail: String(doc.fromEmail),
        fromName: String(doc.fromName || 'ControlPeso'),
        updatedAt: doc.updatedAt || '',
      };
    } else {
      const fileCfg = readFileConfig();
      if (fileCfg && fileCfg.fromEmail) {
        cache = fileCfg;
        try {
          await SmtpConfigModel.updateOne({ key: MONGO_KEY }, { $set: fileCfg }, { upsert: true });
          console.log('[smtpStore] config migrada de archivo a MongoDB');
        } catch (e) {
          console.warn('[smtpStore] no se pudo migrar config a MongoDB:', e.message);
        }
      }
    }
    return true;
  } catch (e) {
    console.warn('[smtpStore] Mongo init failed, fallback a archivo:', e.message);
    SmtpConfigModel = null;
    mongoReady = false;
    return false;
  }
}

async function saveConfig(input) {
  const sanitized = {
    provider: 'resend',
    fromEmail: String(input.fromEmail || '').trim(),
    fromName: String(input.fromName || 'ControlPeso').trim(),
    updatedAt: new Date().toISOString(),
  };
  if (!sanitized.fromEmail) throw new Error('fromEmail requerido');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(sanitized.fromEmail)) throw new Error('fromEmail inválido');

  if (mongoReady && SmtpConfigModel) {
    await SmtpConfigModel.updateOne(
      { key: MONGO_KEY },
      { $set: { ...sanitized, key: MONGO_KEY } },
      { upsert: true }
    );
  }

  try {
    ensureDir();
    fs.writeFileSync(DATA_FILE, encrypt(sanitized), 'utf8');
  } catch (e) {
    if (!mongoReady) throw e;
    console.warn('[smtpStore] file cache write failed (la config quedó en MongoDB):', e.message);
  }

  cache = sanitized;
  return sanitized;
}

function getPublicConfig() {
  const cfg = loadConfig();
  if (!cfg) return null;
  return { ...cfg };
}

module.exports = { initDb, loadConfig, saveConfig, getPublicConfig };
