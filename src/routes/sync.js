const express = require('express');
const requireAuth = require('../middleware/auth');
const syncStore = require('../services/syncStore');
const notificationStore = require('../services/notificationStore');
const scheduler = require('../services/scheduler');

const router = express.Router();
router.use(requireAuth);

router.get('/discover', async (req, res, next) => {
  try {
    const all = await syncStore.getAll();
    const daily = all.filter((s) => !s.deviceId.startsWith(syncStore.BACKUP_PREFIX));
    const backups = all.filter((s) => s.deviceId.startsWith(syncStore.BACKUP_PREFIX));
    let latest = null;
    for (const snap of daily) {
      const patients = snap.data?.patients || [];
      if (patients.length === 0) continue;
      if (!latest || (snap.ts && snap.ts > latest.ts)) {
        latest = snap;
      }
    }
    const orphanCount = (await syncStore.countOrphanSnapshots?.()) ?? 0;
    if (!latest && backups.length === 0 && orphanCount === 0) {
      return res.json({ ok: true, found: false });
    }
    return res.json({
      ok: true,
      found: !!latest,
      deviceId: latest?.deviceId || null,
      backupId: latest?.backupId || null,
      count: (latest?.data?.patients || []).length,
      ts: latest?.ts || null,
      orphanCount,
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

// Merge "gana el más reciente" entre los pacientes existentes en el snapshot
// (de la fuente `from`) y los entrantes. Devuelve { merged, totalAppts }.
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

// GET snapshot "diario". La app ahora usa backupId como clave: el `id`
// que llega es el backupId del médico. Si el snapshot existe sin backupId
// etiquetado pero la query trae uno, intentamos buscar por backupId también.
router.get('/:id', async (req, res, next) => {
  try {
    let id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ error: 'INVALID_ID', message: 'Falta id.' });

    // Si llega `id` que parece ser deviceId (formato UUID legacy), y la query
    // trae backupId, preferimos el snapshot del médico.
    const qBackup = String(req.query.backupId || '').trim();

    let snap = await syncStore.get(id);
    if (!snap && qBackup) {
      snap = await syncStore.findByBackupId(qBackup);
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
      deviceIds: snap.deviceIds || [],
    });
  } catch (e) {
    next(e);
  }
});

// POST snapshot "diario". El cliente manda `backupId` en el body. La clave
// del snapshot puede ser:
//   (a) `id` enviado en la URL = backupId (caso normal).
//   (b) `id` enviado en la URL = deviceId legacy + body trae backupId → etiquetar retroactivamente.
//   (d) `id` enviado en la URL = backupId y ya existe snapshot viejo sin backupId → merge.
router.post('/:id', async (req, res, next) => {
  try {
    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ error: 'INVALID_ID', message: 'Falta id.' });

    const { ts, patients, deletedPatients, backupId, deviceId: sourceDeviceId } = req.body || {};
    const incomingTs = typeof ts === 'string' && ts ? ts : now();
    const incomingBackup = typeof backupId === 'string' ? backupId.trim() : '';
    const sourceDev = typeof sourceDeviceId === 'string' ? sourceDeviceId.trim() : '';

    let prev = await syncStore.get(id);
    const tombstoneIds = new Set(
      (Array.isArray(deletedPatients) ? deletedPatients : []).map(cleanId).filter(Boolean)
    );

    let migrated = false;
    let migratedFrom = null;
    if (!prev && incomingBackup) {
      const fromOld = await syncStore.findByBackupId(incomingBackup);
      if (fromOld && fromOld.deviceId !== id) {
        prev = { data: fromOld.data || {}, ts: fromOld.ts || '', backupId: fromOld.backupId || '' };
        migrated = true;
        migratedFrom = fromOld.deviceId;
        console.log(`[sync] migrating backupId=${incomingBackup} from=${fromOld.deviceId} -> ${id}`);
      }
    }

    const basePatients = prev ? (Array.isArray(prev.data.patients) ? prev.data.patients : []) : [];
    const { merged, totalAppts } = mergePatientSets(basePatients, patients, tombstoneIds);

    // Persistir: si id era un deviceId legacy y el snapshot no tenía backupId,
    // ahora se etiqueta con el del body (auto-tagging retroactivo).
    await syncStore.set(id, {
      data: { patients: merged },
      ts: incomingTs,
      backupId: incomingBackup || (prev && prev.backupId) || '',
      deviceId: sourceDev,
    });

    await attachNotify(merged, id);
    void scheduler.tick().catch((e2) => console.error('[sync] on-demand tick error:', e2?.message));
    console.log(`[sync] id=${id} backupId=${incomingBackup || (prev && prev.backupId) || '-'} patients=${merged.length} appointments=${totalAppts} incoming=${Array.isArray(patients) ? patients.length : 0} deleted=${tombstoneIds.size} migrated=${migrated}${migratedFrom ? ' from=' + migratedFrom : ''} ts=${incomingTs}`);
    return res.json({
      ok: true,
      accepted: true,
      ts: incomingTs,
      migrated,
      data: { patients: merged },
    });
  } catch (e) {
    console.error('[sync] FAIL', e?.message);
    next(e);
  }
});

// POST snapshot de BACKUP (inmutable). Guarda una copia con clave separada
// (prefijo "backup:"). NO se modifica con sync diario. Solo se actualiza
// cuando el médico presiona explícitamente "Subir respaldo".
router.post('/:id/backup', async (req, res, next) => {
  try {
    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ error: 'INVALID_ID', message: 'Falta id.' });
    // Aceptamos id = backupId (caso normal) o id = "backup:..." (caso legacy).
    const backupId = id.startsWith(syncStore.BACKUP_PREFIX) ? id.slice(syncStore.BACKUP_PREFIX.length) : id;

    const { ts, patients, deviceId: sourceDeviceId } = req.body || {};
    const incomingTs = typeof ts === 'string' && ts ? ts : now();
    const sourceDev = typeof sourceDeviceId === 'string' ? sourceDeviceId.trim() : '';

    const patientsArr = Array.isArray(patients) ? patients : [];
    const totalAppts = patientsArr.reduce((acc, p) => acc + (Array.isArray(p.appointments) ? p.appointments.length : 0), 0);
    await syncStore.setBackup(backupId, {
      data: { patients: patientsArr },
      ts: incomingTs,
      deviceId: sourceDev,
    });
    console.log(`[sync] BACKUP id=backup:${backupId} patients=${patientsArr.length} appointments=${totalAppts} ts=${incomingTs}`);
    return res.json({ ok: true, accepted: true, ts: incomingTs, kind: 'backup' });
  } catch (e) {
    console.error('[sync] BACKUP FAIL', e?.message);
    next(e);
  }
});

// GET snapshot de BACKUP (para restore).
router.get('/:id/backup', async (req, res, next) => {
  try {
    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ error: 'INVALID_ID' });
    const backupId = id.startsWith(syncStore.BACKUP_PREFIX) ? id.slice(syncStore.BACKUP_PREFIX.length) : id;
    const snap = await syncStore.getBackup(backupId);
    if (!snap) return res.json({ ok: true, id, found: false, data: { patients: [] }, ts: now() });
    return res.json({
      ok: true,
      id,
      found: true,
      data: snap.data || { patients: [] },
      ts: snap.ts || now(),
    });
  } catch (e) {
    next(e);
  }
});

// Mantener el endpoint de appointments
router.get('/:id/appointments', async (req, res, next) => {
  try {
    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ error: 'INVALID_ID' });
    let snap = await syncStore.get(id);
    if (!snap && req.query.backupId) {
      snap = await syncStore.findByBackupId(String(req.query.backupId || '').trim());
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