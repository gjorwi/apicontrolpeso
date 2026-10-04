const express = require('express');
const requireAuth = require('../middleware/auth');
const syncStore = require('../services/syncStore');
const surveyStore = require('../services/surveyStore');
const notificationStore = require('../services/notificationStore');
const smtpStore = require('../services/smtpStore');

const router = express.Router();
router.use(requireAuth);

function cleanDoc(doc) {
  if (!doc) return null;
  const { _id, __v, ...rest } = doc;
  return rest;
}

function toTs(iso) {
  const t = new Date(iso).getTime();
  return isNaN(t) ? 0 : t;
}

// Identifica el dispositivo que está pidiendo el dump/restore.
function readDeviceId(req) {
  return String(req.headers['x-device-id'] || req.body?.deviceId || req.query?.deviceId || '').trim();
}

// Identifica el médico (opcional, usado para scope del dump y para validar restore).
function readBackupId(req) {
  const h = req.headers['x-backup-id'] || req.headers['X-Backup-Id'];
  return String(h || req.body?.backupId || req.query?.backupId || '').trim();
}

// GET /api/admin/dump
// Devuelve los datos del dispositivo identificado por X-Device-Id:
//   - sync_snapshots del deviceId
//   - survey_invites del deviceId
//   - survey_responses del deviceId
//   - notifications del deviceId
//   - survey_settings (GLOBAL)
//   - smtp_config (GLOBAL)
// El backupId se setea en el scope (viene del cliente que tipeó su email en la app).
router.get('/dump', async (req, res, next) => {
  try {
    const deviceId = readDeviceId(req);
    const backupId = readBackupId(req);
    if (!deviceId) {
      return res.status(400).json({
        error: 'DEVICE_ID_REQUIRED',
        message: 'Para descargar el respaldo se requiere el header X-Device-Id.',
      });
    }

    const [snapshots, invites, responses, settings, notifications, smtp] = await Promise.all([
      syncStore.getAll(),
      surveyStore.listInvites({ deviceIds: [deviceId], limit: 10000 }),
      surveyStore.listResponses({ deviceIds: [deviceId], limit: 10000 }),
      surveyStore.getConfig(),
      notificationStore.getAll().then((all) => (all || []).filter((n) => n.deviceId === deviceId)),
      smtpStore.loadConfig(),
    ]);

    const filteredSnapshots = (snapshots || []).filter((s) => s.deviceId === deviceId);

    const normalized = {
      version: 2,
      exportedAt: new Date().toISOString(),
      exportApp: 'controlpeso',
      scope: {
        deviceId,
        backupId: backupId || null,
      },
      sync_snapshots: filteredSnapshots.map((s) => ({
        deviceId: s.deviceId,
        backupId: s.backupId || backupId || '',
        ts: s.ts || '',
        data: s.data || {},
      })),
      survey_invites: (invites || []).map((i) => cleanDoc(i)),
      survey_responses: (responses || []).map((r) => cleanDoc(r)),
      survey_settings: settings || null,
      notifications: (notifications || []).map((n) => cleanDoc(n)),
      smtp_config: smtp || null,
    };

    const counts = {
      sync_snapshots: normalized.sync_snapshots.length,
      survey_invites: normalized.survey_invites.length,
      survey_responses: normalized.survey_responses.length,
      notifications: normalized.notifications.length,
      has_smtp: !!normalized.smtp_config,
      total_patients: normalized.sync_snapshots.reduce(
        (acc, s) => acc + (Array.isArray(s.data?.patients) ? s.data.patients.length : 0),
        0
      ),
    };

    return res.json({ ok: true, counts, dump: normalized });
  } catch (e) {
    console.error('[admin] dump FAIL:', e?.message);
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'No se pudo generar el respaldo.' });
  }
});

