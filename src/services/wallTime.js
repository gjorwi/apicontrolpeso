// Utilidades de "hora de pared" (hora local de la clínica) compartidas por el
// scheduler y el módulo de encuestas. Todo lo que el usuario ve (fechas de
// correos, días L/M/V, horas de envío) se interpreta en APPT_TIMEZONE.
const APPT_TIMEZONE = process.env.APPT_TIMEZONE || 'UTC';

function pad2(n) {
  return String(n).padStart(2, '0');
}

// Convierte una hora "de pared" local (y,mes0,d,hh,mm) al instante UTC real
// teniendo en cuenta la zona horaria (y DST) configurada.
function wallToUtc(tz, y, m0, d, hh, mm) {
  const wallMs = Date.UTC(y, m0, d, hh, mm);
  if (!tz || tz === 'UTC' || tz === 'Etc/UTC') return wallMs;
  let utcGuess = wallMs;
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    for (let i = 0; i < 3; i++) {
      const parts = fmt.formatToParts(new Date(utcGuess));
      const map = {};
      for (const p of parts) map[p.type] = p.value;
      const guessWall = Date.UTC(
        Number(map.year), Number(map.month) - 1, Number(map.day),
        Number(map.hour) % 24, Number(map.minute)
      );
      const delta = guessWall - utcGuess;
      utcGuess = wallMs - delta;
    }
    const parts = fmt.formatToParts(new Date(utcGuess));
    const map = {};
    for (const p of parts) map[p.type] = p.value;
    const back = Date.UTC(
      Number(map.year), Number(map.month) - 1, Number(map.day),
      Number(map.hour) % 24, Number(map.minute)
    );
    return Math.abs(back - wallMs) <= 3600000 ? utcGuess : wallMs;
  } catch (e) {
    return wallMs;
  }
}

// Fecha 'YYYY-MM-DD' (hora de pared) de un instante.
function wallDateStr(date, tz = APPT_TIMEZONE) {
  try {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric', month: '2-digit', day: '2-digit',
    });
    return fmt.format(date);
  } catch (e) {
    return date.toISOString().slice(0, 10);
  }
}

// Hora 'HH:MM' (hora de pared) de un instante.
function wallTimeOfDay(date, tz = APPT_TIMEZONE) {
  try {
    const fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      hour12: false,
      hour: '2-digit', minute: '2-digit',
    });
    return fmt.format(date);
  } catch (e) {
    return `${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}`;
  }
}

// Día de la semana en hora de pared: 0=domingo .. 6=sábado.
const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
function wallWeekday(date, tz = APPT_TIMEZONE) {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' });
    return WEEKDAYS[fmt.format(date)] ?? date.getUTCDay();
  } catch (e) {
    return date.getUTCDay();
  }
}

function dateLabelLong(dateStr) {
  const date = new Date(String(dateStr) + 'T00:00:00');
  return isNaN(date.getTime())
    ? String(dateStr)
    : date.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

// 'HH:MM' -> minutos desde medianoche (para comparar horas del día).
function minutesOf(timeStr) {
  const m = String(timeStr || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return 0;
  return Number(m[1]) * 60 + Number(m[2]);
}

module.exports = {
  APPT_TIMEZONE,
  pad2,
  wallToUtc,
  wallDateStr,
  wallTimeOfDay,
  wallWeekday,
  dateLabelLong,
  minutesOf,
};
