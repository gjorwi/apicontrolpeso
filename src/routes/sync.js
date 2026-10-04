const express = require('express');
const requireAuth = require('../middleware/auth');
const syncStore = require('../services/syncStore');
const surveyStore = require('../services/surveyStore');
const notificationStore = require('../services/notificationStore');
const scheduler = require('../services/scheduler');

const router = express.Router();
router.use(requireAuth);

router.get('/discover', async (req, res, next) => {
  try {
    const all = await syncStore.getAll();
    let latest = null;
    for (const snap of all) {
      const patients = snap.data?.patients || [];
      if (patients.length === 0) continue;
      if (!latest || (snap.ts && snap.ts > latest.ts)) {
        latest = snap;
      }
    }
    if (!latest) {
      return res.json({ ok: true, found: false });
    }
    return res.json({
      ok: true,
      found: true,
      deviceId: latest.deviceId,
      count: (latest.data?.patients || []).length,
      ts: latest.ts,
    });
  } catch (e) {
    next(e);
  }
});

async function attachNotify(patients, deviceId) {
  if (!deviceId || !Array.isArray(patients)) return;
  try {
    const states = await notificationStore.getStatesForDevice(deviceId);
    const byKey = new Map();
    for (const s of states) byKey.set(s.appointmentId, s);
    for (const p of patients) {
      if (!Array.isArray(p.appointments)) continue;
      for (const a of p.appointments) {
        const st = byKey.get(a.id);
        a.notify = st
          ? {
              push1d: st.push1d || null,
              push1h: st.push1h || null,
              email1d: st.email1d || null,
              email1h: st.email1h || null,
              pushAt: st.pushAt || null,
              emailAt: st.emailAt || null,
            }
          : null;
      }
    }
  } catch (e) {
    console.error('[sync] attachNotify error:', e.message);
  }
}

function now() {
  return new Date().toISOString();
}

function stampPatient(p) {
  if (!p || typeof p !== 'object') return p;
  return { ...p, updatedAt: p.updatedAt || now() };
}

function toTS(iso) {
  const t = new Date(iso).getTime();
  return isNaN(t) ? 0 : t;
}

function cleanId(v) {
  const id = typeof v === 'string' ? v : v && typeof v.id === 'string' ? v.id : '';
  return id.trim();
}

function mergePatientSets(existingPatients, incomingPatients, tombstoneIds) {
  const map = new Map();
  for (const p of Array.isArray(existingPatients) ? existingPatients : []) {
    const id = cleanId(p);
    if (id) map.set(id, stampPatient(p));
  }
  if (tombstoneIds && tombstoneIds.size) {
    tombstoneIds.forEach((id) => map.delete(id));
  }
  for (const p of Array.isArray(incomingPatients) ? incomingPatients : []) {
    const id = cleanId(p);
    if (!id) continue;
    if (p.deletedAt) {
      map.delete(id);
      continue;
    }
    const sp = stampPatient(p);
    const existing = map.get(id);
    if (!existing || toTS(sp.updatedAt) >= toTS(existing.updatedAt)) {
      map.set(id, sp);
    }
  }
  const merged = [...map.values()];
  const totalAppts = merged.reduce((acc, p) => acc + (Array.isArray(p.appointments) ? p.appointments.length : 0), 0);
  return { merged, totalAppts };
}

// GET snapshot de un deviceId.
// Si el body trae backupId y no hay snapshot para este id, intentamos
// recuperar el snapshot por backupId (modo "traer data por nombre de cuenta").
router.get('/:id', async (req, res, next) => {
  try {
    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ error: 'INVALID_ID', message: 'Falta id.' });
    let snap = await syncStore.get(id);
    if (!snap && req.query.backupId) {
      const list = await syncStore.getByBackup(String(req.query.backupId || '').trim());
      // Tomamos el snapshot más reciente de la cuenta (no del deviceId).
      if (Array.isArray(list) && list.length) {
        list.sort((a, b) => toTS(b.ts) - toTS(a.ts));
        snap = list[0];
      }
    }
    if (!snap) {
      return res.json({ ok: true, data: { patients: [] }, ts: now(), found: false });
    }
    const patients = snap && Array.isArray(snap.data?.patients) ? snap.data.patients : [];
    await attachNotify(patients, snap.deviceId || id);
    return res.json({
      ok: true,
      data: { patients },
      ts: snap.ts || now(),
      backupId: snap.backupId || null,
    });
  } catch (e) {
    next(e);
  }
});

