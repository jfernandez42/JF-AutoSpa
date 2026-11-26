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

// ---------- phone alerts (ntfy.sh) ----------
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function when(date, min) {
  const [y, m, d] = date.split('-').map(Number);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const h = Math.floor(min / 60), mm = String(min % 60).padStart(2, '0');
  return `${DAYS[wd]} ${MONTHS[m - 1]} ${d}, ${((h + 11) % 12) + 1}:${mm} ${h < 12 ? 'AM' : 'PM'}`;
}
async function sendAlert(msg) {
  const cfg = await store().get('notify', { type: 'json' });
  if (!cfg || !cfg.topic) return false;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 4000);
  try {
    const r = await fetch('https://ntfy.sh/', {
      method: 'POST', signal: ctl.signal, headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topic: cfg.topic, priority: 4, tags: ['car'], click: 'https://jfautospa.com/admin.html', ...msg })
    });
    return r.ok;
  } catch (e) { console.error('alert failed', e); return false; } finally { clearTimeout(t); }
}

// Several cars in one visit: [{pkg, addons}] -> combined quote (cars done back to back, no buffer between them)
const MAX_CARS = 4;
function quoteCars(cars) {
  if (!Array.isArray(cars) || !cars.length || cars.length > MAX_CARS) return null;
  const qs = cars.map(c => c && quote(c.pkg, c.addons));
  if (qs.some(x => !x)) return null;
  return { cars: qs, mins: qs.reduce((s, x) => s + x.mins, 0), lo: qs.reduce((s, x) => s + x.lo, 0),
    hi: qs.reduce((s, x) => s + x.hi, 0), plus: qs.some(x => x.plus), quote: qs.some(x => x.quote) };
}
function priceText(e) {
  if (e.quote && !e.lo && !e.hi) return 'Quote on site';
  return `$${e.lo}–$${e.hi}${e.plus ? '+' : ''}${e.quote ? ' + quote' : ''}`;
}
function specialText(e) {
  const r = e.cars ? e.cars.map((c, i) => c.request ? `Car ${i + 1}: ${c.request}` : '').filter(Boolean).join('; ') : (e.request || '');
  return r ? 'Special request: ' + r : '';
}
function parseCarsParam(v) { // "signature:pet,wax;fresh:"
  return String(v || '').split(';').filter(Boolean).map(part => {
    const [pkg, adds] = part.split(':'); return { pkg, addons: (adds || '').split(',').filter(Boolean) };
  });
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
      const q = url.searchParams.get('cars')
        ? quoteCars(parseCarsParam(url.searchParams.get('cars')))
        : quote(url.searchParams.get('pkg'), (url.searchParams.get('addons') || '').split(',').filter(Boolean));
      if (!q) return json({ error: 'Unknown package or add-on.' }, 400);
      const list = await readAll();
      return json({ today: nyNow().date, mins: q.mins, days: allSlots(q.mins, list) });
    }

    if (path === 'book' && method === 'POST') {
      const b = await req.json().catch(() => null);
      if (!b) return json({ error: 'Bad request.' }, 400);
      if (b.website) return json({ ok: true, id: 'x' }); // honeypot: pretend success
      const q = quoteCars(Array.isArray(b.cars) ? b.cars : [{ pkg: b.pkg, addons: b.addons }]);
      if (!q) return json({ error: 'Please choose a package again.' }, 400);
      const start = fromHHMM(b.time);
      if (!isDate(b.date) || start === null) return json({ error: 'Please choose a date and time.' }, 400);
      const name = clean(b.name, 80), phone = clean(b.phone, 30), email = clean(b.email, 120);
      const address = clean(b.address, 160), zip = clean(b.zip, 10);
      const vehicles = q.cars.map((_, i) => clean(Array.isArray(b.vehicles) ? b.vehicles[i] : (i === 0 ? b.vehicle : ''), 100));
      const vehicle = vehicles.every(Boolean) ? vehicles.join(' · ') : '';
      const requests = q.cars.map((c, i) => c.quote ? clean(Array.isArray(b.cars) ? (b.cars[i] || {}).request : b.request, 600) : '');
      if (q.cars.some((c, i) => c.quote && !requests[i])) return json({ error: 'Please describe your special request.' }, 400);
      if (!name || phone.replace(/\D/g, '').length < 10 || !address || !/^\d{5}$/.test(zip) || !vehicle)
        return json({ error: 'Please fill in your name, phone, address, ZIP code and vehicle.' }, 400);
      if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: 'That email address looks off.' }, 400);
      const entry = {
        id: newId(), type: 'booking', status: 'booked', createdAt: new Date().toISOString(),
        date: b.date, start, end: start + q.mins,
        pkg: q.cars[0].pkg.id,
        pkgName: q.cars.length > 1 ? `${q.cars.length} cars: ${q.cars.map(c => c.pkg.name).join(' + ')}` : q.cars[0].pkg.name,
        addons: q.cars.length > 1 ? [] : q.cars[0].addons.map(a => a.id),
        addonNames: q.cars.length > 1 ? [] : q.cars[0].addons.map(a => a.name),
        cars: q.cars.length > 1 ? q.cars.map((c, i) => ({ pkg: c.pkg.id, pkgName: c.pkg.name, addons: c.addons.map(a => a.id),
          addonNames: c.addons.map(a => a.name), vehicle: vehicles[i], lo: c.lo, hi: c.hi, plus: c.plus, mins: c.mins,
          quote: c.quote || undefined, request: requests[i] || undefined })) : undefined,
        request: q.cars.length > 1 ? undefined : (requests[0] || undefined),
        lo: q.lo, hi: q.hi, plus: q.plus, quote: q.quote || undefined,
        name, phone, email, address, zip, vehicle,
        parking: clean(b.parking, 40), condition: clean(b.condition, 40), notes: cleanMulti(b.notes, 1000)
      };
      const res = await mutate(list => {
        if (!isFree(list, entry)) return { error: 'Sorry, that time was just taken. Please pick another.', status: 409 };
        return { list: [...list, entry], verify: l => l.some(e => e.id === entry.id) };
      });
      if (res.error) return json({ error: res.error }, res.status || 400);
      await sendAlert({
        title: `New booking: ${entry.pkgName}`,
        message: `${when(entry.date, entry.start)} · ${entry.name}\n${entry.address}, ${entry.zip}\n` +
          (entry.cars
            ? entry.cars.map((c, i) => `Car ${i + 1}: ${c.pkgName}${c.addonNames.length ? ' + ' + c.addonNames.join(', ') : ''} · ${c.vehicle}` +
                (c.request ? `\n  Request: ${c.request}` : '')).join('\n') + '\n' + `Est. ${priceText(entry)} total\n`
            : (entry.request ? `Request: ${entry.request}\n` : '') +
              (entry.addonNames.length ? `+ ${entry.addonNames.join(', ')}\n` : '') + `Est. ${priceText(entry)} · ${entry.vehicle}\n`) +
          entry.phone
      });
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
      const list = (await readAll()).filter(e => e.type === 'weekly' || e.date >= from);
      return new Response(icsCalendar(list), { headers: { 'content-type': 'text/calendar; charset=utf-8', 'cache-control': 'no-store' } });
    }

    if (path.startsWith('admin/')) {
      if (!isOwner(req, url)) return json({ error: 'Wrong passcode.' }, 401);
      const action = path.slice(6);

      if (action === 'schedule' && method === 'GET') {
        const from = addDays(nyNow().date, -62);
        const all = await readAll();
        const list = all.filter(e => e.type !== 'weekly' && e.date >= from).sort((a, b) => a.date.localeCompare(b.date) || a.start - b.start);
        const weekly = all.filter(e => e.type === 'weekly' && e.status !== 'cancelled');
        const t = await store().get('today', { type: 'json' });
        const settings = (await store().get('settings', { type: 'json' })) || {};
        return json({ today: nyNow().date, entries: list, weekly, settings, town: t && t.date === nyNow().date ? t.town : '' });
      }

      const body = method === 'POST' ? await req.json().catch(() => ({})) : {};

      if (action === 'addjob' && method === 'POST') {
        const start = fromHHMM(body.time);
        const name = clean(body.name, 80);
        if (!name) return json({ error: "Enter the customer's name." }, 400);
        if (!isDate(body.date) || start === null) return json({ error: 'Pick a date and start time.' }, 400);
        const pkg = PACKAGES.find(p => p.id === body.pkg);
        const mins = Math.min(720, Math.max(15, parseInt(body.mins, 10) || (pkg ? pkg.mins : 120)));
        const amount = body.amount === '' || body.amount == null ? null : Math.round(Number(body.amount) * 100) / 100;
        if (amount !== null && (!isFinite(amount) || amount < 0 || amount > 100000)) return json({ error: 'Check the amount.' }, 400);
        if (body.done && amount === null) return json({ error: 'Enter the amount paid.' }, 400);
        const METHODS = ['Cash', 'Venmo', 'Zelle', 'Card', 'Other'];
        const entry = {
          id: newId(), type: 'booking', source: 'manual', status: body.done ? 'completed' : 'booked', createdAt: new Date().toISOString(),
          date: body.date, start, end: Math.min(1440, start + mins),
          pkg: pkg ? pkg.id : 'other', pkgName: pkg ? pkg.name : (clean(body.service, 80) || 'Other service'), addons: [], addonNames: [],
          lo: amount !== null ? amount : (pkg ? pkg.lo : 0), hi: amount !== null ? amount : (pkg ? pkg.hi : 0), plus: false,
          name, phone: clean(body.phone, 30), email: clean(body.email, 120), address: clean(body.address, 160), zip: clean(body.zip, 10),
          vehicle: clean(body.vehicle, 100), parking: '', condition: '', notes: cleanMulti(body.notes, 1000)
        };
        if (body.done) Object.assign(entry, { paid: amount, payMethod: METHODS.includes(body.method) ? body.method : 'Other', finalNote: '', completedAt: new Date().toISOString() });
        const res = await mutate(list => ({ list: [...list, entry], verify: l => l.some(e => e.id === entry.id) }));
        return res.error ? json({ error: res.error }, res.status) : json({ ok: true, entry });
      }

      if (action === 'export' && method === 'GET') {
        const done = (await readAll()).filter(e => e.type === 'booking' && e.status === 'completed')
          .map(e => ({ id: e.id, date: e.date, time: `${String(Math.floor(e.start / 60)).padStart(2, '0')}:${String(e.start % 60).padStart(2, '0')}`,
            pkgName: e.pkgName, addonNames: e.cars ? e.cars.flatMap(c => c.addonNames) : (e.addonNames || []), paid: e.paid,
            vehicles: e.cars ? e.cars.map(c => c.vehicle).filter(Boolean) : (e.vehicle ? [e.vehicle] : []), payMethod: e.payMethod, finalNote: e.finalNote || '',
            name: e.name, phone: e.phone, email: e.email || '', address: e.address || '', zip: e.zip || '', vehicle: e.vehicle || '',
            notes: [specialText(e), e.notes].filter(Boolean).join(' · '), source: e.source || 'website' }));
        return json({ jobs: done });
      }

      if (action === 'settings' && method === 'POST') {
        const cur = (await store().get('settings', { type: 'json' })) || {};
        let link = clean(body.reviewLink, 300);
        if (link && !/^https?:\/\//i.test(link)) link = 'https://' + link;
        const next = { ...cur, reviewLink: link };
        await store().setJSON('settings', next);
        return json({ ok: true, settings: next });
      }

      if (action === 'update' && method === 'POST') {
        let problem = null;
        const res = await mutate(list => {
          const i = list.findIndex(e => e.id === body.id);
          if (i < 0) return { error: 'Not found.', status: 404 };
          const e = { ...list[i] };
          if (e.type === 'weekly') {
            const days = [...new Set((Array.isArray(body.days) ? body.days : []).map(Number))].filter(d => d >= 0 && d <= 6).sort();
            const start = body.allDay ? 0 : fromHHMM(body.start), end = body.allDay ? 1440 : fromHHMM(body.end);
            if (!days.length) return { error: 'Pick at least one day.', status: 400 };
            if (start === null || end === null || end <= start) return { error: 'Check the times.', status: 400 };
            if (!isDate(body.since)) return { error: 'Check the start date.', status: 400 };
            Object.assign(e, { days, every: Math.min(4, Math.max(1, parseInt(body.every, 10) || 1)), start, end, since: body.since,
              label: clean(body.label, 100) || 'Blocked', updatedAt: new Date().toISOString() });
          } else if (e.type === 'booking') {
            const start = fromHHMM(body.time);
            if (!isDate(body.date) || start === null) return { error: 'Pick a date and start time.', status: 400 };
            const mins = Math.min(720, Math.max(15, parseInt(body.mins, 10) || (e.end - e.start)));
            const name = clean(body.name, 80);
            if (!name) return { error: "Enter the customer's name.", status: 400 };
            Object.assign(e, { date: body.date, start, end: Math.min(1440, start + mins), name,
              phone: clean(body.phone, 30), email: clean(body.email, 120), address: clean(body.address, 160), zip: clean(body.zip, 10),
              notes: cleanMulti(body.notes, 1000), updatedAt: new Date().toISOString() });
            if (!e.cars) e.vehicle = clean(body.vehicle, 100);
            if (body.price !== '' && body.price != null) {
              const pr = Math.round(Number(body.price) * 100) / 100;
              if (!isFinite(pr) || pr < 0) return { error: 'Check the price.', status: 400 };
              e.lo = pr; e.hi = pr; e.plus = false; e.quote = undefined;
            }
            if (e.status === 'completed' && body.paid !== '' && body.paid != null) {
              const pd = Math.round(Number(body.paid) * 100) / 100;
              if (!isFinite(pd) || pd < 0) return { error: 'Check the amount paid.', status: 400 };
              e.paid = pd;
              if (['Cash', 'Venmo', 'Zelle', 'Card', 'Other'].includes(body.method)) e.payMethod = body.method;
            }
            if (e.status === 'booked' && e.end > (RULES.hours[new Date(e.date + 'T12:00:00Z').getUTCDay()] || [0, 1440])[1]) problem = 'Saved. Heads up: this runs past closing time.';
          } else {
            return { error: "That can't be edited. Remove it and add it again.", status: 400 };
          }
          const next = list.slice(); next[i] = e;
          return { list: next, verify: l => l.find(x => x.id === body.id)?.updatedAt === e.updatedAt };
        });
        return res.error ? json({ error: res.error }, res.status) : json({ ok: true, note: problem });
      }

      if (action === 'complete' && method === 'POST') {
        const amount = Math.round(Number(body.amount) * 100) / 100;
        const METHODS = ['Cash', 'Venmo', 'Zelle', 'Card', 'Other'];
        if (!isFinite(amount) || amount < 0 || amount > 100000) return json({ error: 'Enter the amount paid.' }, 400);
        const payMethod = METHODS.includes(body.method) ? body.method : 'Other';
        const res = await mutate(list => {
          const i = list.findIndex(e => e.id === body.id && e.type === 'booking');
          if (i < 0) return { error: 'Not found.', status: 404 };
          if (list[i].status === 'cancelled') return { error: 'That booking was cancelled.', status: 400 };
          const next = list.slice();
          next[i] = { ...next[i], status: 'completed', paid: amount, payMethod, finalNote: clean(body.note, 300), completedAt: new Date().toISOString() };
          return { list: next, verify: l => l.find(e => e.id === body.id)?.status === 'completed' };
        });
        return res.error ? json({ error: res.error }, res.status) : json({ ok: true });
      }

      if (action === 'reopen' && method === 'POST') {
        const res = await mutate(list => {
          const i = list.findIndex(e => e.id === body.id && e.type === 'booking');
          if (i < 0) return { error: 'Not found.', status: 404 };
          const next = list.slice();
          const { paid, payMethod, finalNote, completedAt, ...rest } = next[i];
          next[i] = { ...rest, status: 'booked' };
          return { list: next, verify: l => l.find(e => e.id === body.id)?.status === 'booked' };
        });
        return res.error ? json({ error: res.error }, res.status) : json({ ok: true });
      }

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
        let entry;
        if (body.repeat) {
          const days = [...new Set((Array.isArray(body.days) ? body.days : []).map(Number))].filter(d => d >= 0 && d <= 6).sort();
          if (!days.length) return json({ error: 'Pick at least one day of the week.' }, 400);
          const every = Math.min(4, Math.max(1, parseInt(body.every, 10) || 1));
          entry = { id: newId(), type: 'weekly', status: 'active', days, every, since: body.date, start, end, label: clean(body.label, 100) || 'Blocked', createdAt: new Date().toISOString() };
        } else {
          entry = { id: newId(), type: 'block', status: 'active', date: body.date, start, end, label: clean(body.label, 100) || 'Blocked', createdAt: new Date().toISOString() };
        }
        const res = await mutate(list => ({ list: [...list, entry], verify: l => l.some(e => e.id === entry.id) }));
        return res.error ? json({ error: res.error }, res.status) : json({ ok: true, entry });
      }

      if (action === 'notify' && method === 'GET') {
        const cfg = await store().get('notify', { type: 'json' });
        return json({ topic: cfg && cfg.topic || '' });
      }
      if (action === 'notify' && method === 'POST') {
        if (body.action === 'enable') {
          let cfg = await store().get('notify', { type: 'json' });
          if (!cfg || !cfg.topic || body.reset) {
            const rnd = Array.from(crypto.getRandomValues(new Uint8Array(12)), b => 'abcdefghijkmnpqrstuvwxyz23456789'[b % 32]).join('');
            cfg = { topic: 'jfautospa-' + rnd, at: new Date().toISOString() };
            await store().setJSON('notify', cfg);
          }
          return json({ ok: true, topic: cfg.topic });
        }
        if (body.action === 'disable') { await store().setJSON('notify', {}); return json({ ok: true, topic: '' }); }
        if (body.action === 'test') {
          const ok = await sendAlert({ title: 'JF AutoSpa alerts are on', message: 'You\'ll get a notification like this whenever someone books online.' });
          return ok ? json({ ok: true }) : json({ error: 'Could not send. Turn alerts on first.' }, 400);
        }
        return json({ error: 'Unknown action.' }, 400);
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
