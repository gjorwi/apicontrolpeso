const express = require('express');
const requireAuth = require('../middleware/auth');
const { rateLimit } = require('../middleware/limiters');
const surveyStore = require('../services/surveyStore');
const surveyJobs = require('../services/surveyJobs');
const { evaluateAndNotify } = require('../services/surveyEvaluate');
const { firstName } = require('../services/surveyEmail');

const router = express.Router();

const LEVELS = ['ok', 'seguimiento', 'urgente'];

// --------------------------------------------------------------- helpers

function stripQuestions(config) {
  // El front no necesita 'severity' (evita que el paciente "adivine" qué
  // respuesta dispara alertas).
  return (config.questions || []).map((q) => ({
    id: q.id,
    text: q.text,
    type: q.type,
    required: q.required !== false,
    maxLength: q.maxLength || undefined,
    placeholder: q.placeholder || undefined,
    options: Array.isArray(q.options)
      ? q.options.map((o) => ({ value: o.value, label: o.label }))
      : undefined,
  }));
}

function validateAnswers(config, answers) {
  if (!Array.isArray(answers)) return { ok: false, error: 'Respuestas inválidas.' };
  const questions = Array.isArray(config.questions) ? config.questions : [];
  const seen = new Set();
  const cleaned = [];
  for (const a of answers) {
    if (!a || typeof a.questionId !== 'string') return { ok: false, error: 'Respuesta inválida.' };
    const q = questions.find((x) => x.id === a.questionId);
    if (!q) return { ok: false, error: `Pregunta desconocida (${a.questionId}).` };
    if (seen.has(q.id)) continue;
    seen.add(q.id);
    if (q.type === 'text') {
      const text = String(a.value ?? '').trim().slice(0, q.maxLength || 300);
      if (text) cleaned.push({ questionId: q.id, question: q.text, value: text });
      continue;
    }
    const opt = (Array.isArray(q.options) ? q.options : []).find((o) => o.value === a.value);
    if (!opt) return { ok: false, error: `Opción inválida para: ${q.text}` };
    cleaned.push({ questionId: q.id, question: q.text, value: opt.value, label: opt.label });
  }
  const missing = questions.filter((q) => q.required !== false && !seen.has(q.id));
  if (missing.length) {
    return { ok: false, error: `Falta responder: ${missing.map((m) => m.text).join(' | ')}` };
  }
  return { ok: true, answers: cleaned };
}


// ------------------------------------------------------------ públicas

router.get('/questions', rateLimit({ max: 30 }), async (req, res) => {
  try {
    const token = String(req.query.t || '').trim();
    if (!token) return res.status(400).json({ error: 'INVALID_TOKEN', message: 'Falta el enlace del reporte.' });

    const invite = await surveyStore.getInviteByToken(token);
    if (!invite) return res.status(404).json({ error: 'NOT_FOUND', message: 'Enlace no válido.' });

    const now = Date.now();
    const expires = invite.expiresAt ? new Date(invite.expiresAt).getTime() : 0;
    if (expires && now > expires && invite.status !== 'completed') {
      return res.status(410).json({ error: 'TOKEN_EXPIRED', message: 'Este enlace ya venció. Contacta a tu médica para recibir uno nuevo.' });
    }

    const config = await surveyStore.getConfig();

    if (invite.status === 'completed') {
      return res.json({
        ok: true,
        alreadyCompleted: true,
        patientFirstName: firstName(invite.patientName),
        date: invite.date,
        questions: [],
      });
    }

    if (invite.status === 'sent') {
      await surveyStore.markInvite(token, { status: 'opened', openedAt: new Date().toISOString() });
    }

    return res.json({
      ok: true,
      patientFirstName: firstName(invite.patientName),
      date: invite.date,
      expiresAt: invite.expiresAt,
      version: config.version,
      questions: stripQuestions(config),
    });
  } catch (e) {
    console.error('[survey] questions FAIL:', e.message);
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'No se pudo cargar el reporte.' });
  }
});

