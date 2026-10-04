const fs = require('fs');
const path = require('path');
const { DEFAULT_CONFIG } = require('../config/survey');

const DATA_FILE = path.join(__dirname, '..', '..', 'data', 'survey.json');
const CONFIG_FILE = path.join(__dirname, '..', '..', 'data', 'survey_config.json');

let InviteModel = null;
let ResponseModel = null;
let DispatchModel = null;
let SettingsModel = null;
let mongoReady = false;

async function initDb() {
  const uri = process.env.MONGODB_URI || process.env.DATABASE_URL || '';
  if (!uri) return false;
  try {
    const mongoose = require('mongoose');
    if (mongoose.connection.readyState !== 1) {
      await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
    }
    const Mixed = mongoose.Schema.Types.Mixed;

    const inviteSchema = new mongoose.Schema(
      {
        token: { type: String, required: true, unique: true },
        patientId: { type: String, required: true, index: true },
        patientName: { type: String, default: '' },
        deviceId: { type: String, default: '' },
        backupId: { type: String, default: '', index: true, sparse: true },
        date: { type: String, required: true, index: true },
        email: { type: String, default: '' },
        status: { type: String, default: 'pending' }, // pending|sent|opened|completed|failed|skipped
        source: { type: String, default: 'auto' },    // auto|manual
        messageId: { type: String, default: '' },
        error: { type: String, default: '' },
        questionVersion: { type: Number, default: 1 },
        expiresAt: { type: String, default: '' },
        sentAt: { type: String, default: '' },
        resentAt: { type: String, default: '' },
        openedAt: { type: String, default: '' },
        completedAt: { type: String, default: '' },
        responseId: { type: String, default: '' },
        createdAt: { type: String, default: '' },
        updatedAt: { type: String, default: '' },
      },
      { collection: 'survey_invites', minimize: false }
    );
    inviteSchema.index({ patientId: 1, date: 1 });

    const responseSchema = new mongoose.Schema(
      {
        responseId: { type: String, required: true, unique: true },
        token: { type: String, default: '' },
        patientId: { type: String, required: true, index: true },
        patientName: { type: String, default: '' },
        deviceId: { type: String, default: '' },
        backupId: { type: String, default: '', index: true, sparse: true },
        date: { type: String, required: true, index: true },
        questionVersion: { type: Number, default: 1 },
        answers: { type: Mixed, default: [] },
        ai: { type: Mixed, default: null },
        aiStatus: { type: String, default: 'pending' }, // pending|ok|error
        createdAt: { type: String, default: '' },
        updatedAt: { type: String, default: '' },
      },
      { collection: 'survey_responses', minimize: false }
    );
    responseSchema.index({ patientId: 1, date: -1 });

    const dispatchSchema = new mongoose.Schema(
      {
        key: { type: String, required: true, unique: true },
        date: { type: String, default: '' },
        phase: { type: String, default: '' },
        status: { type: String, default: 'claimed' }, // claimed|done
        claimedBy: { type: String, default: '' },
        at: { type: String, default: '' },
        summary: { type: Mixed, default: null },
      },
      { collection: 'survey_dispatch', minimize: false }
    );

    const settingsSchema = new mongoose.Schema(
      {
        key: { type: String, required: true, unique: true },
        config: { type: Mixed, default: {} },
        updatedAt: { type: String, default: '' },
      },
      { collection: 'survey_settings', minimize: false }
    );

    InviteModel = mongoose.models.SurveyInvite || mongoose.model('SurveyInvite', inviteSchema);
    ResponseModel = mongoose.models.SurveyResponse || mongoose.model('SurveyResponse', responseSchema);
    DispatchModel = mongoose.models.SurveyDispatch || mongoose.model('SurveyDispatch', dispatchSchema);
    SettingsModel = mongoose.models.SurveySetting || mongoose.model('SurveySetting', settingsSchema);
    mongoReady = true;
    return true;
  } catch (e) {
    console.warn('[surveyStore] Mongo init failed, fallback a archivo JSON:', e.message);
    InviteModel = ResponseModel = DispatchModel = SettingsModel = null;
    mongoReady = false;
    return false;
  }
}

