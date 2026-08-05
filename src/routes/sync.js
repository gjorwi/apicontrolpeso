const express = require('express');
const requireAuth = require('../middleware/auth');
const syncStore = require('../services/syncStore');

const router = express.Router();
router.use(requireAuth);

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
    return res.json({
      ok: true,
      data: snap ? snap.data : { patients: [] },
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
    await syncStore.set(deviceId, { data: { patients: merged }, ts: incomingTs });
    return res.json({ ok: true, accepted: true, ts: incomingTs, data: { patients: merged } });
  } catch (e) {
    next(e);
  }
});

module.exports = router;