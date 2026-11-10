'use strict';
// Timezone helpers built on Intl (no dependencies). All instants are Date
// objects in UTC; "local" values are plain 'YYYY-MM-DD' / 'HH:MM' strings
// interpreted in an IANA timezone.

const fmtCache = new Map();
function partsFormatter(tz) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

function isValidTimeZone(tz) {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

function localParts(date, tz) {
  const out = {};
  for (const p of partsFormatter(tz).formatToParts(date)) out[p.type] = p.value;
  return {
    year: +out.year, month: +out.month, day: +out.day,
    hour: +out.hour, minute: +out.minute, second: +out.second,
  };
}

// Offset (ms) of tz from UTC at the given instant.
function offsetMs(date, tz) {
  const p = localParts(date, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^(\d{2}):(\d{2})(?::(\d{2}))?$/;

function isDateStr(s) {
  const m = DATE_RE.exec(s || '');
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}
function isTimeStr(s) {
  const m = TIME_RE.exec(s || '');
  return !!m && +m[1] < 24 && +m[2] < 60 && (m[3] === undefined || +m[3] < 60);
}

// Local wall-clock time in tz -> UTC instant. For a wall time skipped by a DST
// jump, returns the instant just after the jump; for a repeated wall time,
// returns the first occurrence.
function zonedToUtc(dateStr, timeStr, tz) {
  const d = DATE_RE.exec(dateStr);
  const t = TIME_RE.exec(timeStr || '00:00');
  if (!d || !t) throw new Error(`Bad local date/time: ${dateStr} ${timeStr}`);
  const guess = Date.UTC(+d[1], +d[2] - 1, +d[3], +t[1], +t[2], +(t[3] || 0));
  const off1 = offsetMs(new Date(guess), tz);
  let utc = guess - off1;
  const off2 = offsetMs(new Date(utc), tz);
  if (off2 !== off1) {
    const alt = guess - off2;
    // Prefer the candidate whose local rendering matches the requested wall time.
    const p = localParts(new Date(alt), tz);
    utc = (p.hour === +t[1] && p.minute === +t[2]) ? alt : Math.max(utc, alt);
  }
  return new Date(utc);
}

function localDateStr(date, tz) {
  const p = localParts(date, tz);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

function addDays(dateStr, n) {
  const m = DATE_RE.exec(dateStr);
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + n));
  return d.toISOString().slice(0, 10);
}

// Normalise a pg `date` (string or Date) to 'YYYY-MM-DD'.
function toDateStr(v) {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}
function toTimeStr(v) { return String(v || '00:00').slice(0, 5); }

module.exports = {
  isValidTimeZone, localParts, offsetMs, zonedToUtc, localDateStr, addDays,
  isDateStr, isTimeStr, toDateStr, toTimeStr,
};
