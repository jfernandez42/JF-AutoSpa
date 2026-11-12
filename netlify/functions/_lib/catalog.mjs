// JF AutoSpa booking catalog and schedule rules.
// Edit prices, times and add-ons here. The booking page reads this through /api/catalog.
// When adding an add-on, also update the add-ons list and request form on index.html and the CRM.

export const RULES = {
  timeZone: 'America/New_York',
  // 0 = Sunday ... 6 = Saturday. Open [startMin, endMin] in minutes after midnight.
  hours: { 1: [480, 1140], 2: [480, 1140], 3: [480, 1140], 4: [480, 1140], 5: [480, 1140], 6: [480, 1140] },
  slotStep: 30,      // offer a start time every 30 minutes
  bufferMin: 45,     // drive and setup time blocked after every job
  leadHours: 12,     // earliest a customer can book from now
  windowDays: 60     // furthest out a customer can book
};

// side: 'ext' = exterior work, 'int' = interior work, 'both'
export const PACKAGES = [
  { id: 'exterior', name: 'Exterior Only', lo: 50, hi: 70, mins: 75, side: 'ext',
    blurb: 'Hand wash and dry, tire shine, streak-free exterior windows.' },
  { id: 'interior', name: 'Interior Only', lo: 80, hi: 120, mins: 105, side: 'int',
    blurb: 'Vacuum, wipe-down, streak-free interior windows.' },
  { id: 'fresh', name: 'Fresh Start', lo: 100, hi: 150, mins: 120, side: 'both',
    blurb: 'Inside and out: hand wash, tire shine, vacuum, wipe-down, windows.' },
  { id: 'signature', name: 'Signature Package', lo: 180, hi: 240, mins: 210, side: 'both', featured: true,
    blurb: 'Everything in Fresh Start plus pre-wash, door jambs, deep wheel clean, steam, air blowout and deep interior clean.' }
];

// plus: true means the price can go up from there ("$40+")
export const ADDONS = [
  { id: 'wax', name: 'Spray wax sealant', lo: 30, hi: 30, mins: 15, side: 'ext', note: 'Gloss and protection for 4–6 weeks.' },
  { id: 'engine', name: 'Engine bay detail', lo: 50, hi: 50, mins: 30, side: 'ext', note: 'Degrease, clean and dress the engine bay.' },
  { id: 'clay', name: 'Iron decon & clay bar', lo: 50, hi: 70, mins: 45, side: 'ext', note: 'Removes bonded contamination so paint feels smooth.' },
  { id: 'acid', name: 'Acid wash', lo: 80, hi: 80, mins: 30, side: 'ext', note: 'Removes heavy brake dust and mineral buildup.' },
  { id: 'glass', name: 'Window ceramic coating', lo: 120, hi: 120, mins: 45, side: 'ext', note: 'Water beads off the glass for up to 3 years.' },
  { id: 'trim', name: 'Exterior trim restoration', lo: 150, hi: 150, mins: 60, side: 'ext', note: 'Brings faded black trim back to dark.' },
  { id: 'sand', name: 'Excessive sand removal', lo: 40, hi: 40, plus: true, mins: 30, side: 'int', note: 'For beach cars and heavy sand in the carpet.' },
  { id: 'pet', name: 'Pet hair removal', lo: 50, hi: 50, plus: true, mins: 30, side: 'int', note: 'Pulls embedded pet hair out of carpet and seats.' },
  { id: 'ozone', name: 'Ozone odor treatment', lo: 50, hi: 50, mins: 30, side: 'int', note: 'Neutralizes smoke, pet and food smells.' },
  { id: 'leather', name: 'Leather shampoo & conditioner', lo: 40, hi: 60, mins: 30, side: 'int', note: 'Deep clean, then condition to keep leather soft.' },
  { id: 'steam', name: 'Steam cleaning', lo: 60, hi: 60, mins: 30, side: 'int', note: 'Sanitizes vents, cupholders, seams and surfaces.' },
  { id: 'extract', name: 'Seat & carpet extraction', lo: 80, hi: 80, mins: 60, side: 'int', note: 'Hot-water extraction for stains in fabric and carpet.' },
  { id: 'leathercoat', name: 'Leather ceramic coating', lo: 200, hi: 300, mins: 60, side: 'int', note: 'Protects leather for 1–1.5 years.' }
];

export function addonFits(addon, pkg) {
  return pkg.side === 'both' || addon.side === pkg.side;
}

// Returns null if invalid, else { pkg, addons, mins, lo, hi, plus }
export function quote(pkgId, addonIds) {
  const pkg = PACKAGES.find(p => p.id === pkgId);
  if (!pkg) return null;
  const ids = [...new Set(Array.isArray(addonIds) ? addonIds : [])];
  const addons = [];
  for (const id of ids) {
    const a = ADDONS.find(x => x.id === id);
    if (!a || !addonFits(a, pkg)) return null;
    addons.push(a);
  }
  return {
    pkg, addons,
    mins: pkg.mins + addons.reduce((s, a) => s + a.mins, 0),
    lo: pkg.lo + addons.reduce((s, a) => s + a.lo, 0),
    hi: pkg.hi + addons.reduce((s, a) => s + a.hi, 0),
    plus: addons.some(a => a.plus)
  };
}
