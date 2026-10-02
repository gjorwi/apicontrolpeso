// Motor de ocurrencias de recordatorios de medicamentos (CommonJS).
//
// La lógica es idéntica a utils/reminders.js de la app (ESM, no importable
// desde aquí). Si se modifica una, modificar la otra.

const DAY_MS = 86400000;

function pad2(n) {
  return String(n).padStart(2, '0');
}

function parseDateStr(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ''));
  if (!m) return null;
  return { y: Number(m[1]), m0: Number(m[2]) - 1, d: Number(m[3]) };
}

function fmtDateStr(p) {
  if (!p) return '';
  return `${p.y}-${pad2(p.m0 + 1)}-${pad2(p.d)}`;
}

function toUTCms(p) {
  return Date.UTC(p.y, p.m0, p.d);
}

function daysInMonth(y, m0) {
  return new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate();
}

function clampDay(y, m0, d) {
  return Math.min(d, daysInMonth(y, m0));
}

function clampInt(v, min, max, dflt) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

// 'HH:MM' → ms del día (medianoche = 0).
function timeOfDayMs(time) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(time || ''));
  if (!m) return 0;
  return Number(m[1]) * 3600000 + Number(m[2]) * 60000;
}

// Parámetros de la frecuencia "por horas" con defaults/recortes.
// Intervalo acotado a 2–24 h: en medicación no se toma "cada hora".
function hourlyParams(reminder) {
  return {
    intervalHours: clampInt(reminder.intervalHours, 2, 24, 8),
    durationDays: clampInt(reminder.durationDays, 1, 365, 7),
  };
}

function isOccurrence(reminder, dateStr) {
  if (!reminder || reminder.active === false) return false;
  const p = parseDateStr(dateStr);
  const start = parseDateStr(reminder.startDate);
  if (!p || !start) return false;
  const t0 = toUTCms(p);
  const s0 = toUTCms(start);
  if (t0 < s0) return false;
  const end = parseDateStr(reminder.endDate);
  const endMs = end ? toUTCms(end) : null;

  switch (reminder.frequency) {
    case 'daily':
      return endMs == null || t0 <= endMs;
    case 'interval': {
      if (endMs != null && t0 > endMs) return false;
      const step = Math.max(1, Math.round(Number(reminder.intervalDays) || 1));
      const diff = Math.round((t0 - s0) / DAY_MS);
      return diff % step === 0;
    }
    case 'weekly': {
      const weeks = Math.max(1, Math.round(Number(reminder.weeks) || 1));
      if (t0 >= s0 + weeks * 7 * DAY_MS) return false;
      const wd = new Date(t0).getUTCDay();
      return (Array.isArray(reminder.daysOfWeek) ? reminder.daysOfWeek : []).includes(wd);
    }
    case 'monthly': {
      const months = Math.max(1, Math.round(Number(reminder.months) || 1));
      const moDiff = (p.y - start.y) * 12 + (p.m0 - start.m0);
      if (moDiff < 0 || moDiff >= months) return false;
      const days = Array.isArray(reminder.daysOfMonth) ? reminder.daysOfMonth : [];
      return days.some((dd) => clampDay(p.y, p.m0, dd) === p.d);
    }
    case 'annual': {
      const years = Math.max(1, Math.round(Number(reminder.years) || 1));
      const yDiff = p.y - start.y;
      if (yDiff < 0 || yDiff >= years) return false;
      return p.m0 === start.m0 && p.d === clampDay(p.y, p.m0, start.d);
    }
    case 'hourly': {
      // Ventana [anchor, anchor + durationDays*24h) con pasos cada
      // intervalHours. ¿Caen en este día (medianoche a medianoche) al
      // menos una ocurrencia?
      const { intervalHours, durationDays } = hourlyParams(reminder);
      const anchor = s0 + timeOfDayMs(reminder.time);
      const winEnd = anchor + durationDays * DAY_MS;
      const from = Math.max(anchor, t0);
      const to = Math.min(winEnd, t0 + DAY_MS);
      if (from >= to) return false;
      const step = intervalHours * 3600000;
      const k = Math.ceil((from - anchor) / step);
      return anchor + k * step < to;
    }
    default:
      return false;
  }
}

// Horas 'HH:MM' a las que el recordatorio dispara en la fecha dada.
// Para "hourly" puede devolver varias horas en el mismo día.
function occurrencesOn(reminder, dateStr) {
  if (!reminder || reminder.active === false) return [];
  if (reminder.frequency === 'hourly') {
    const p = parseDateStr(dateStr);
    const start = parseDateStr(reminder.startDate);
    if (!p || !start) return [];
    const time = String(reminder.time || '').trim();
    if (!/^\d{1,2}:\d{2}$/.test(time)) return [];
    const { intervalHours, durationDays } = hourlyParams(reminder);
    const anchor = toUTCms(start) + timeOfDayMs(time);
    const winEnd = anchor + durationDays * DAY_MS;
    const step = intervalHours * 3600000;
    const dayStart = toUTCms(p);
    const k0 = Math.max(0, Math.ceil((dayStart - anchor) / step));
    const out = [];
    for (let k = k0; ; k++) {
      const occ = anchor + k * step;
      if (occ >= winEnd || occ >= dayStart + DAY_MS) break;
      if (occ >= dayStart) {
        out.push(`${pad2(Math.floor(occ / 3600000) % 24)}:${pad2(Math.floor(occ / 60000) % 60)}`);
      }
    }
    return out;
  }
  if (!isOccurrence(reminder, dateStr)) return [];
  const time = String(reminder.time || '').trim();
  return /^\d{1,2}:\d{2}$/.test(time) ? [time] : [];
}

module.exports = { isOccurrence, occurrencesOn };
