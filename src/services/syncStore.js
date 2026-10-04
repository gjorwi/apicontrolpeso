const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, '..', '..', 'data', 'sync.json');

let SnapshotModel = null;
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
        deviceId: { type: String, required: true, unique: true },
        backupId: { type: String, default: '', index: true, sparse: true },
        data: { type: mongoose.Schema.Types.Mixed, default: {} },
        ts: { type: String, default: '' },
      },
      { collection: 'sync_snapshots', minimize: false }
    );
    SnapshotModel = mongoose.models.SyncSnapshot || mongoose.model('SyncSnapshot', schema);
    mongoReady = true;
    return true;
  } catch (e) {
    console.warn('[syncStore] Mongo init failed, fallback a archivo JSON:', e.message);
    SnapshotModel = null;
    mongoReady = false;
    return false;
  }
}

function fileRead() {
  try {
    if (!fs.existsSync(DATA_FILE)) return null;
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    return null;
  }
}

function fileWrite(obj) {
  const dir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(obj, null, 2), 'utf8');
}

async function get(deviceId) {
  if (mongoReady && SnapshotModel) {
    const doc = await SnapshotModel.findOne({ deviceId }).lean();
    if (!doc) return null;
    return {
      deviceId: doc.deviceId,
      backupId: doc.backupId || '',
      data: doc.data || {},
      ts: doc.ts || '',
    };
  }
  const all = fileRead();
  const entry = all && all[deviceId];
  if (!entry) return null;
  return {
    deviceId,
    backupId: entry.backupId || '',
    data: entry.data || {},
    ts: entry.ts || '',
  };
}

async function set(deviceId, { data, ts, backupId }) {
  if (mongoReady && SnapshotModel) {
    const patch = { data: data || {}, ts: ts || '' };
    if (backupId !== undefined) patch.backupId = backupId;
    await SnapshotModel.updateOne(
      { deviceId },
      { $set: patch },
      { upsert: true }
    );
    return;
  }
  const all = fileRead() || {};
  const prev = all[deviceId] || {};
  all[deviceId] = {
    data: data || {},
    ts: ts || '',
    backupId: backupId !== undefined ? backupId : (prev.backupId || ''),
  };
  fileWrite(all);
}

async function getAll() {
  if (mongoReady && SnapshotModel) {
    const docs = await SnapshotModel.find({}).lean();
    return docs.map((d) => ({
      deviceId: d.deviceId,
      backupId: d.backupId || '',
      data: d.data || {},
      ts: d.ts || '',
    }));
  }
  const all = fileRead() || {};
  return Object.entries(all).map(([deviceId, entry]) => ({
    deviceId,
    backupId: entry.backupId || '',
    data: entry.data || {},
    ts: entry.ts || '',
  }));
}

// Devuelve todos los snapshots cuyo campo backupId coincide con el valor.
async function getByBackup(backupId) {
  if (!backupId) return [];
  if (mongoReady && SnapshotModel) {
    const docs = await SnapshotModel.find({ backupId }).lean();
    return docs.map((d) => ({
      deviceId: d.deviceId,
      backupId: d.backupId || '',
      data: d.data || {},
      ts: d.ts || '',
    }));
  }
  const all = fileRead() || {};
  return Object.entries(all)
    .filter(([, entry]) => entry && entry.backupId === backupId)
    .map(([deviceId, entry]) => ({
      deviceId,
      backupId: entry.backupId || '',
      data: entry.data || {},
      ts: entry.ts || '',
    }));
}

// Etiqueta retroactivamente cualquier snapshot cuyo deviceId coincida con uno
// de los deviceIds dados, asignándole el backupId si no lo tiene.
async function tagByDeviceIds(deviceIds, backupId) {
  if (!backupId || !Array.isArray(deviceIds) || !deviceIds.length) return { updated: 0 };
  let updated = 0;
  for (const deviceId of deviceIds) {
    if (!deviceId) continue;
    const prev = await get(deviceId);
    if (!prev) continue;
    if (prev.backupId === backupId) continue;
    await set(deviceId, { data: prev.data, ts: prev.ts, backupId });
    updated++;
  }
  return { updated };
}

module.exports = { initDb, get, set, getAll, getByBackup, tagByDeviceIds };