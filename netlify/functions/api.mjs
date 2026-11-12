// JF AutoSpa booking API (Netlify Function, storage in Netlify Blobs).
//   Public:  GET /api/catalog, GET /api/slots, POST /api/book, GET /api/today
//   Owner:   /api/admin/*  (header x-admin-key = ADMIN_KEY env var)
//            GET /api/calendar.ics?key=ADMIN_KEY  (subscribe from your phone calendar)
import { getStore } from '@netlify/blobs';
import { RULES, PACKAGES, ADDONS, quote } from './_lib/catalog.mjs';
import { nyNow, addDays, isDate, fromHHMM, slotsFor, allSlots, icsCalendar } from './_lib/core.mjs';

const KEY = 'schedule';

function store() {
  return getStore({ name: 'jf-bookings', consistency: 'strong' });
}

async function readAll() {
  return (await store().get(KEY, { type: 'json' })) || [];
}

// Write, then read back to make sure nobody else's save replaced ours.
async function mutate(fn) {
  for (let i = 0; i < 4; i++) {
    const list = await readAll();
    const res = fn(list);
    if (res.error) return res;
    await store().setJSON(KEY, res.list);
    const check = await readAll();
    if (res.verify(check)) return res;
  }
  return { error: 'Busy right now. Please try again.', status: 503 };
}

const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...extra } });

const clean = (v, max = 200) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
const cleanMulti = (v, max = 1000) => String(v ?? '').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ').trim().slice(0, max);
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

