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
        // Antes: deviceId era siempre la clave. Ahora:
        //   - Snapshots "diario": deviceId = backupId (estable, multi-dispositivo).
        //   - Snapshots "backup" : deviceId = `backup:${backupId}` (inmutables, separados).
        // deviceIds[] mantiene la auditoría de qué dispositivos sincronizaron contra este snapshot.
        deviceId: { type: String, required: true, unique: true },
        backupId: { type: String, default: '', index: true, sparse: true },
        deviceIds: { type: [String], default: [] },
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
      deviceIds: doc.deviceIds || [],
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
    deviceIds: entry.deviceIds || [],
    data: entry.data || {},
    ts: entry.ts || '',
  };
}

async function set(deviceId, { data, ts, backupId, deviceId: sourceDeviceId }) {
  if (mongoReady && SnapshotModel) {
    const patch = { data: data || {}, ts: ts || '' };
    if (backupId !== undefined) patch.backupId = backupId;
    if (sourceDeviceId) {
      await SnapshotModel.updateOne(
        { deviceId },
        {
          $set: patch,
          $addToSet: { deviceIds: sourceDeviceId },
        },
        { upsert: true }
      );
    } else {
      await SnapshotModel.updateOne(
        { deviceId },
        { $set: patch },
        { upsert: true }
      );
    }
    return;
  }
  const all = fileRead() || {};
  const prev = all[deviceId] || {};
  const deviceIds = Array.isArray(prev.deviceIds) ? prev.deviceIds.slice() : [];
  if (sourceDeviceId && !deviceIds.includes(sourceDeviceId)) {
    deviceIds.push(sourceDeviceId);
  }
  all[deviceId] = {
    data: data || {},
    ts: ts || '',
    backupId: backupId !== undefined ? backupId : (prev.backupId || ''),
    deviceIds,
  };
  fileWrite(all);
}

async function findByBackupId(backupId) {
  if (!backupId) return null;
  if (mongoReady && SnapshotModel) {
    const doc = await SnapshotModel.findOne({ backupId }).lean();
    if (!doc) return null;
    return {
      deviceId: doc.deviceId,
      backupId: doc.backupId || '',
      deviceIds: doc.deviceIds || [],
      data: doc.data || {},
      ts: doc.ts || '',
    };
  }
  const all = fileRead() || {};
  for (const [key, entry] of Object.entries(all)) {
    if (entry && entry.backupId === backupId) {
      return {
        deviceId: key,
        backupId: entry.backupId || '',
        deviceIds: entry.deviceIds || [],
        data: entry.data || {},
        ts: entry.ts || '',
      };
    }
  }
  return null;
}

async function getAll() {
  if (mongoReady && SnapshotModel) {
    const docs = await SnapshotModel.find({}).lean();
    return docs.map((d) => ({
      deviceId: d.deviceId,
      backupId: d.backupId || '',
      deviceIds: d.deviceIds || [],
      data: d.data || {},
      ts: d.ts || '',
    }));
  }
  const all = fileRead() || {};
  return Object.entries(all).map(([deviceId, entry]) => ({
    deviceId,
    backupId: entry.backupId || '',
    deviceIds: entry.deviceIds || [],
    data: entry.data || {},
    ts: entry.ts || '',
  }));
}

// ------------------------------------------------------------- snapshots de backup

const BACKUP_PREFIX = 'backup:';
const backupKey = (backupId) => `${BACKUP_PREFIX}${backupId}`;

async function getBackup(backupId) {
  if (!backupId) return null;
  return get(backupKey(backupId));
}

async function setBackup(backupId, { data, ts, deviceId: sourceDeviceId }) {
  if (!backupId) return;
  return set(backupKey(backupId), { data, ts, deviceId: sourceDeviceId });
}

// Cuenta cuántos snapshots hay sin backupId (huérfanos legacy).
async function countOrphanSnapshots() {
  const all = await getAll();
  return all.filter((s) => !s.backupId && (s.data?.patients || []).length > 0).length;
}

module.exports = {
  initDb,
  get,
  set,
  findByBackupId,
  getAll,
  getBackup,
  setBackup,
  countOrphanSnapshots,
  BACKUP_PREFIX,
};