// POST /api/admin/restore
// Body: el JSON producido por /dump (o un subset).
// Valida:
//   - X-Backup-Id obligatorio y debe coincidir con scope.backupId del dump.
//   - El server destino aplica cada item con el deviceId del archivo
//     y el backupId del header.
router.post('/restore', async (req, res, next) => {
  try {
    const body = req.body || {};
    const dump = body.dump || body;
    const deviceId = readDeviceId(req); // deviceId del dispositivo que está restaurando
    const backupId = readBackupId(req);

    if (!backupId) {
      return res.status(400).json({
        error: 'BACKUP_ID_REQUIRED',
        message: 'Para restaurar se requiere el header X-Backup-Id.',
      });
    }

    const dumpScope = dump.scope || {};
    const dumpBackupId = String(dumpScope.backupId || '').trim();
    if (dumpBackupId && dumpBackupId !== backupId) {
      return res.status(403).json({
        error: 'BACKUP_ID_MISMATCH',
        message: `El respaldo pertenece a "${dumpBackupId}" pero tu identificador es "${backupId}".`,
      });
    }

    const applied = {};
    const skipped = {};

    // sync_snapshots: cada item declara su propio deviceId.
    // Se guarda con su deviceId original + backupId del header.
    if (Array.isArray(dump.sync_snapshots)) {
      let count = 0;
      for (const snap of dump.sync_snapshots) {
        if (!snap || !snap.deviceId) continue;
        const prev = await syncStore.get(snap.deviceId);
        const newTs = toTs(snap.ts);
        const prevTs = prev ? toTs(prev.ts) : 0;
        if (!prev || newTs >= prevTs) {
          await syncStore.set(snap.deviceId, {
            data: snap.data || {},
            ts: snap.ts || new Date().toISOString(),
            backupId: snap.backupId || backupId,
          });
          count++;
        }
      }
      applied.sync_snapshots = count;
    } else {
      skipped.sync_snapshots = 'no presente';
    }

    // survey_invites: cada item declara su propio deviceId.
    if (Array.isArray(dump.survey_invites)) {
      let count = 0;
      for (const inv of dump.survey_invites) {
        if (!inv || !inv.token) continue;
        const prev = await surveyStore.getInviteByToken(inv.token);
        const newTs = toTs(inv.updatedAt || inv.createdAt || '');
        const prevTs = prev ? toTs(prev.updatedAt || prev.createdAt || '') : 0;
        if (newTs > prevTs) {
          await surveyStore.markInvite(inv.token, { ...inv, backupId: inv.backupId || backupId });
          count++;
        }
      }
      applied.survey_invites = count;
    } else {
      skipped.survey_invites = 'no presente';
    }

    // survey_responses: cada item declara su propio deviceId.
    if (Array.isArray(dump.survey_responses)) {
      let count = 0;
      for (const r of dump.survey_responses) {
        if (!r || !r.responseId) continue;
        await surveyStore.saveResponse({
          ...r,
          backupId: r.backupId || backupId,
          ai: r.ai || null,
          aiStatus: r.aiStatus || 'pending',
        });
        count++;
      }
      applied.survey_responses = count;
    } else {
      skipped.survey_responses = 'no presente';
    }

    // survey_settings: GLOBAL. Si el dump lo trae, lo aplica.
    if (dump.survey_settings && typeof dump.survey_settings === 'object') {
      await surveyStore.saveConfig(dump.survey_settings);
      applied.survey_settings = 1;
    } else {
      skipped.survey_settings = 'no presente';
    }

    // notifications: cada item declara su propio deviceId.
    if (Array.isArray(dump.notifications)) {
      let count = 0;
      for (const n of dump.notifications) {
        if (!n || !n.deviceId || !n.appointmentId) continue;
        await notificationStore.saveState({ ...n, deviceId: n.deviceId });
        count++;
      }
      applied.notifications = count;
    } else {
      skipped.notifications = 'no presente';
    }

    // smtp_config: GLOBAL.
    if (dump.smtp_config && typeof dump.smtp_config === 'object') {
      try {
        await smtpStore.saveConfig({ ...dump.smtp_config });
        applied.smtp_config = 1;
      } catch (e) {
        skipped.smtp_config = 'no se pudo guardar (¿ENCRYPTION_KEY distinta?)';
      }
    } else {
      skipped.smtp_config = 'no presente';
    }

    return res.json({
      ok: true,
      applied,
      skipped,
      restoredAt: new Date().toISOString(),
      restoredBy: deviceId || null,
      backupId,
    });
  } catch (e) {
    console.error('[admin] restore FAIL:', e?.message);
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'No se pudo restaurar.' });
  }
});

module.exports = router;