function fileRead() {
  try {
    if (!fs.existsSync(DATA_FILE)) return { invites: {}, responses: {}, dispatch: {} };
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) || {};
    return {
      invites: raw.invites || {},
      responses: raw.responses || {},
      dispatch: raw.dispatch || {},
    };
  } catch (e) {
    return { invites: {}, responses: {}, dispatch: {} };
  }
}

function fileWrite(obj) {
  const dir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(obj, null, 2), 'utf8');
}

function nowISO() {
  return new Date().toISOString();
}

function cleanDoc(doc) {
  if (!doc) return null;
  const { _id, __v, ...rest } = doc;
  return rest;
}

// ---------------------------------------------------------------- invites

async function createInvite(doc) {
  const now = nowISO();
  const invite = { createdAt: now, updatedAt: now, ...doc };
  if (mongoReady && InviteModel) {
    const created = await InviteModel.create(invite);
    return cleanDoc(created.toObject());
  }
  const all = fileRead();
  all.invites[invite.token] = invite;
  fileWrite(all);
  return invite;
}

async function getInviteByToken(token) {
  if (!token) return null;
  if (mongoReady && InviteModel) {
    return cleanDoc(await InviteModel.findOne({ token }).lean());
  }
  const all = fileRead();
  return all.invites[token] || null;
}

async function getInvite(patientId, date) {
  if (!patientId || !date) return null;
  if (mongoReady && InviteModel) {
    const doc = await InviteModel.findOne({ patientId, date }).sort({ createdAt: -1 }).lean();
    return cleanDoc(doc);
  }
  const all = fileRead();
  const found = Object.values(all.invites)
    .filter((i) => i.patientId === patientId && i.date === date)
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  return found[0] || null;
}

async function markInvite(token, patch) {
  if (!token) return null;
  const now = nowISO();
  if (mongoReady && InviteModel) {
    const doc = await InviteModel.findOneAndUpdate(
      { token },
      { $set: { ...patch, updatedAt: now } },
      { new: true }
    ).lean();
    return cleanDoc(doc);
  }
  const all = fileRead();
  const prev = all.invites[token];
  if (!prev) return null;
  const next = { ...prev, ...patch, updatedAt: now };
  all.invites[token] = next;
  fileWrite(all);
  return next;
}

async function listInvites({ date, patientId, backupId, deviceIds, limit = 500 } = {}) {
  if (mongoReady && InviteModel) {
    const filter = {};
    if (date) filter.date = date;
    if (patientId) filter.patientId = patientId;
    if (backupId) filter.backupId = backupId;
    if (Array.isArray(deviceIds) && deviceIds.length) filter.deviceId = { $in: deviceIds };
    const docs = await InviteModel.find(filter).sort({ createdAt: -1 }).limit(limit).lean();
    return docs.map(cleanDoc);
  }
  const all = fileRead();
  return Object.values(all.invites)
    .filter((i) => {
      if (date && i.date !== date) return false;
      if (patientId && i.patientId !== patientId) return false;
      if (backupId && i.backupId !== backupId) return false;
      if (Array.isArray(deviceIds) && deviceIds.length && !deviceIds.includes(i.deviceId)) return false;
      return true;
    })
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
    .slice(0, limit);
}

// ------------------------------------------------------------- responses

async function saveResponse(doc) {
  const now = nowISO();
  const response = { createdAt: now, updatedAt: now, aiStatus: 'pending', ai: null, ...doc };
  if (mongoReady && ResponseModel) {
    await ResponseModel.updateOne(
      { responseId: response.responseId },
      { $set: response },
      { upsert: true }
    );
    return response;
  }
  const all = fileRead();
  all.responses[response.responseId] = response;
  fileWrite(all);
  return response;
}