function isOwner(req, url) {
  const want = process.env.ADMIN_KEY || (typeof Netlify !== 'undefined' ? Netlify.env.get('ADMIN_KEY') : '');
  if (!want || want.length < 6) return false;
  const got = req.headers.get('x-admin-key') || url.searchParams.get('key') || '';
  if (got.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= got.charCodeAt(i) ^ want.charCodeAt(i);
  return diff === 0;
}

function isFree(list, entry) {
  const free = slotsFor(entry.date, entry.end - entry.start, list.filter(e => e.id !== entry.id));
  return free.includes(String(Math.floor(entry.start / 60)).padStart(2, '0') + ':' + String(entry.start % 60).padStart(2, '0'));
}

export default async (req) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/api\/?/, '').replace(/\/$/, '');
  const method = req.method;

  try {
    // ---------- public ----------
    if (path === 'catalog' && method === 'GET') {
      return json({ packages: PACKAGES, addons: ADDONS, rules: { bufferMin: RULES.bufferMin, windowDays: RULES.windowDays } }, 200,
        { 'cache-control': 'public, max-age=300' });
    }

    if (path === 'slots' && method === 'GET') {
      const q = quote(url.searchParams.get('pkg'), (url.searchParams.get('addons') || '').split(',').filter(Boolean));
      if (!q) return json({ error: 'Unknown package or add-on.' }, 400);
      const list = await readAll();
      return json({ today: nyNow().date, mins: q.mins, days: allSlots(q.mins, list) });
    }

    if (path === 'book' && method === 'POST') {
      const b = await req.json().catch(() => null);
      if (!b) return json({ error: 'Bad request.' }, 400);
      if (b.website) return json({ ok: true, id: 'x' }); // honeypot: pretend success
      const q = quote(b.pkg, b.addons);
      if (!q) return json({ error: 'Please choose a package again.' }, 400);
      const start = fromHHMM(b.time);
      if (!isDate(b.date) || start === null) return json({ error: 'Please choose a date and time.' }, 400);
      const name = clean(b.name, 80), phone = clean(b.phone, 30), email = clean(b.email, 120);
      const address = clean(b.address, 160), zip = clean(b.zip, 10), vehicle = clean(b.vehicle, 100);
      if (!name || phone.replace(/\D/g, '').length < 10 || !address || !/^\d{5}$/.test(zip) || !vehicle)
        return json({ error: 'Please fill in your name, phone, address, ZIP code and vehicle.' }, 400);
      if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: 'That email address looks off.' }, 400);
      const entry = {
        id: newId(), type: 'booking', status: 'booked', createdAt: new Date().toISOString(),
        date: b.date, start, end: start + q.mins,
        pkg: q.pkg.id, pkgName: q.pkg.name, addons: q.addons.map(a => a.id), addonNames: q.addons.map(a => a.name),
        lo: q.lo, hi: q.hi, plus: q.plus,
        name, phone, email, address, zip, vehicle,
        parking: clean(b.parking, 40), condition: clean(b.condition, 40), notes: cleanMulti(b.notes, 1000)
      };
      const res = await mutate(list => {
        if (!isFree(list, entry)) return { error: 'Sorry, that time was just taken. Please pick another.', status: 409 };
        return { list: [...list, entry], verify: l => l.some(e => e.id === entry.id) };
      });
      if (res.error) return json({ error: res.error }, res.status || 400);
      return json({ ok: true, booking: entry });
    }

    if (path === 'today' && method === 'GET') {
      const t = await store().get('today', { type: 'json' });
      const town = t && t.date === nyNow().date ? t.town : '';
      return json({ town }, 200, { 'cache-control': 'public, max-age=60' });
    }

    // ---------- owner ----------
    if (path === 'calendar.ics' && method === 'GET') {
      if (!isOwner(req, url)) return new Response('Not found', { status: 404 });
      const from = addDays(nyNow().date, -30);
      const list = (await readAll()).filter(e => e.date >= from);
      return new Response(icsCalendar(list), { headers: { 'content-type': 'text/calendar; charset=utf-8', 'cache-control': 'no-store' } });
    }

    if (path.startsWith('admin/')) {
      if (!isOwner(req, url)) return json({ error: 'Wrong passcode.' }, 401);
      const action = path.slice(6);

      if (action === 'schedule' && method === 'GET') {
        const from = addDays(nyNow().date, -14);
        const list = (await readAll()).filter(e => e.date >= from).sort((a, b) => a.date.localeCompare(b.date) || a.start - b.start);
        const t = await store().get('today', { type: 'json' });
        return json({ today: nyNow().date, entries: list, town: t && t.date === nyNow().date ? t.town : '' });
      }

      const body = method === 'POST' ? await req.json().catch(() => ({})) : {};

      if (action === 'cancel' && method === 'POST') {
        const res = await mutate(list => {
          const i = list.findIndex(e => e.id === body.id);
          if (i < 0) return { error: 'Not found.', status: 404 };
          const next = list.slice();
          next[i] = { ...next[i], status: 'cancelled', cancelledAt: new Date().toISOString() };
          return { list: next, verify: l => l.find(e => e.id === body.id)?.status === 'cancelled' };
        });
        return res.error ? json({ error: res.error }, res.status) : json({ ok: true });
      }

      if (action === 'block' && method === 'POST') {
        const start = body.allDay ? 0 : fromHHMM(body.start);
        const end = body.allDay ? 1440 : fromHHMM(body.end);
        if (!isDate(body.date) || start === null || end === null || end <= start) return json({ error: 'Check the date and times.' }, 400);
        const entry = { id: newId(), type: 'block', status: 'active', date: body.date, start, end, label: clean(body.label, 100) || 'Blocked', createdAt: new Date().toISOString() };
        const res = await mutate(list => ({ list: [...list, entry], verify: l => l.some(e => e.id === entry.id) }));
        return res.error ? json({ error: res.error }, res.status) : json({ ok: true, entry });
      }

      if (action === 'today' && method === 'POST') {
        const town = clean(body.town, 40);
        await store().setJSON('today', { town, date: nyNow().date, at: new Date().toISOString() });
        return json({ ok: true, town });
      }
    }

    return json({ error: 'Not found.' }, 404);
  } catch (err) {
    console.error(err);
    return json({ error: 'Something went wrong. Please call or text (516) 567-9885.' }, 500);
  }
};

export const config = { path: ['/api/*'] };
