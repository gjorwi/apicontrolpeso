// Cuestionario de seguimiento (reporte de paciente) y política de envío.
// Es la fuente por defecto: puede sobrescribirse desde la base de datos vía
// surveyStore.saveConfig() (Configuración en la app del médico) sin redeploy.
//
// severity por opción (usado como regla local además del juicio de la IA):
//   'ok'          -> sin observación
//   'seguimiento' -> algo que el médico querría revisar
//   'urgente'     -> señal de alerta que dispara push al médico
const DEFAULT_CONFIG = {
  version: 1,
  enabled: true,
  // 0=domingo .. 6=sábado. Lunes, miércoles y viernes.
  days: [1, 3, 5],
  time: '09:00',        // envío automático del correo
  digestTime: '18:00',  // push al médico con los pendientes del día
  lateUntil: '21:00',   // máximo margen si el servidor estuvo dormido
  ttlHours: 72,         // vigencia del link de la encuesta
  signature: 'Doctora Flor',
  questions: [
    {
      id: 'q_agua',
      text: '¿Ha tomado suficiente agua estos días?',
      type: 'single',
      required: true,
      options: [
        { value: 'poca', label: 'Poca', severity: 'seguimiento' },
        { value: 'normal', label: 'Normal', severity: 'ok' },
        { value: 'mucha', label: 'Mucha', severity: 'ok' },
      ],
    },
    {
      id: 'q_estrenimiento',
      text: '¿Ha tenido estreñimiento?',
      type: 'single',
      required: true,
      options: [
        { value: 'si', label: 'Sí', severity: 'seguimiento' },
        { value: 'no', label: 'No', severity: 'ok' },
        { value: 'alternado', label: 'Alternado (a veces sí, a veces no)', severity: 'seguimiento' },
      ],
    },
    {
      id: 'q_nauseas',
      text: '¿Ha sentido náuseas, vómitos o mareos?',
      type: 'single',
      required: true,
      options: [
        { value: 'ninguno', label: 'Ninguno', severity: 'ok' },
        { value: 'nauseas', label: 'Náuseas', severity: 'seguimiento' },
        { value: 'vomito', label: 'Vómitos', severity: 'urgente' },
        { value: 'mareo', label: 'Mareos', severity: 'seguimiento' },
      ],
    },
    {
      id: 'q_alimentacion',
      text: '¿Ha comido de forma saludable esta semana?',
      type: 'single',
      required: true,
      options: [
        { value: 'si', label: 'Sí', severity: 'ok' },
        { value: 'regular', label: 'Regular', severity: 'seguimiento' },
        { value: 'no', label: 'No', severity: 'seguimiento' },
      ],
    },
    {
      id: 'q_comidas',
      text: '¿Cuántas veces al día come?',
      type: 'single',
      required: true,
      options: [
        { value: '1_o_menos', label: '1 vez o menos', severity: 'seguimiento' },
        { value: '2_3', label: '2 a 3 veces', severity: 'ok' },
        { value: '4_5', label: '4 a 5 veces', severity: 'ok' },
        { value: '6_o_mas', label: '6 veces o más', severity: 'seguimiento' },
      ],
    },
    {
      id: 'q_horas',
      text: '¿Come a las horas correspondientes?',
      type: 'single',
      required: true,
      options: [
        { value: 'siempre', label: 'Siempre', severity: 'ok' },
        { value: 'casi', label: 'Casi siempre', severity: 'seguimiento' },
        { value: 'no', label: 'No', severity: 'seguimiento' },
      ],
    },
    {
      id: 'q_energia',
      text: '¿Cómo ha estado su energía?',
      type: 'single',
      required: true,
      options: [
        { value: 'normal', label: 'Normal', severity: 'ok' },
        { value: 'baja', label: 'Baja', severity: 'seguimiento' },
        { value: 'muy_baja', label: 'Muy baja', severity: 'seguimiento' },
      ],
    },
    {
      id: 'q_medicamento',
      text: '¿Ha tomado su medicamento correctamente?',
      type: 'single',
      required: true,
      options: [
        { value: 'todas', label: 'Todas las dosis', severity: 'ok' },
        { value: 'algunas', label: 'Omití algunas dosis', severity: 'seguimiento' },
        { value: 'ninguna', label: 'No lo tomé', severity: 'seguimiento' },
        { value: 'no_aplica', label: 'No me corresponde', severity: 'ok' },
      ],
    },
    {
      id: 'q_digestion',
      text: '¿Ha tenido dolor abdominal o diarrea?',
      type: 'single',
      required: true,
      options: [
        { value: 'ninguno', label: 'Ninguno', severity: 'ok' },
        { value: 'leve', label: 'Leve', severity: 'seguimiento' },
        { value: 'intenso', label: 'Intenso', severity: 'urgente' },
      ],
    },
    {
      id: 'q_cabeza',
      text: '¿Ha tenido dolor de cabeza?',
      type: 'single',
      required: true,
      options: [
        { value: 'ninguno', label: 'Ninguno', severity: 'ok' },
        { value: 'leve', label: 'Leve', severity: 'seguimiento' },
        { value: 'intenso', label: 'Intenso', severity: 'urgente' },
      ],
    },
    {
      id: 'q_alerta',
      text: '¿Ha sentido palpitaciones, falta de aire o dolor en el pecho?',
      type: 'single',
      required: true,
      options: [
        { value: 'ninguno', label: 'Ninguno', severity: 'ok' },
        { value: 'leve', label: 'Algo leve', severity: 'seguimiento' },
        { value: 'si', label: 'Sí', severity: 'urgente' },
      ],
    },
    {
      id: 'q_efecto',
      text: '¿Ha notado que el medicamento está haciendo efecto?',
      type: 'single',
      required: true,
      options: [
        { value: 'si', label: 'Sí', severity: 'ok' },
        { value: 'no', label: 'No', severity: 'seguimiento' },
        { value: 'no_se', label: 'No sé', severity: 'ok' },
      ],
    },
    {
      id: 'q_comentario',
      text: '¿Hay algo más que quiera informar?',
      type: 'text',
      required: false,
      maxLength: 300,
      placeholder: 'Opcional (puede dejarlo vacío)',
    },
  ],
};

module.exports = { DEFAULT_CONFIG };
