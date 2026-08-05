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
  fs.writeFileSync(DATA_FILE, JSON.stringify(obj), 'utf8');
}

async function get(deviceId) {
  if (mongoReady && SnapshotModel) {
    const doc = await SnapshotModel.findOne({ deviceId }).lean();
    if (!doc) return null;
    return { data: doc.data || {}, ts: doc.ts || '' };
  }
  const all = fileRead();
  const entry = all && all[deviceId];
  if (!entry) return null;
  return { data: entry.data || {}, ts: entry.ts || '' };
}

async function set(deviceId, { data, ts }) {
  if (mongoReady && SnapshotModel) {
    await SnapshotModel.updateOne(
      { deviceId },
      { $set: { data: data || {}, ts: ts || '' } },
      { upsert: true }
    );
    return;
  }
  const all = fileRead() || {};
  all[deviceId] = { data: data || {}, ts: ts || '' };
  fileWrite(all);
}

module.exports = { initDb, get, set };