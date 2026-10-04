// Evaluación de los reportes/encuestas con criterio médico (DeepSeek).
// Se ejecuta en segundo plano después de guardar la respuesta: si falla, la
// respuesta del paciente queda guardada igualmente (aiStatus='error').
const { DEFAULT_CONFIG } = require('../config/survey');

const DEFAULT_BASE_URL = 'https://api.deepseek.com';
const TIMEOUT_MS = Number(process.env.AI_SURVEY_TIMEOUT_MS) || 60000;

const LEVELS = ['ok', 'seguimiento', 'urgente'];

const SYSTEM_PROMPT = `Eres "Susam", profesional de la salud especializado en control de peso y terapias con péptidos (semaglutida, tirzepatida, liraglutida, dulaglutida, etc.).

Recibes el REPORTES DE SEGUIMIENTO semanal de un paciente (preguntas de opción múltiple respondidas por el paciente) junto con datos clínicos resumidos. Tu tarea es hacer TRIAJE: decidir si ese reporte requiere la atención del médico que lo está siguiendo.

Reglas:
- Respondés SIEMPRE en español.
- Solo usás la información provista. No inventes síntomas ni diagnósticos.
- Priorizás la seguridad clínica: vómitos persistentes, dolor abdominal intenso, dolor de cabeza intenso, palpitaciones/falta de aire/dolor en el pecho, ausencia de toma del medicamento, o una combinación de síntomas que sugiera intolerancia al tratamiento deben elevar el nivel.
- Un reporte con molestias leves o respuestas intermedias (estreñimiento, náuseas leves, baja adherencia, poca agua) va a nivel "seguimiento": el médico lo revisa cuando pueda, no requiere llamada inmediata.
- Si todo es normal y el tratamiento va bien, nivel "ok".
- "motivo": una sola frase corta y concreta (máx 180 caracteres) que explique al médico por qué se lo alertás, o por qué está todo bien si es nivel ok.
- "accion": una sola frase concreta con lo que el médico debería hacer (ej: "Llamar al paciente para evaluar náuseas", "Continuar con el seguimiento habitual").
- "alerta": true SOLO si el médico debería actuar pronto (llamar, revisar el caso hoy o ajustar tratamiento). Nivel "urgente" implica alerta true; nivel "ok" implica alerta false.

Respondé EXCLUSIVAMENTE con un objeto JSON válido con esta forma:
{"alerta": true|false, "nivel": "ok"|"seguimiento"|"urgente", "motivo": "...", "accion": "..."}`;

function getFetch() {
  if (typeof fetch === 'function') return fetch;
  try { return require('node-fetch'); } catch (_) { return null; }
}

const arr = (v) => (Array.isArray(v) ? v : []);

// Resumen clínico mínimo para el triaje (no se filtra todo el historial:
// para el reporte basta contexto reciente + medicación activa).
function buildPatientSummary(patient) {
  if (!patient) return {};
  const measurements = arr(patient.measurements)
    .slice()
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))
    .slice(0, 3)
    .map((m) => ({
      date: m.date || null,
      weightKg: m.weightKg ?? null,
      waistCm: m.waistCm ?? null,
      bpSystolic: m.bpSystolic ?? null,
      bpDiastolic: m.bpDiastolic ?? null,
      heartRate: m.heartRate ?? null,
      glucose: m.glucose ?? null,
    }));

  return {
    name: patient.name || '',
    sex: patient.sex ?? null,
    age: patient.age ?? null,
    heightCm: patient.heightCm ?? null,
    initialWeightKg: patient.initialWeightKg ?? null,
    goalWeightKg: patient.goalWeightKg ?? null,
    injectionMed: patient.injectionMed || null,
    deficit: patient.deficit ?? null,
    medications: arr(patient.medications)
      .filter((m) => m.active !== false)
      .map((m) => ({ name: m.name || '', dose: m.dose || '', frequency: m.frequency || '', reason: m.reason || '' })),
    recentMeasurements: measurements,
  };
}

function buildQuestionsAndAnswers(config, answers) {
  const questions = arr(config?.questions);
  return questions.map((q) => {
    const given = arr(answers).find((a) => a.questionId === q.id);
    if (!given) return { pregunta: q.text, respuesta: '(sin respuesta)' };
    if (q.type === 'text') {
      const text = String(given.value || '').trim();
      return { pregunta: q.text, respuesta: text || '(sin respuesta)' };
    }
    const opt = arr(q.options).find((o) => o.value === given.value);
    return { pregunta: q.text, respuesta: (opt && opt.label) || String(given.value || '') };
  });
}