async function updateResponseAi(responseId, ai, aiStatus) {
  if (!responseId) return null;
  const now = nowISO();
  if (mongoReady && ResponseModel) {
    const doc = await ResponseModel.findOneAndUpdate(
      { responseId },
      { $set: { ai, aiStatus, updatedAt: now } },
      { new: true }
    ).lean();
    return cleanDoc(doc);
  }
  const all = fileRead();
  const prev = all.responses[responseId];
  if (!prev) return null;
  const next = { ...prev, ai, aiStatus, updatedAt: now };
  all.responses[responseId] = next;
  fileWrite(all);
  return next;
}

async function listResponses({ date, patientId, backupId, deviceIds, limit = 500 } = {}) {
  if (mongoReady && ResponseModel) {
    const filter = {};
    if (date) filter.date = date;
    if (patientId) filter.patientId = patientId;
    if (backupId) filter.backupId = backupId;
    if (Array.isArray(deviceIds) && deviceIds.length) filter.deviceId = { $in: deviceIds };
    const docs = await ResponseModel.find(filter).sort({ createdAt: -1 }).limit(limit).lean();
    return docs.map(cleanDoc);
  }
  const all = fileRead();
  return Object.values(all.responses)
    .filter((r) => {
      if (date && r.date !== date) return false;
      if (patientId && r.patientId !== patientId) return false;
      if (backupId && r.backupId !== backupId) return false;
      if (Array.isArray(deviceIds) && deviceIds.length && !deviceIds.includes(r.deviceId)) return false;
      return true;
    })
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
    .slice(0, limit);
}

// Respuestas cuya evaluación IA quedó 'pending' (el proceso se cayó durante la
// llamada) o 'error' (fallo transitorio). `minAgeMs` evita reintentos
// demasiado seguidos y `limit` acota el trabajo por tick.
async function listResponsesNeedingAi({ minAgeMs = 60000, limit = 3 } = {}) {
  const cutoff = new Date(Date.now() - minAgeMs).toISOString();
  if (mongoReady && ResponseModel) {
    const docs = await ResponseModel.find({
      aiStatus: { $in: ['pending', 'error'] },
      updatedAt: { $lt: cutoff },
    })
      .sort({ updatedAt: 1 })
      .limit(limit)
      .lean();
    return docs.map(cleanDoc);
  }
  const all = fileRead();
  return Object.values(all.responses)
    .filter(
      (r) =>
        (r.aiStatus === 'pending' || r.aiStatus === 'error') &&
        String(r.updatedAt || '') < cutoff
    )
    .sort((a, b) => String(a.updatedAt || '').localeCompare(String(b.updatedAt || '')))
    .slice(0, limit);
}

// -------------------------------------------------------------- dispatch

function dispatchKey(date, phase) {
  return `${date}:${phase}`;
}

// Reserva atómicamente el trabajo único de un día (envío o digest). Devuelve
// true solo a la instancia que gana; un 'claimed' huérfano de >10 min se puede
// recuperar tras un crash (mismo criterio que notificationStore.claimAction).
// Un trabajo en 'done' NUNCA se vuelve a reclamar: sin este guard el digest se
// reenviaba en cada tick (una vez por minuto) desde digestTime hasta medianoche.
async function claimDispatch(date, phase) {
  const key = dispatchKey(date, phase);
  const now = nowISO();
  const claimed = { status: 'claimed', at: now, claimedBy: String(process.pid || 'unknown') };
  if (mongoReady && DispatchModel) {
    try {
      const doc = await DispatchModel.findOneAndUpdate(
        { key, status: { $nin: ['claimed', 'done'] } },
        { $set: { ...claimed, key, date, phase }, $setOnInsert: {} },
        { upsert: true, new: true }
      ).lean();
      if (doc && doc.status === 'claimed') return true;
    } catch (e) {
      // 11000 = el doc ya existe (claimed/done): otro tick lo reclamó antes.
      if (e && e.code !== 11000) throw e;
    }
    // Recuperar un 'claimed' colgado por un crash (>10 min).
    const staleAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    try {
      const doc2 = await DispatchModel.findOneAndUpdate(
        { key, status: 'claimed', at: { $lt: staleAt } },
        { $set: { ...claimed, date, phase } },
        { new: true }
      ).lean();
      return !!(doc2 && doc2.status === 'claimed');
    } catch (e) {
      if (e && e.code === 11000) return false;
      throw e;
    }
  }
  const all = fileRead();
  const prev = all.dispatch[key];
  if (prev && prev.status === 'done') return false;
  if (prev && prev.status === 'claimed') {
    const prevAt = prev.at ? new Date(prev.at).getTime() : 0;
    if (Date.now() - prevAt < 10 * 60 * 1000) return false;
  }
  all.dispatch[key] = { ...claimed, key, date, phase };
  fileWrite(all);
  return true;
}

