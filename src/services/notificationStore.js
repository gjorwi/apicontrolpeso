const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, '..', '..', 'data', 'notifications.json');

let NotificationModel = null;
let mongoReady = false;

async function initDb() {
  const uri = process.env.MONGODB_URI || process.env.DATABASE_URL || '';
  if (!uri) return false;
  try {
    const mongoose = require('mongoose');
    if (mongoose.connection.readyState !== 1) {
      await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
    }
    const schema = new mongoose.Schema(
      {
        deviceId: { type: String, required: true },
        appointmentId: { type: String, required: true },
        patientId: { type: String, default: '' },
        push1d: { type: mongoose.Schema.Types.Mixed, default: null },
        push1h: { type: mongoose.Schema.Types.Mixed, default: null },
        email1d: { type: mongoose.Schema.Types.Mixed, default: null },
        email1h: { type: mongoose.Schema.Types.Mixed, default: null },
        updatedAt: { type: String, default: '' },
      },
      { collection: 'notification_states', minimize: false }
    );
    schema.index({ deviceId: 1, appointmentId: 1 }, { unique: true });
    NotificationModel = mongoose.models.NotificationState || mongoose.model('NotificationState', schema);
    mongoReady = true;
    return true;
  } catch (e) {
    console.warn('[notificationStore] Mongo init failed, fallback a archivo JSON:', e.message);
    NotificationModel = null;
    mongoReady = false;
    return false;
  }
}

function fileRead() {
  try {
    if (!fs.existsSync(DATA_FILE)) return {};
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) || {};
  } catch (e) {
    return {};
  }
}

function fileWrite(obj) {
  const dir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(obj, null, 2), 'utf8');
}

function key(deviceId, appointmentId) {
  return `${deviceId}:${appointmentId}`;
}

async function getState(deviceId, appointmentId) {
  if (!deviceId || !appointmentId) return null;
  if (mongoReady && NotificationModel) {
    const doc = await NotificationModel.findOne({ deviceId, appointmentId }).lean();
    return doc || null;
  }
  const all = fileRead();
  return all[key(deviceId, appointmentId)] || null;
}

async function setState(deviceId, appointmentId, patch) {
  if (!deviceId || !appointmentId) return null;
  const now = new Date().toISOString();
  if (mongoReady && NotificationModel) {
    const doc = await NotificationModel.findOneAndUpdate(
      { deviceId, appointmentId },
      { $set: { ...patch, patientId: patch.patientId || '', updatedAt: now } },
      { upsert: true, new: true }
    ).lean();
    return doc;
  }
  const all = fileRead();
  const k = key(deviceId, appointmentId);
  const prev = all[k] || {};
  const next = { ...prev, ...patch, updatedAt: now };
  all[k] = next;
  fileWrite(all);
  return next;
}

async function getStatesForDevice(deviceId) {
  if (!deviceId) return [];
  if (mongoReady && NotificationModel) {
    const docs = await NotificationModel.find({ deviceId }).lean();
    return docs || [];
  }
  const all = fileRead();
  const prefix = `${deviceId}:`;
  return Object.entries(all)
    .filter(([k]) => k.startsWith(prefix))
    .map(([, v]) => v);
}

async function deleteState(deviceId, appointmentId) {
  if (!deviceId || !appointmentId) return;
  if (mongoReady && NotificationModel) {
    await NotificationModel.deleteOne({ deviceId, appointmentId });
    return;
  }
  const all = fileRead();
  delete all[key(deviceId, appointmentId)];
  fileWrite(all);
}

// Reserva atómicamente una acción de notificación pendiente (ej: push1h).
// Devuelve true si ESTA instancia ganó el tiro y debe enviar; false si otro
// proceso (o un intento previo) ya la marcó. Evita envíos duplicados cuando
// corren dos instancias del servidor (local + Render) contra el mismo Mongo.
// Puede reclamar cuando el campo NO existe (primer envío) o cuando quedó
// 'failed' pendiente de reintento.
async function claimAction(deviceId, appointmentId, field) {
  if (!deviceId || !appointmentId || !field) return false;
  const now = new Date().toISOString();
  const claimed = { status: 'claimed', at: now, claimedBy: process.pid || 'unknown' };
  if (mongoReady && NotificationModel) {
    try {
      const filterAbsent = { deviceId, appointmentId };
      // El campo se considera "libre" si está ausente O es null (setState crea
      // los campos como null cuando aún no hay estado para esa acción).
      filterAbsent.$or = [{ [field]: { $exists: false } }, { [field]: null }];
      const doc = await NotificationModel.findOneAndUpdate(
        filterAbsent,
        { $set: { [field]: claimed, updatedAt: now } },
        { upsert: true, new: true }
      ).lean();
      if (doc && doc[field] && doc[field].status === 'claimed') return true;
    } catch (e) {
      if (e && e.code !== 11000) throw e;
      // E11000: el documento ya existe con el campo presente (ej: 'failed') — pasa al caso de reintento.
    }

    try {
      const filterFailed = { deviceId, appointmentId };
      filterFailed[`${field}.status`] = 'failed';
      const doc2 = await NotificationModel.findOneAndUpdate(
        filterFailed,
        { $set: { [field]: claimed, updatedAt: now } },
        { new: true }
      ).lean();
      if (doc2 && doc2[field] && doc2[field].status === 'claimed') return true;

      // Recuperar un 'claimed' colgado por un crash: permite reclamarlo tras 10 min.
      const staleAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      const filterStale = { deviceId, appointmentId };
      filterStale[`${field}.status`] = 'claimed';
      filterStale[`${field}.at`] = { $lt: staleAt };
      const doc3 = await NotificationModel.findOneAndUpdate(
        filterStale,
        { $set: { [field]: claimed, updatedAt: now } },
        { new: true }
      ).lean();
      return !!(doc3 && doc3[field] && doc3[field].status === 'claimed');
    } catch (e) {
      if (e && e.code === 11000) return false;
      throw e;
    }
  }
  const all = fileRead();
  const k = key(deviceId, appointmentId);
  const prev = (all[k] || {})[field];
  if (prev && prev.status !== 'failed') return false;
  all[k] = { ...(all[k] || {}), [field]: claimed, updatedAt: now };
  fileWrite(all);
  return true;
}

module.exports = { initDb, getState, setState, getStatesForDevice, deleteState, claimAction };