function levelRank(level) {
  const i = LEVELS.indexOf(level);
  return i < 0 ? 0 : i;
}

// Nivel por regla local (severidad de las opciones elegidas): sirve de
// respaldo si la IA falla y complementa su juicio.
function computeRuleLevel(config, answers) {
  let rank = 0;
  for (const a of arr(answers)) {
    const q = arr(config?.questions).find((x) => x.id === a.questionId);
    if (!q || q.type === 'text') continue;
    const opt = arr(q.options).find((o) => o.value === a.value);
    if (!opt) continue;
    rank = Math.max(rank, levelRank(opt.severity));
  }
  return LEVELS[rank];
}

function maxLevel(a, b) {
  return levelRank(a) >= levelRank(b) ? a : b;
}

function parseAiJson(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) text = fence[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) text = text.slice(start, end + 1);
  try {
    const obj = JSON.parse(text);
    if (!obj || typeof obj !== 'object') return null;
    const nivel = LEVELS.includes(obj.nivel) ? obj.nivel : 'seguimiento';
    return {
      alerta: obj.alerta === true || obj.alerta === 'true' || nivel === 'urgente',
      nivel,
      motivo: String(obj.motivo || '').slice(0, 300),
      accion: String(obj.accion || '').slice(0, 300),
    };
  } catch (e) {
    return null;
  }
}

// Evalúa un reporte. Devuelve { alerta, nivel, motivo, accion, model, evaluatedAt }
// o lanza Error con .code (AI_NOT_CONFIGURED | AI_UPSTREAM_ERROR | ...).
async function evaluateSurvey({ patient, config, answers }) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    const e = new Error('El servidor no tiene DEEPSEEK_API_KEY configurada.');
    e.code = 'AI_NOT_CONFIGURED';
    throw e;
  }
  const fetchFn = getFetch();
  if (!fetchFn) {
    const e = new Error('El servidor no dispone de fetch (Node >= 18).');
    e.code = 'NO_FETCH';
    throw e;
  }

  const payload = {
    paciente: buildPatientSummary(patient),
    reporte_de_seguimiento: buildQuestionsAndAnswers(config || DEFAULT_CONFIG, answers),
  };

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
          { role: 'user', content: `Datos del caso y reporte:\n${JSON.stringify(payload, null, 2)}` },
        ],
        temperature: 0.2,
        max_tokens: 400,
        stream: false,
        response_format: { type: 'json_object' },
      }),
      signal: controller.signal,
    });
  } catch (e) {
    if (e && (e.name === 'AbortError' || e.name === 'TimeoutError')) {
      const err = new Error('El modelo tardó demasiado en responder.');
      err.code = 'AI_TIMEOUT';
      throw err;
    }
    const err = new Error('No se pudo contactar al modelo.');
    err.code = 'AI_UPSTREAM_ERROR';
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => '');
    console.error(`[surveyAi] DeepSeek status=${upstream.status} body=${text.slice(0, 300)}`);
    const err = new Error(`DeepSeek status=${upstream.status}`);
    err.code = upstream.status === 429 ? 'AI_RATE_LIMIT' : 'AI_UPSTREAM_ERROR';
    throw err;
  }

  const data = await upstream.json().catch(() => null);
  const content = data?.choices?.[0]?.message?.content;
  if (!content) {
    const err = new Error('El modelo no devolvió contenido.');
    err.code = 'AI_EMPTY_RESPONSE';
    throw err;
  }

  const parsed = parseAiJson(content);
  if (!parsed) {
    const err = new Error('No se pudo interpretar la respuesta del modelo.');
    err.code = 'AI_PARSE_ERROR';
    throw err;
  }

  return {
    ...parsed,
    model: data.model || process.env.DEEPSEEK_MODEL || 'deepseek-chat',
    evaluatedAt: new Date().toISOString(),
  };
}

module.exports = {
  evaluateSurvey,
  computeRuleLevel,
  maxLevel,
  buildPatientSummary,
  parseAiJson,
};
