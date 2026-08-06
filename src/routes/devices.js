const express = require('express');
const requireAuth = require('../middleware/auth');
const deviceStore = require('../services/deviceStore');
const pushService = require('../services/pushService');

const router = express.Router();

router.post('/register', requireAuth, async (req, res, next) => {
  try {
    const { deviceId, pushToken, platform } = req.body || {};
    if (!deviceId || !pushToken) {
      return res.status(400).json({ error: 'INVALID_BODY', message: 'Falta deviceId o pushToken.' });
    }
    if (!pushService.isValidToken(pushToken)) {
      return res.status(400).json({ error: 'INVALID_TOKEN', message: 'pushToken no parece un Expo Push Token válido.' });
    }
    await deviceStore.saveDeviceToken({ deviceId, pushToken, platform: platform || 'unknown' });
    console.log(`[devices] registered deviceId=${deviceId} platform=${platform || 'unknown'} token=${pushToken.slice(0, 20)}...`);
    return res.json({ ok: true, deviceId, platform: platform || 'unknown' });
  } catch (e) {
    next(e);
  }
});

router.post('/unregister', requireAuth, async (req, res, next) => {
  try {
    const { deviceId } = req.body || {};
    if (!deviceId) {
      return res.status(400).json({ error: 'INVALID_BODY', message: 'Falta deviceId.' });
    }
    await deviceStore.removeDeviceToken(deviceId);
    console.log(`[devices] unregistered deviceId=${deviceId}`);
    return res.json({ ok: true, deviceId });
  } catch (e) {
    next(e);
  }
});

router.get('/status', requireAuth, async (req, res, next) => {
  try {
    const { deviceId } = req.query || {};
    if (!deviceId) {
      return res.status(400).json({ error: 'INVALID_QUERY', message: 'Falta deviceId.' });
    }
    const device = await deviceStore.getDeviceToken(deviceId);
    if (!device) return res.json({ registered: false });
    return res.json({ registered: true, platform: device.platform, updatedAt: device.updatedAt });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