router.get('/open', rateLimit({ max: 60 }), async (req, res) => {
  try {
    const token = String(req.query.t || '').trim();
    if (!token) return res.status(400).json({ error: 'INVALID_TOKEN' });
    const invite = await surveyStore.getInviteByToken(token);
    if (!invite) return res.status(404).json({ error: 'NOT_FOUND' });
    if (invite.status === 'sent') {
      await surveyStore.markInvite(token, { status: 'opened', openedAt: new Date().toISOString() });
    }
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

router.post('/submit', rateLimit({ max: 10 }), async (req, res) => {
  try {
    const token = String(req.body?.t || '').trim();
    const rawAnswers = req.body?.answers;
    if (!token) return res.status(400).json({ error: 'INVALID_TOKEN', message: 'Falta el enlace del reporte.' });

    const invite = await surveyStore.getInviteByToken(token);
    if (!invite) return res.status(404).json({ error: 'NOT_FOUND', message: 'Enlace no válido.' });
    if (invite.status === 'completed') {
      return res.status(409).json({ error: 'ALREADY_ANSWERED', message: 'Este reporte ya fue enviado. ¡Gracias!' });
    }
    const expires = invite.expiresAt ? new Date(invite.expiresAt).getTime() : 0;
    if (expires && Date.now() > expires) {
      return res.status(410).json({ error: 'TOKEN_EXPIRED', message: 'Este enlace ya venció.' });
    }

    const config = await surveyStore.getConfig();
    const valid = validateAnswers(config, rawAnswers);
    if (!valid.ok) return res.status(400).json({ error: 'INVALID_ANSWERS', message: valid.error });

    const responseId = `r_${Date.now().toString(36)}${cryptoRandom()}`;
    const found = await surveyJobs.findPatient(invite.patientId, invite.deviceId);
    const patient = found?.patient || { id: invite.patientId, name: invite.patientName };

    await surveyStore.saveResponse({
      responseId,
      token,
      patientId: invite.patientId,
      patientName: invite.patientName || patient.name || '',
      deviceId: invite.deviceId || found?.deviceId || '',
      date: invite.date,
      questionVersion: invite.questionVersion || config.version || 1,
      answers: valid.answers,
    });

    await surveyStore.markInvite(token, {
      status: 'completed',
      completedAt: new Date().toISOString(),
      responseId,
    });

    // IA en segundo plano: la respuesta ya quedó guardada.
    void evaluateAndNotify({
      responseId,
      patient,
      patientName: invite.patientName || patient.name || '',
      config,
      answers: valid.answers,
    });

    return res.json({ ok: true, responseId, message: '¡Gracias! Tu reporte fue recibido.' });
  } catch (e) {
    console.error('[survey] submit FAIL:', e.message);
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'No se pudo guardar el reporte.' });
  }
});

function cryptoRandom() {
  try {
    return require('crypto').randomBytes(4).toString('hex');
  } catch (e) {
    return Math.random().toString(36).slice(2, 10);
  }
}

// ------------------------------------------------------- autenticadas

router.get('/overview', requireAuth, async (req, res) => {
  try {
    const date = typeof req.query.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date)
      ? req.query.date
      : undefined;
    const deviceId = typeof req.query.deviceId === 'string' ? req.query.deviceId : undefined;
    const overview = await surveyJobs.getOverview({ date, deviceId });
    return res.json({ ok: true, ...overview });
  } catch (e) {
    console.error('[survey] overview FAIL:', e.message);
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'No se pudo cargar los reportes.' });
  }
});

router.get('/pending', requireAuth, async (req, res) => {
  try {
    const date = typeof req.query.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date)
      ? req.query.date
      : undefined;
    const deviceId = typeof req.query.deviceId === 'string' ? req.query.deviceId : undefined;
    const pending = await surveyJobs.computePending(date, deviceId);
    return res.json({ ok: true, ...pending });
  } catch (e) {
    console.error('[survey] pending FAIL:', e.message);
    return res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

router.get('/patients/:patientId', requireAuth, async (req, res) => {
  try {
    const deviceId = typeof req.query.deviceId === 'string' ? req.query.deviceId : undefined;
    const date = typeof req.query.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date)
      ? req.query.date
      : undefined;
    const report = await surveyJobs.getPatientReport(req.params.patientId, deviceId, date);
    return res.json({ ok: true, ...report });
  } catch (e) {
    console.error('[survey] patient report FAIL:', e.message);
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'No se pudo cargar el historial.' });
  }
});

router.post('/send', requireAuth, rateLimit({ max: 30 }), async (req, res) => {
  try {
    const { patientId, deviceId, date } = req.body || {};
    if (!patientId || typeof patientId !== 'string') {
      return res.status(400).json({ error: 'INVALID_BODY', message: 'Falta el paciente.' });
    }
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'INVALID_DATE', message: 'Fecha inválida (use YYYY-MM-DD).' });
    }
    const result = await surveyJobs.manualSend({ patientId, deviceId, date });
    if (!result.ok) {
      const map = {
        no_patient: [404, 'NO_PATIENT', 'Paciente no encontrado en el servidor. Sincroniza la app.'],
        no_email: [409, 'NO_PATIENT_EMAIL', 'El paciente no tiene un correo válido. Agrégalo en su ficha y reenvía.'],
        no_url: [409, 'NO_SURVEY_URL', 'El servidor no tiene SURVEY_BASE_URL configurada.'],
        already_completed: [409, 'ALREADY_ANSWERED', 'El paciente ya respondió el reporte de hoy.'],
        smtp_not_configured: [409, 'NO_SENDER_CONFIGURED', 'Remitente de correo no configurado en el servidor.'],
        send_failed: [502, 'SEND_ERROR', result.error || 'No se pudo enviar el correo.'],
      };
      const [status, code, message] = map[result.reason] || [400, 'SEND_FAILED', 'No se pudo enviar.'];
      return res.status(status).json({ error: code, message, reason: result.reason });
    }
    return res.json({
      ok: true,
      date: result.date,
      messageId: result.messageId || null,
      mock: !!result.mock,
      resent: !!result.invite?.resentAt,
    });
  } catch (e) {
    console.error('[survey] send FAIL:', e.message);
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'No se pudo enviar el reporte.' });
  }
});

