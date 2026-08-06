const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, '..', '..', 'data', 'devices.json');

let DeviceModel = null;
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
        deviceId: { type: String, required: true, unique: true, index: true },
        pushToken: { type: String, required: true },
        platform: { type: String, default: 'unknown' },
        updatedAt: { type: String, default: '' },
      },
      { collection: 'devices', minimize: false }
    );
    DeviceModel = mongoose.models.Device || mongoose.model('Device', schema);
    mongoReady = true;
    return true;
  } catch (e) {
    console.warn('[deviceStore] Mongo init failed, fallback a archivo JSON:', e.message);
    DeviceModel = null;
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

async function saveDeviceToken({ deviceId, pushToken, platform }) {
  if (!deviceId || !pushToken) throw new Error('deviceId y pushToken son requeridos');
  const now = new Date().toISOString();
  if (mongoReady && DeviceModel) {
    await DeviceModel.updateOne(
      { deviceId },
      { $set: { deviceId, pushToken, platform: platform || 'unknown', updatedAt: now } },
      { upsert: true }
    );
    return;
  }
  const all = fileRead();
  all[deviceId] = { pushToken, platform: platform || 'unknown', updatedAt: now };
  fileWrite(all);
}

async function getDeviceToken(deviceId) {
  if (!deviceId) return null;
  if (mongoReady && DeviceModel) {
    const doc = await DeviceModel.findOne({ deviceId }).lean();
    if (!doc) return null;
    return { pushToken: doc.pushToken, platform: doc.platform, updatedAt: doc.updatedAt };
  }
  const all = fileRead();
  return all[deviceId] || null;
}

async function removeDeviceToken(deviceId) {
  if (!deviceId) return;
  if (mongoReady && DeviceModel) {
    await DeviceModel.deleteOne({ deviceId });
    return;
  }
  const all = fileRead();
  delete all[deviceId];
  fileWrite(all);
}

async function listAllDevices() {
  if (mongoReady && DeviceModel) {
    const docs = await DeviceModel.find({}).lean();
    return docs.map((d) => ({ deviceId: d.deviceId, pushToken: d.pushToken, platform: d.platform }));
  }
  const all = fileRead();
  return Object.entries(all).map(([deviceId, v]) => ({
    deviceId,
    pushToken: v.pushToken,
    platform: v.platform,
  }));
}

module.exports = { initDb, saveDeviceToken, getDeviceToken, removeDeviceToken, listAllDevices };