// GET /by-backup/:backupId/pull
// Devuelve TODA la data asociada al backupId del médico (de TODOS sus dispositivos):
//   - sync_snapshots
//   - survey_invites (filtradas por deviceIds asociados al backupId)
//   - survey_responses (filtradas por deviceIds asociados al backupId)
//   - notifications (filtradas por deviceIds asociados al backupId)
//   - survey_settings (GLOBAL)
// Esto permite que un dispositivo nuevo del mismo médico baje toda la data
// desde el servidor, sin importar en qué deviceId se originó.
router.get('/by-backup/:backupId/pull', async (req, res, next) => {
  try {
    const backupId = decodeURIComponent(req.params.backupId || '').trim();
    if (!backupId) {
      return res.status(400).json({ error: 'BACKUP_ID_REQUIRED', message: 'Falta backupId.' });
    }

    const snapshots = await syncStore.getByBackup(backupId);
    const deviceIds = Array.from(new Set(snapshots.map((s) => s.deviceId).filter(Boolean)));

    const [invites, responses, notifications, settings] = await Promise.all([
      surveyStore.listInvites({ deviceIds, limit: 10000 }),
      surveyStore.listResponses({ deviceIds, limit: 10000 }),
      deviceIds.length
        ? (await notificationStore.getAll()).filter((n) => deviceIds.includes(n.deviceId))
        : Promise.resolve([]),
      surveyStore.getConfig(),
    ]);

    // Adjuntar notify por deviceId de cada snapshot.
    const decoratedSnapshots = [];
    for (const snap of snapshots) {
      const patients = Array.isArray(snap.data?.patients) ? snap.data.patients : [];
      await attachNotify(patients, snap.deviceId);
      decoratedSnapshots.push({
        deviceId: snap.deviceId,
        backupId: snap.backupId || backupId,
        ts: snap.ts || '',
        data: { patients },
      });
    }

    return res.json({
      ok: true,
      backupId,
      pulledAt: new Date().toISOString(),
      data: {
        sync_snapshots: decoratedSnapshots,
        survey_invites: invites,
        survey_responses: responses,
        notifications,
        survey_settings: settings,
        device_ids: deviceIds,
      },
    });
  } catch (e) {
    console.error('[sync] by-backup/pull FAIL:', e?.message);
    next(e);
  }
});

// POST snapshot "diario".
// Si el body trae backupId, etiqueta retroactivamente el snapshot con ese backupId.
router.post('/:id', async (req, res, next) => {
  try {
    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ error: 'INVALID_ID', message: 'Falta id.' });

    const { ts, patients, deletedPatients, backupId } = req.body || {};
    const incomingTs = typeof ts === 'string' && ts ? ts : now();
    const incomingBackup = typeof backupId === 'string' ? backupId.trim() : '';

    let prev = await syncStore.get(id);
    const tombstoneIds = new Set(
      (Array.isArray(deletedPatients) ? deletedPatients : []).map(cleanId).filter(Boolean)
    );

    const basePatients = prev ? (Array.isArray(prev.data.patients) ? prev.data.patients : []) : [];
    const { merged, totalAppts } = mergePatientSets(basePatients, patients, tombstoneIds);

    await syncStore.set(id, {
      data: { patients: merged },
      ts: incomingTs,
      backupId: incomingBackup || (prev && prev.backupId) || '',
    });

    // Si el body trae backupId, también etiquetamos invites/responses
    // que coincidan con este deviceId.
    let invitesTagged = 0;
    let responsesTagged = 0;
    if (incomingBackup) {
      try {
        const r1 = await surveyStore.tagInvitesByDeviceIds([id], incomingBackup);
        invitesTagged = r1.updated;
        const r2 = await surveyStore.tagResponsesByDeviceIds([id], incomingBackup);
        responsesTagged = r2.updated;
      } catch (e) {
        console.warn('[sync] tag-by-deviceIds warning:', e?.message);
      }
    }

    await attachNotify(merged, id);
    void scheduler.tick().catch((e2) => console.error('[sync] on-demand tick error:', e2?.message));
    console.log(`[sync] id=${id} backupId=${incomingBackup || (prev && prev.backupId) || '-'} patients=${merged.length} appointments=${totalAppts} incoming=${Array.isArray(patients) ? patients.length : 0} deleted=${tombstoneIds.size} invitesTagged=${invitesTagged} responsesTagged=${responsesTagged} ts=${incomingTs}`);
    return res.json({
      ok: true,
      accepted: true,
      ts: incomingTs,
      invitesTagged,
      responsesTagged,
      data: { patients: merged },
    });
  } catch (e) {
    console.error('[sync] FAIL', e?.message);
    next(e);
  }
});

router.get('/:id/appointments', async (req, res, next) => {
  try {
    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ error: 'INVALID_ID' });
    let snap = await syncStore.get(id);
    if (!snap && req.query.backupId) {
      const list = await syncStore.getByBackup(String(req.query.backupId || '').trim());
      if (Array.isArray(list) && list.length) {
        list.sort((a, b) => toTS(b.ts) - toTS(a.ts));
        snap = list[0];
      }
    }
    if (!snap) return res.json({ ok: true, id, count: 0, patients: [] });
    const patients = Array.isArray(snap.data?.patients) ? snap.data.patients : [];
    await attachNotify(patients, snap.deviceId || id);
    const flat = [];
    for (const p of patients) {
      const appts = Array.isArray(p.appointments) ? p.appointments : [];
      for (const a of appts) {
        flat.push({
          appointmentId: a.id,
          patientId: p.id,
          patientName: p.name,
          date: a.date,
          time: a.time,
          status: a.status,
          emailStatus: a.emailStatus,
          notified1dAt: a.notified1dAt || null,
          notified1hAt: a.notified1hAt || null,
          emailSentAt: a.emailSentAt || null,
          notify: a.notify || null,
        });
      }
    }
    return res.json({ ok: true, id, count: flat.length, patients: flat });
  } catch (e) {
    next(e);
  }
});

module.exports = router;