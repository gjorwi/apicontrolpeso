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
    return res.json({
      registered: true,
      platform: device.platform,
      updatedAt: device.updatedAt,
      tokenPrefix: typeof device.pushToken === 'string' ? device.pushToken.slice(0, 24) : '',
    });
  } catch (e) {
    next(e);
  }
});

// Envía un push de prueba al dispositivo. Devuelve el resultado real de Expo
// para diagnosticar de inmediato si el token es válido o si hay que reinstalar.
router.post('/test-push', requireAuth, async (req, res, next) => {
  try {
    const { deviceId } = req.body || {};
    if (!deviceId) {
      return res.status(400).json({ error: 'INVALID_BODY', message: 'Falta deviceId.' });
    }
    const device = await deviceStore.getDeviceToken(deviceId);
    if (!device || !device.pushToken) {
      return res.status(404).json({ error: 'NO_DEVICE', message: 'Dispositivo sin token registrado. Abrí la app para registrarlo.' });
    }
    const r = await pushService.sendPush({
      token: device.pushToken,
      title: 'ControlPeso',
      body: 'Push de prueba. Si ves esto, las notificaciones funcionan.',
      data: { type: 'test_push' },
    });
    const tokenPrefix = device.pushToken.slice(0, 20);
    if (r.ok) {
      return res.json({ ok: true, tokenPrefix, ticketId: r.ticketId });
    }
    return res.json({ ok: false, tokenPrefix, error: r.error, message: r.message || r.error });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
