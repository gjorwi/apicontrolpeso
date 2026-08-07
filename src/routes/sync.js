const express = require('express');
const requireAuth = require('../middleware/auth');
const syncStore = require('../services/syncStore');
const notificationStore = require('../services/notificationStore');

const router = express.Router();
router.use(requireAuth);

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

router.get('/:deviceId', async (req, res, next) => {
  try {
    const deviceId = String(req.params.deviceId || '').trim();
    if (!deviceId) return res.status(400).json({ error: 'INVALID_DEVICE', message: 'Falta deviceId.' });
    const snap = await syncStore.get(deviceId);
    const patients = snap && Array.isArray(snap.data?.patients) ? snap.data.patients : [];
    await attachNotify(patients, deviceId);
    return res.json({
      ok: true,
      data: { patients },
      ts: snap && snap.ts ? snap.ts : now(),
    });
  } catch (e) {
    next(e);
  }
});

router.post('/:deviceId', async (req, res, next) => {
  try {
    const deviceId = String(req.params.deviceId || '').trim();
    if (!deviceId) return res.status(400).json({ error: 'INVALID_DEVICE', message: 'Falta deviceId.' });

    const { ts, patients, deletedPatients } = req.body || {};
    const incomingTs = typeof ts === 'string' && ts ? ts : now();

    const prev = await syncStore.get(deviceId);
    const map = new Map();
    if (prev && Array.isArray(prev.data.patients)) {
      for (const p of prev.data.patients) {
        const id = cleanId(p);
        if (id) map.set(id, stampPatient(p));
      }
    }

    const tombstoneIds = new Set(
      (Array.isArray(deletedPatients) ? deletedPatients : []).map(cleanId).filter(Boolean)
    );
    tombstoneIds.forEach((id) => map.delete(id));

    for (const p of Array.isArray(patients) ? patients : []) {
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
    await syncStore.set(deviceId, { data: { patients: merged }, ts: incomingTs });
    await attachNotify(merged, deviceId);
    console.log(`[sync] device=${deviceId} patients=${merged.length} appointments=${totalAppts} incoming=${Array.isArray(patients) ? patients.length : 0} deleted=${tombstoneIds.size} ts=${incomingTs}`);
    return res.json({ ok: true, accepted: true, ts: incomingTs, data: { patients: merged } });
  } catch (e) {
    console.error('[sync] FAIL', e?.message);
    next(e);
  }
});

router.get('/:deviceId/appointments', async (req, res, next) => {
  try {
    const deviceId = String(req.params.deviceId || '').trim();
    if (!deviceId) return res.status(400).json({ error: 'INVALID_DEVICE' });
    const snap = await syncStore.get(deviceId);
    if (!snap) return res.json({ ok: true, deviceId, count: 0, patients: [] });
    const patients = Array.isArray(snap.data?.patients) ? snap.data.patients : [];
    await attachNotify(patients, deviceId);
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
    return res.json({ ok: true, deviceId, count: flat.length, patients: flat });
  } catch (e) {
    next(e);
  }
});

module.exports = router;