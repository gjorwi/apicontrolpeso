const express = require('express');
const requireAuth = require('../middleware/auth');
const { rateLimit } = require('../middleware/limiters');

const router = express.Router();

const DEFAULT_BASE_URL = 'https://api.deepseek.com';
const TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS) || 110000;

const SYSTEM_PROMPT = `Eres "Susam", un profesional de la salud (médico/clínico) especializado en control de peso, medicina del deporte y terapias con péptidos (semaglutida, tirzepatida, liraglutida, dulaglutida, retatrutida, etc.).

Misión: presentar al paciente como un CASO CLÍNICO narrado, al estilo de una presentación de caso en un cambio de guardia: fluido, interpretativo y accionable para el médico que te consulta. No listes datos: contá la historia clínica que cuentan.

Reglas de estilo (obligatorias):
- Responde SIEMPRE en español, en prosa fluida con párrafos corridos. Solo podés usar los 3 encabezados "##" indicados más abajo. Viñetas "- " únicamente en el plan final. Negritas "**texto**" para conclusiones clave. Sin tablas ni bloques de código.
- NO enumeres los datos que ya se muestran en la pantalla resumen del paciente (peso, altura, IMC, cintura, etc.). Mencioná una cifra solo cuando la interpretes dentro de una frase: "con un IMC de 27 se sitúa en sobrepeso, por lo que…", nunca "IMC: 27" suelto en una lista.
- Conectá los hallazgos entre sí (causa-efecto, contraste, evolución): qué sugiere la tendencia del peso, cómo responde a la terapia, qué correlaciona con qué.
- Si hay análisis previos del paciente, contrastá: qué mejoró, qué empeoró o qué cambió desde la última evaluación. Si no los hay, no los inventes.
- Solo usás los datos provistos; si falta algo relevante, decí "Dato faltante" en la narrativa en lugar de inventar.
- Sé concreto con números cuando interpreten: dosis, gramos de proteína, kg perdidos, ritmo de pérdida.
- Priorizás seguridad: no suspendas ni cambies medicación sin indicación médica; marcá señales de alerta.
- No reemplazás el juicio clínico del médico: cerrás con impresión y plan, dejando la decisión explícita.

Estructura obligatoria de tu respuesta:
## Presentación del caso
(Párrafos de prosa: quién es el paciente, contexto clínico, evolución antropométrica y de composición corporal interpretadas — no enumeradas — y cómo se llega al momento actual.)
## Análisis e interpretación
(Párrafos de prosa: terapia con péptidos y medicación y su respuesta o adherencia, composición corporal y riesgo abdominal, signos vitales y alertas; contrastá con los análisis previos si existen. Conectá hallazgos entre sí.)
## Impresión clínica y plan para el médico
(Impresión integrada en prosa y luego el plan accionable en viñetas: medidas personalizadas — proteína diaria, déficit calórico, actividad, sueño, hidratación —, qué vigilar, con qué frecuencia reevaluar y qué falta medir. Cerrá con cualquier advertencia o dato faltante.)`;

function getFetch() {
  if (typeof fetch === 'function') return fetch;
  try { return require('node-fetch'); } catch (_) { return null; }
}

const arr = (v) => (Array.isArray(v) ? v : []);

// Copia "clínica" del paciente: solo campos relevantes para el análisis.
// El cliente ya sanea, pero el body no es confiable, así que se vuelve a
// filtrar aquí (defensa en profundidad). Descarta datos de sistema
// (notificationIds, notify, emailStatus…), datos de contacto y archives
// analíticos viejos que podrían mencionar registros ya eliminados.
function sanitizePatientForAi(patient) {
  if (!patient || typeof patient !== 'object' || !patient.id) return null;

  const recentAnalyses = arr(patient.analyses)
    .slice()
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
    .slice(0, 3)
    .map((a) => ({
      createdAt: a.createdAt || null,
      summary: String(a.summary || '').slice(0, 300),
      content: String(a.content || '').slice(0, 3000),
    }));

  return {
    id: patient.id,
    name: patient.name || '',
    sex: patient.sex ?? null,
    age: patient.age ?? null,
    heightCm: patient.heightCm ?? null,
    initialWeightKg: patient.initialWeightKg ?? null,
    goalWeightKg: patient.goalWeightKg ?? null,
    injectionMed: patient.injectionMed || null,
    measurements: arr(patient.measurements).map((m) => ({
      date: m.date || null,
      weightKg: m.weightKg ?? null,
      heightCm: m.heightCm ?? null,
      goalWeightKg: m.goalWeightKg ?? null,
      waistCm: m.waistCm ?? null,
      wristCm: m.wristCm ?? null,
      hipCm: m.hipCm ?? null,
      bustCm: m.bustCm ?? null,
      rightArmCm: m.rightArmCm ?? null,
      leftArmCm: m.leftArmCm ?? null,
      rightThighCm: m.rightThighCm ?? null,
      leftThighCm: m.leftThighCm ?? null,
      rightCalfCm: m.rightCalfCm ?? null,
      leftCalfCm: m.leftCalfCm ?? null,
      bpSystolic: m.bpSystolic ?? null,
      bpDiastolic: m.bpDiastolic ?? null,
      heartRate: m.heartRate ?? null,
      temperature: m.temperature ?? null,
      spo2: m.spo2 ?? null,
      glucose: m.glucose ?? null,
      notes: m.notes || '',
    })),
    injections: arr(patient.injections).map((i) => ({
      date: i.date || null,
      dose: i.dose || '',
      site: i.site || '',
      notes: i.notes || '',
      doseIncreased: !!i.doseIncreased,
    })),
    medications: arr(patient.medications).map((m) => ({
      name: m.name || '',
      dose: m.dose || '',
      frequency: m.frequency || '',
      startDate: m.startDate || null,
      endDate: m.endDate || null,
      active: m.active !== false,
      reason: m.reason || '',
      notes: m.notes || '',
      changeHistory: arr(m.changeHistory).map((c) => ({
        date: c.date || null,
        type: c.type || null,
        previousDose: c.previousDose || null,
        newDose: c.newDose || null,
        reason: c.reason || '',
      })),
    })),
    appointments: arr(patient.appointments).map((a) => ({
      kind: a.kind || 'cita',
      date: a.date || null,
      time: a.time || null,
      status: a.status || 'pending',
      notes: a.notes || '',
      message: a.message || '',
    })),
    analyses: recentAnalyses,
  };
}

function buildUserPrompt({ patient, metrics, recommendations }) {
  const payload = {
    paciente: sanitizePatientForAi(patient) || {},
    metricas_calculadas: metrics,
    recomendaciones_actuales: recommendations,
  };
  return `Presentá al siguiente paciente como un caso clínico narrado (estilo presentación de caso en guardia).\n\nDatos del caso:\n${JSON.stringify(payload, null, 2)}\n\nUsá las métricas_calculadas y recomendaciones_actuales solo como referencia para tu razonamiento e interpretación; no las transcribas como listado.`;
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
          temperature: 0.6,
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
// Exportado para pruebas.
module.exports.sanitizePatientForAi = sanitizePatientForAi;
