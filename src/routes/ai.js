const express = require('express');
const requireAuth = require('../middleware/auth');
const { rateLimit } = require('../middleware/limiters');

const router = express.Router();

const DEFAULT_BASE_URL = 'https://api.deepseek.com';
const TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS) || 110000;

const SYSTEM_PROMPT = `Eres "Susam", un profesional de la salud (médico/clínico) especializado en control de peso, medicina del deporte y terapias con péptidos (semaglutida, tirzepatida, liraglutida, dulaglutida, retatrutida, etc.).

Misión: evaluar de forma integral a un paciente a partir de TODOS los datos clínicos disponibles (antropometría, evolución, composición corporal, signos vitales, inyecciones y dosis de péptidos, medicación, citas y notas) y devolver un análisis profesional, objetivo y accionable para el médico que te consulta.

Reglas:
- Responde SIEMPRE en español, en formato markdown simple (encabezados "##", viñetas "- ", negritas "**texto**"). Sin tablas largas ni bloques de código.
- Solo usas los datos provistos; si falta información relevante, indícalo como "Dato faltante" en lugar de inventar.
- Sé concreto con números: dosis, gramos, kg, IMC, tendencias.
- Prioriza seguridad: no suspender ni cambiar medicación sin indicación médica; señala señales de alerta.
- No reemplazas el juicio clínico del médico: termina con "Recomendaciones para el médico que decide".

Estructura obligatoria de tu respuesta:
## Resumen ejecutivo
(3-5 líneas: quién es el paciente, dónde está su proceso y el punto más importante.)
## Evolución antropométrica
(peso actual vs inicial vs objetivo, tendencia, IMC, ritmo de pérdida, adherencia aparente.)
## Composición corporal
(grasa corporal estimada, masa magra, perímetros, relación cintura/altura, riesgo abdominal.)
## Terapia con péptidos y medicación
(medicamento actual, dosis y escalación, sitios de inyección, efectos secundarios reportados, medicación concomitante, interacciones o alertas.)
## Signos vitales y riesgos
(PA, pulso, glucosa, SpO2, temperatura; alertas y seguimiento sugerido.)
## Recomendaciones personalizadas
(proteína diaria calculada para ESTE paciente, hidratación, déficit/superávit calórico, actividad física, sueño — todo ajustado a sus datos.)
## Ajustes sugeridos y vigilancia
(con qué frecuencia medir, qué parámetros vigilar, cuándo reevaluar.)
## Recomendaciones para el médico que decide
(lista final accionable, con advertencias si las hay.)`;

function getFetch() {
  if (typeof fetch === 'function') return fetch;
  try { return require('node-fetch'); } catch (_) { return null; }
}

function buildUserPrompt({ patient, metrics, recommendations }) {
  const payload = { paciente: patient, metricas_calculadas: metrics, recomendaciones_actuales: recommendations };
  return `Evaluá al siguiente paciente con TODOS sus datos.\n\n${JSON.stringify(payload, null, 2)}`;
}

router.post('/evaluate', requireAuth, rateLimit({ max: 6 }), async (req, res) => {
  try {
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) {
      return res.status(503).json({
        error: 'AI_NOT_CONFIGURED',
        message: 'El servidor no tiene DEEPSEEK_API_KEY configurada.',
      });
    }

    const { patient, metrics, recommendations } = req.body || {};
    if (!patient || typeof patient !== 'object' || !patient.id) {
      return res.status(400).json({ error: 'INVALID_BODY', message: 'Faltan los datos del paciente.' });
    }

    const fetchFn = getFetch();
    if (!fetchFn) {
      return res.status(500).json({ error: 'NO_FETCH', message: 'El servidor no dispone de fetch (Node >= 18).' });
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let upstream;
    try {
      upstream = await fetchFn(`${process.env.DEEPSEEK_BASE_URL || DEFAULT_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: buildUserPrompt({ patient, metrics, recommendations }) },
          ],
          temperature: 0.4,
          max_tokens: Number(process.env.AI_MAX_TOKENS) || 4000,
          stream: false,
        }),
        signal: controller.signal,
      });
    } catch (e) {
      if (e && (e.name === 'AbortError' || e.name === 'TimeoutError')) {
        return res.status(504).json({ error: 'AI_TIMEOUT', message: 'El modelo tardó demasiado en responder.' });
      }
      console.error('[ai] upstream error:', e.message);
      return res.status(502).json({ error: 'AI_UPSTREAM_ERROR', message: 'No se pudo contactar al modelo.' });
    } finally {
      clearTimeout(timer);
    }

    if (!upstream.ok) {
      const text = await upstream.text().catch(() => '');
      console.error(`[ai] DeepSeek status=${upstream.status} body=${text.slice(0, 300)}`);
      if (upstream.status === 401 || upstream.status === 403) {
        return res.status(502).json({ error: 'AI_AUTH', message: 'API key de DeepSeek inválida.' });
      }
      if (upstream.status === 429) {
        return res.status(429).json({ error: 'AI_RATE_LIMIT', message: 'Límite de uso de DeepSeek alcanzado.' });
      }
      return res.status(502).json({ error: 'AI_UPSTREAM_ERROR', message: 'El modelo devolvió un error.' });
    }

    const data = await upstream.json().catch(() => null);
    const content = data?.choices?.[0]?.message?.content;
    if (!content) {
      return res.status(502).json({ error: 'AI_EMPTY_RESPONSE', message: 'El modelo no devolvió contenido.' });
    }

    return res.json({
      ok: true,
      content,
      model: data.model || process.env.DEEPSEEK_MODEL || 'deepseek-chat',
      usage: data.usage || null,
      evaluatedAt: new Date().toISOString(),
    });
  } catch (e) {
    console.error('[ai] evaluate FAIL:', e.message);
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'Error interno al evaluar.' });
  }
});

module.exports = router;
