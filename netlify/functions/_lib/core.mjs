// Pure scheduling helpers (no storage), so they can be tested on their own.
import { RULES } from './catalog.mjs';

const pad = n => String(n).padStart(2, '0');

// Current date and minutes-after-midnight in New York.
export function nyNow(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: RULES.timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(now).map(p => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, min: Number(parts.hour) * 60 + Number(parts.minute) };
}

export function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

export function weekday(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export const isDate = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
export const toHHMM = min => `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;
export function fromHHMM(s) {
  if (typeof s !== 'string' || !/^\d{2}:\d{2}$/.test(s)) return null;
  const [h, m] = s.split(':').map(Number);
  return h < 24 && m < 60 ? h * 60 + m : null;
}

// Time an entry occupies, including drive buffer after jobs.
function busy(e) {
  return [e.start, e.end + (e.type === 'booking' ? RULES.bufferMin : 0)];
}

// Open start times for one date for a job of `mins` minutes.
export function slotsFor(dateStr, mins, entries, now = new Date()) {
  const hours = RULES.hours[weekday(dateStr)];
  if (!hours) return [];
  const n = nyNow(now);
  const last = addDays(n.date, RULES.windowDays);
  if (dateStr < n.date || dateStr > last) return [];
  // earliest bookable moment, as (date, minute) in NY
  const leadMin = n.min + RULES.leadHours * 60;
  const earliestDate = addDays(n.date, Math.floor(leadMin / 1440));
  const earliestMin = leadMin % 1440;
  const dayBusy = entries.filter(e => e.date === dateStr && e.status !== 'cancelled').map(busy);
  const out = [];
  for (let s = hours[0]; s + mins <= hours[1]; s += RULES.slotStep) {
    if (dateStr < earliestDate || (dateStr === earliestDate && s < earliestMin)) continue;
    const mine = [s, s + mins + RULES.bufferMin];
    if (dayBusy.some(([a, b]) => mine[0] < b && a < mine[1])) continue;
    out.push(toHHMM(s));
  }
  return out;
}

export function allSlots(mins, entries, now = new Date()) {
  const start = nyNow(now).date;
  const days = {};
  for (let i = 0; i <= RULES.windowDays; i++) {
    const d = addDays(start, i);
    const s = slotsFor(d, mins, entries, now);
    if (s.length) days[d] = s;
  }
  return days;
}

// UTC timestamp (ms) for a New York local date + minute.
export function nyToUtc(dateStr, min) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, Math.floor(min / 60), min % 60);
  const seen = nyNow(new Date(guess));
  const [sy, sm, sd] = seen.date.split('-').map(Number);
  const diff = (Date.UTC(sy, sm - 1, sd) - Date.UTC(y, m - 1, d)) / 60000 + seen.min - min;
  return guess - diff * 60000;
}

const icsDate = ms => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const icsText = s => String(s || '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/[,;]/g, m => '\\' + m);

export function icsCalendar(entries, name = 'JF AutoSpa bookings') {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//JF AutoSpa//Bookings//EN', 'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH', `X-WR-CALNAME:${icsText(name)}`, 'X-PUBLISHED-TTL:PT15M', 'REFRESH-INTERVAL;VALUE=DURATION:PT15M'];
  const stamp = icsDate(Date.now());
  for (const e of entries) {
    if (e.status === 'cancelled') continue;
    const title = e.type === 'booking' ? `${e.pkgName} – ${e.name}` : (e.label || 'Blocked');
    const desc = e.type === 'booking'
      ? [`${e.phone}${e.email ? ' · ' + e.email : ''}`, `Vehicle: ${e.vehicle}`, `Add-ons: ${e.addonNames?.length ? e.addonNames.join(', ') : 'none'}`,
         `Estimate: $${e.lo}–$${e.hi}${e.plus ? '+' : ''}`, `Parking: ${e.parking || '-'}`, `Condition: ${e.condition || '-'}`, e.notes ? `Notes: ${e.notes}` : ''].filter(Boolean).join('\n')
      : '';
    lines.push('BEGIN:VEVENT', `UID:${e.id}@jfautospa.com`, `DTSTAMP:${stamp}`,
      `DTSTART:${icsDate(nyToUtc(e.date, e.start))}`, `DTEND:${icsDate(nyToUtc(e.date, Math.min(e.end, 1439)))}`,
      `SUMMARY:${icsText(title)}`);
    if (e.type === 'booking') lines.push(`LOCATION:${icsText(`${e.address}, ${e.zip}`)}`);
    if (desc) lines.push(`DESCRIPTION:${icsText(desc)}`);
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  // fold long lines to 75 octets (approx by chars)
  return lines.map(l => l.length > 74 ? l.match(/.{1,73}/g).join('\r\n ') : l).join('\r\n') + '\r\n';
}