router.get('/config', requireAuth, async (req, res) => {
  try {
    const config = await surveyStore.getConfig();
    return res.json({ ok: true, config });
  } catch (e) {
    return res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

function validTime(v) {
  if (typeof v !== 'string') return false;
  const m = v.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return false;
  return Number(m[1]) <= 23 && Number(m[2]) <= 59;
}

function validateConfigPatch(patch, current) {
  if (typeof patch.enabled === 'boolean') current.enabled = patch.enabled;
  if (Array.isArray(patch.days)) {
    if (!patch.days.length || patch.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
      return 'Días inválidos (0=domingo .. 6=sábado).';
    }
    current.days = Array.from(new Set(patch.days)).sort((a, b) => a - b);
  }
  if (patch.time !== undefined) {
    if (!validTime(patch.time)) return 'Hora de envío inválida.';
    current.time = patch.time;
  }
  if (patch.digestTime !== undefined) {
    if (!validTime(patch.digestTime)) return 'Hora del resumen inválida.';
    current.digestTime = patch.digestTime;
  }
  if (patch.lateUntil !== undefined) {
    if (!validTime(patch.lateUntil)) return 'Hora límite inválida.';
    current.lateUntil = patch.lateUntil;
  }
  if (patch.ttlHours !== undefined) {
    const n = Number(patch.ttlHours);
    if (!Number.isFinite(n) || n < 1 || n > 720) return 'Vigencia inválida (1-720 horas).';
    current.ttlHours = n;
  }
  if (patch.signature !== undefined) {
    const s = String(patch.signature || '').trim();
    if (!s || s.length > 60) return 'Firma inválida.';
    current.signature = s;
  }
  if (patch.questions !== undefined) {
    if (!Array.isArray(patch.questions) || !patch.questions.length) return 'El cuestionario no puede quedar vacío.';
    const seen = new Set();
    for (const q of patch.questions) {
      if (!q || typeof q.id !== 'string' || !q.id.trim()) return 'Cada pregunta necesita id.';
      if (seen.has(q.id)) return `Pregunta duplicada: ${q.id}`;
      seen.add(q.id);
      if (typeof q.text !== 'string' || !q.text.trim()) return 'Cada pregunta necesita texto.';
      const type = q.type === 'text' ? 'text' : 'single';
      if (type === 'single') {
        if (!Array.isArray(q.options) || q.options.length < 2) return `La pregunta "${q.text}" necesita al menos 2 opciones.`;
        for (const o of q.options) {
          if (!o || typeof o.value !== 'string' || typeof o.label !== 'string') return `Opción inválida en "${q.text}".`;
          if (o.severity !== undefined && !LEVELS.includes(o.severity)) return `Severidad inválida en "${q.text}".`;
        }
      }
    }
    // Política: todas las preguntas son de selección rápida. Solo la última
    // puede ser de tipo 'text' (observación libre del paciente).
    const textIdx = patch.questions.findIndex((q) => q.type === 'text');
    if (textIdx !== -1 && textIdx !== patch.questions.length - 1) {
      return 'Solo la última pregunta puede ser de texto libre (observación).';
    }
    const next = patch.questions.map((q) => ({
      id: String(q.id).trim(),
      text: String(q.text).trim(),
      type: q.type === 'text' ? 'text' : 'single',
      required: q.type === 'text' ? q.required === true : q.required !== false,
      ...(q.type === 'text' ? { maxLength: Number(q.maxLength) || 300, placeholder: q.placeholder ? String(q.placeholder).slice(0, 80) : undefined } : {}),
      ...(q.type === 'text' ? {} : {
        options: q.options.map((o) => ({
          value: String(o.value),
          label: String(o.label),
          severity: LEVELS.includes(o.severity) ? o.severity : 'ok',
        })),
      }),
    }));
    if (JSON.stringify(next) !== JSON.stringify(current.questions || [])) {
      current.questions = next;
      current.version = (Number(current.version) || 1) + 1;
    }
  }
  return null;
}

router.put('/config', requireAuth, rateLimit({ max: 5 }), async (req, res) => {
  try {
    const patch = req.body?.config || req.body || {};
    const current = await surveyStore.getConfig();
    const error = validateConfigPatch(patch, current);
    if (error) return res.status(400).json({ error: 'VALIDATION', message: error });
    const saved = await surveyStore.saveConfig(current);
    return res.json({ ok: true, config: saved });
  } catch (e) {
    console.error('[survey] config FAIL:', e.message);
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'No se pudo guardar la configuración.' });
  }
});

module.exports = router;
