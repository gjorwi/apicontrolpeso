// Evaluación de los reportes con IA (criterio médico) y aviso al médico.
// Vive en services/ (no en routes/) para que el scheduler pueda reintentar
// evaluaciones que quedaron 'pending' si el proceso se cae durante la llamada
// a DeepSeek (Render free se duerme). La ruta /api/submit importa desde aquí.
const surveyStore = require('./surveyStore');
const surveyJobs = require('./surveyJobs');
const { evaluateSurvey, computeRuleLevel, maxLevel } = require('./surveyAi');
const deviceStore = require('./deviceStore');
const { sendPushBatch } = require('./pushService');
const { firstName } = require('./surveyEmail');

async function pushAlert({ patientId, responseId, nivel, motivo, patientName }) {
  try {
    const devices = (await deviceStore.listAllDevices()).filter((d) => d.pushToken);
    if (!devices.length) return 0;
    const name = firstName(patientName) || patientName || 'Paciente';
    const title = nivel === 'urgente' ? `🔴 Alerta de reporte: ${name}` : `⚠ Reporte con observación: ${name}`;
    const body = String(motivo || 'Revisar el reporte de seguimiento del paciente.').slice(0, 250);
    const res = await sendPushBatch(
      devices.map((d) => ({
        token: d.pushToken,
        title,
        body,
        data: { type: 'survey_alert', patientId, responseId, nivel },
      }))
    );
    return res?.sent || 0;
  } catch (e) {
    console.error('[survey] pushAlert FAIL:', e.message);
    return 0;
  }
}

// Evalúa el reporte con la IA (en segundo plano) y avisa al médico si hay
// complicación. Nunca rompe la respuesta HTTP del paciente.
// `alreadyAlerted`: true si este reporte YA disparó una alerta push (reintentos),
// así no se vuelve a notificar el mismo caso.
async function evaluateAndNotify({ responseId, patient, patientName, config, answers, alreadyAlerted = false }) {
  const ruleLevel = computeRuleLevel(config, answers);
  try {
    const ai = await evaluateSurvey({ patient, config, answers });
    const nivel = maxLevel(ai.nivel, ruleLevel);
    const alerta = ai.alerta === true || nivel === 'urgente';
    await surveyStore.updateResponseAi(responseId, { ...ai, nivel, alerta, ruleLevel }, 'ok');
    if (alerta && !alreadyAlerted) {
      await pushAlert({
        patientId: patient?.id,
        responseId,
        nivel,
        motivo: ai.motivo,
        patientName,
      });
    }
    console.log(`[survey] ai evaluated response=${responseId} nivel=${nivel} alerta=${alerta}`);
  } catch (e) {
    const alerta = ruleLevel === 'urgente';
    await surveyStore.updateResponseAi(
      responseId,
      {
        status: 'error',
        error: String(e.message || e).slice(0, 200),
        code: e.code || null,
        nivel: ruleLevel,
        alerta,
        ruleLevel,
        motivo: alerta ? 'Señal de alerta del cuestionario (la IA no pudo evaluar).' : '',
        accion: alerta ? 'Revisar el reporte del paciente.' : '',
        evaluatedAt: new Date().toISOString(),
      },
      'error'
    );
    if (alerta && !alreadyAlerted) {
      await pushAlert({
        patientId: patient?.id,
        responseId,
        nivel: ruleLevel,
        motivo: 'Señal de alerta en el reporte del paciente.',
        patientName,
      });
    }
    console.error(`[survey] ai FAIL response=${responseId} code=${e.code} msg=${e.message}`);
  }
}

// Reintenta evaluaciones que quedaron pendientes o con error transitorio
// (p.ej. el proceso se cayó durante la llamada a DeepSeek). Limitado: pocas
// respuestas por tick y con antigüedad mínima, para no martillar la API.
async function retryPendingEvaluations({ limit = 3, minAgeMs = 120000 } = {}) {
  if (!process.env.DEEPSEEK_API_KEY) return { skipped: 'ai_not_configured' };
  const pending = await surveyStore.listResponsesNeedingAi({ minAgeMs, limit });
  if (!pending.length) return { retried: 0 };

  const config = await surveyStore.getConfig();
  let retried = 0;
  for (const r of pending) {
    try {
      const found = await surveyJobs.findPatient(r.patientId, r.deviceId);
      const patient = found?.patient || { id: r.patientId, name: r.patientName || '' };
      await evaluateAndNotify({
        responseId: r.responseId,
        patient,
        patientName: r.patientName || patient.name || '',
        config,
        answers: Array.isArray(r.answers) ? r.answers : [],
        alreadyAlerted: !!(r.ai && r.ai.alerta === true),
      });
      retried += 1;
    } catch (e) {
      console.error(`[survey] ai retry FAIL response=${r.responseId}:`, e.message);
    }
  }
  console.log(`[survey] ai retry found=${pending.length} retried=${retried}`);
  return { retried, found: pending.length };
}

module.exports = {
  pushAlert,
  evaluateAndNotify,
  retryPendingEvaluations,
};