async function setDispatchSummary(date, phase, summary) {
  const key = dispatchKey(date, phase);
  if (mongoReady && DispatchModel) {
    await DispatchModel.updateOne(
      { key },
      { $set: { key, date, phase, status: 'done', summary, at: nowISO() } },
      { upsert: true }
    );
    return;
  }
  const all = fileRead();
  all.dispatch[key] = { ...(all.dispatch[key] || {}), key, date, phase, status: 'done', summary, at: nowISO() };
  fileWrite(all);
}

async function getDispatch(date, phase) {
  const key = dispatchKey(date, phase);
  if (mongoReady && DispatchModel) {
    return cleanDoc(await DispatchModel.findOne({ key }).lean());
  }
  const all = fileRead();
  return all.dispatch[key] || null;
}

// ---------------------------------------------------------------- config

function deepMerge(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    if (v === undefined) continue;
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = deepMerge(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

// Configuración vigente: defaults del código + overrides guardados en BD.
async function getConfig() {
  let stored = null;
  try {
    if (mongoReady && SettingsModel) {
      const doc = await SettingsModel.findOne({ key: 'survey' }).lean();
      stored = doc?.config || null;
    } else if (fs.existsSync(CONFIG_FILE)) {
      stored = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    }
  } catch (e) {
    console.warn('[surveyStore] config read error:', e.message);
  }
  return deepMerge(DEFAULT_CONFIG, stored || {});
}

async function saveConfig(patch) {
  const current = await getConfig();
  const next = deepMerge(current, patch || {});
  next.updatedAt = nowISO();
  if (mongoReady && SettingsModel) {
    await SettingsModel.updateOne(
      { key: 'survey' },
      { $set: { key: 'survey', config: next, updatedAt: next.updatedAt } },
      { upsert: true }
    );
    return next;
  }
  const dir = path.dirname(CONFIG_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

// Etiqueta retroactivamente cualquier invite/response cuyo deviceId esté
// en la lista, asignándole el backupId si no lo tiene.
async function tagInvitesByDeviceIds(deviceIds, backupId) {
  if (!backupId || !Array.isArray(deviceIds) || !deviceIds.length) return { updated: 0 };
  const all = await listInvites({ deviceIds, limit: 100000 });
  let updated = 0;
  for (const inv of all) {
    if (!inv || inv.backupId === backupId) continue;
    await markInvite(inv.token, { backupId });
    updated++;
  }
  return { updated };
}

async function tagResponsesByDeviceIds(deviceIds, backupId) {
  if (!backupId || !Array.isArray(deviceIds) || !deviceIds.length) return { updated: 0 };
  const all = await listResponses({ deviceIds, limit: 100000 });
  let updated = 0;
  for (const r of all) {
    if (!r || r.backupId === backupId) continue;
    await saveResponse({ ...r, backupId });
    updated++;
  }
  return { updated };
}

module.exports = {
  initDb,
  createInvite,
  getInviteByToken,
  getInvite,
  markInvite,
  listInvites,
  saveResponse,
  updateResponseAi,
  listResponses,
  listResponsesNeedingAi,
  tagInvitesByDeviceIds,
  tagResponsesByDeviceIds,
  claimDispatch,
  setDispatchSummary,
  getDispatch,
  getConfig,
  saveConfig,
};
