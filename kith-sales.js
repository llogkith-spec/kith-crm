/* =============================================================================
   KITH SALES v1.0 — every customer, who may be messaged, and what goes out
   =============================================================================
   The same file runs in the browser (KITH Sales page) and in Google Apps
   Script (kith-feeds.gs sends the messages on a timer), so the page and the
   sender can never disagree about who gets what.

   WHO A CUSTOMER IS
     Built fresh from what already exists: CRM jobs, inbox leads and B2B
     accounts, joined by mobile number and email. Nothing is typed twice.

   WHO MAY BE MESSAGED — UK rules (PECR) and Meta's WhatsApp rules
     • Anyone who opted out of a channel is never messaged on it again.
     • Email and text: people who said yes (the CRM's "agreed to reminders"
       tick), or "soft opt-in" — they bought from us or asked us for a price,
       and every message lets them opt out.
     • WhatsApp marketing: only people who said yes to WhatsApp, and only with
       a template Meta has approved.
     • Cold B2B: email only, and only to limited companies / LLPs / PLCs.
       Sole traders and partnerships count as people — they need a yes first.
     Every email and text carries who we are and how to stop.

   HOW MUCH
     Messages go Mon–Fri 9–7, Sat 9–5, never Sunday. One marketing message
     per person per week at most. Daily caps per channel (Gmail allows 100 a
     day from a normal Gmail account).

   A send's id is built from the campaign, the step and the person, so the
   same message can never be queued twice.
   Works in Node, the browser and Apps Script. Needs kith-range.js for the
   kinds of work (or works without it, less precisely).
   ============================================================================= */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./kith-range.js'));
  else root.KITHSales = factory(root.KITHRange);
}(typeof self !== 'undefined' ? self : this, function (R) {
'use strict';
const VERSION = '1.0';
const DAY = 864e5;

const SHOP = {
  name: 'KITH Cars', legal: 'Kith Cars Ltd', phone: '020 4629 9469', web: 'kithcars.com', email: 'kithcarsinfo@gmail.com',
  address: 'Unit 1, Soho Mills, London Road, Hackbridge, SM6 7HN',
  review: 'https://www.google.com/maps/place/KITH+Cars+Garage+%26+Bodyshop/@51.3793389,-0.1572743,17z/data=!4m8!3m7!1s0x487607eaf5ef8273:0x62f758e7463a651d!8m2!3d51.3793389!4d-0.1546994!9m1!1b1!16s%2Fg%2F11xlrxbz7j'
};

const DEFAULTS = {
  softOptIn: true,              // past customers and people who asked for a price: email + text, with opt-out
  waCountsMessaged: false,      // customers who've messaged us on WhatsApp count as a WhatsApp yes (Meta says: get a clear yes)
  perPersonDays: 7,             // at most one marketing message per person in this many days
  caps: { email: 90, sms: 200, whatsapp: 200 },    // per day — Gmail allows 100, 10 kept back for inbox replies
  hours: { weekday: [9, 19], saturday: [9, 17], sunday: null },
  reviewLink: '',
  motPrice: 54.85
};

/* ------------------------------------------------------------ little bits */
const str = v => String(v == null ? '' : v).trim();
const clone = o => JSON.parse(JSON.stringify(o));
const num = v => { const n = parseFloat(v); return isFinite(n) ? n : 0; };
const bool = v => v === true || v === 'true';
function intlPhone(p) {
  let d = str(p).replace(/[^\d+]/g, '');
  if (!d) return '';
  if (d.startsWith('+')) d = d.slice(1).replace(/\D/g, '');
  else if (d.startsWith('00')) d = d.slice(2);
  else if (d.startsWith('0')) d = '44' + d.slice(1);
  if (d.startsWith('440')) d = '44' + d.slice(3);
  return d;
}
const isMobile = p => /^447\d{9}$/.test(intlPhone(p));
const goodEmail = e => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(str(e));
const normEmail = e => goodEmail(e) ? str(e).toLowerCase() : '';
const cleanReg = r => { const s = str(r).toUpperCase().replace(/[^A-Z0-9]/g, ''); return s.length >= 3 && s.length <= 8 && /\d/.test(s) && /[A-Z]/.test(s) ? s : ''; };
function firstName(n) {
  const t = str(n).replace(/^(mr|mrs|miss|ms|dr)\.?\s+/i, '').split(/\s+/)[0];
  return t && /^\p{L}[\p{L}'’-]*$/u.test(t) ? t.charAt(0).toUpperCase() + t.slice(1).toLowerCase() : '';
}
// A short id-safe fingerprint, the same in every runtime
function hash(s) {
  let h = 5381; s = String(s);
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}
function toTime(v) {
  if (v == null || v === '') return 0;
  if (typeof v === 'number') return v > 1e12 ? v : v > 1e9 ? v * 1000 : 0;
  const s = String(v);
  if (/^\d{13}$/.test(s)) return +s;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return Date.parse(s + 'T12:00:00Z');
  const t = Date.parse(s);
  return isFinite(t) && new Date(t).getFullYear() >= 2020 ? t : 0;
}
const ymd = t => { const d = new Date(t); return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0'); };
const nice = t => t ? new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', timeZone: 'Europe/London' }) : '';

/* ------------------------------------------------------------ the CRM ---- */
const WON = ['booked', 'po', 'raised', 'so', 'soraised', 'checkin', 'authwait', 'inprog', 'done', 'accounts', 'receivable', 'review', 'followup'];
const DONE = ['done', 'accounts', 'receivable', 'review', 'followup'];
const QUOTED = ['contact', 'contacted', 'waiting', 'waiting2', 'ready'];
// In Apps Script the files load in the order they're listed, so look the
// range engine up when it's needed rather than when this file loads
const Rg = () => R || (typeof KITHRange !== 'undefined' ? KITHRange : null);
const kindsOf = text => { const r = Rg(); return r && r.classify ? r.classify(text) : []; };
// When the work actually happened (or is booked for)
function jobDate(j) {
  return toTime(j.completedAt) || toTime(j.bookedFor) || (WON.includes(j.stage) ? toTime(j.stageAt) : 0) || toTime(j.createdAt) || toTime(j.stageAt);
}
// The CRM stores AA work as aa_towin, aa_smart, aa_pgc, aa_fleet… — all of
// these customers came to us through someone else
const isThirdParty = j => /^(aa|rac|green ?flag|pga|warranty|insurance)/i.test(str(j.custType));
const isTradeJob = j => !isThirdParty(j) && (/trade|b2b|fleet|garage|dealer/i.test(str(j.custType)) || bool(j.fleetAccount));
const arr = v => Array.isArray(v) ? v : [];

/* ---------------------------------------------------------- customers ---- */
// One person, however many jobs, enquiries and cars.
//   jobs     — CRM jobs (the data of each row)
//   leads    — inbox leads (kith_leads data)
//   accounts — B2B accounts (kith_sales type 'account')
//   prefs    — consent / opt-out rows (kith_sales type 'optout' / 'optin')
//   sends    — messages already sent (kith_sales type 'send')
//
// Joining records: a MOBILE number is one person. An email or a landline
// can be shared (a family email, an office phone), so it only joins two
// records if that doesn't put two different mobiles into one person.
// Consent ("they said yes") stays with the exact number or email it was
// given for. An opt-out is the other way round: if ANY of a person's
// numbers or emails opted out, the whole person is out — erring safe.
function buildContacts(input, now) {
  now = now || Date.now();
  const jobs = arr(input.jobs).filter(j => j && !j.mergedInto && !bool(j.isTest) && !String(j.id || '').startsWith('__'));
  const leads = arr(input.leads).filter(Boolean);
  const byId = new Map(), alias = new Map();
  const OPTIN = new Map(), OPTOUT = new Map(), WA = new Map();
  const mark = (map, addr, ch, t) => { if (!addr) return; const m = map.get(addr) || {}; m[ch] = Math.max(m[ch] || 0, t || 1); map.set(addr, m); };
  let seq = 0;
  const idFor = (phone, email) => {
    const pn = intlPhone(phone), e = normEmail(email);
    const mob = isMobile(pn) ? pn : '', land = !mob && pn && pn.length >= 11 ? pn : '';
    const weak = [land && 'p:' + land, e && 'e:' + e].filter(Boolean);
    if (!mob && !weak.length) return '';
    let id = mob && alias.get('p:' + mob);
    if (!id) {
      // no one with this mobile yet: join a weak match only if it has no other mobile
      const w = weak.map(a => alias.get(a)).find(x => x && !(mob && byId.get(x).phones.some(q => isMobile(q) && q !== mob)));
      id = w || ('c' + (++seq));
      if (!byId.has(id)) byId.set(id, blank(id));
    }
    weak.forEach(a => {
      const other = alias.get(a);
      if (!other) { alias.set(a, id); return; }
      if (other === id) return;
      const A = byId.get(id), B = byId.get(other);
      const mobs = c => c.phones.filter(isMobile);
      const mA = mobs(A).concat(mob ? [mob] : []), mB = mobs(B);      // this record's own mobile isn't on A yet
      const clash = mA.length && mB.length && !mA.some(q => mB.includes(q));
      if (clash) return;                                          // two people sharing an email / landline
      fold(A, B); byId.delete(other); alias.forEach((v, k) => { if (v === other) alias.set(k, id); });
    });
    if (mob) alias.set('p:' + mob, id);
    return id;
  };
  jobs.forEach(j => {
    try {
      const id = idFor(j.phone, j.email); if (!id) return;
      const c = byId.get(id), t = jobDate(j);
      const won = WON.includes(j.stage) || (bool(j.estApproved) && j.stage !== 'lost');
      c.jobs.push({ id: j.id, stage: j.stage, work: str(j.work), quote: num(j.quote), at: t, won, third: isThirdParty(j), done: DONE.includes(j.stage) || !!toTime(j.completedAt),
        completedAt: toTime(j.completedAt), reg: cleanReg(j.reg), kinds: kindsOf(j.work), reviewSentAt: str(j.reviewSentAt), lost: j.stage === 'lost' });
      setName(c, j.name, t);
      addPhone(c, j.phone); addEmail(c, j.email);
      addCar(c, j.reg, j.make, j.model, t);
      if (bool(j.marketingOptIn)) {
        // the CRM's tick says "by email/SMS" — so it covers those two, for the number and email on that job
        const ot = toTime(j.marketingOptInAt) || t || 1;
        const pn = intlPhone(j.phone); if (isMobile(pn)) mark(OPTIN, 'p:' + pn, 'sms', ot);
        const e = normEmail(j.email); if (e) mark(OPTIN, 'e:' + e, 'email', ot);
      }
      if (j.referralCode) c.referralCode = str(j.referralCode);
      if (isTradeJob(j)) c.b2b = true;
      if (isThirdParty(j)) c.thirdParty = true;
      c.sources.add('CRM');
    } catch (e) { /* one odd job never stops the rest */ }
  });
  leads.forEach(l => {
    try {
      const f = l.from || {};
      const id = idFor(f.phone || l.phone, f.email || l.email); if (!id) return;
      const c = byId.get(id), msgs = arr(l.msgs);
      const lastIn = msgs.filter(m => m && m.dir === 'in').map(m => m.ts || 0).sort((a, b) => b - a)[0] || l.ts || 0;
      c.leads.push({ id: l.id, source: l.source, at: l.ts || 0, lastIn, status: l.status, closed: !!l.closed || l.status === 'closed' || l.status === 'junk',
        closedWhy: str(l.closedWhy), closedAt: toTime(l.closedAt), jobId: l.jobId || '', range: !!(l.range && l.range.low), answer: (l.bot || {}).answer || '', reg: cleanReg(l.reg) });
      setName(c, f.name || l.name, l.ts);
      addPhone(c, f.phone); addEmail(c, f.email);
      if (l.reg) addCar(c, l.reg, l.make, l.model, l.ts);
      const pn = intlPhone(f.phone || l.phone);
      if (pn && (l.source === 'whatsapp' || msgs.some(m => m && m.dir === 'in' && m.channel === 'whatsapp'))) WA.set(pn, Math.max(WA.get(pn) || 0, lastIn));
      c.sources.add(({ whatsapp: 'WhatsApp', webform: 'Website', email: 'Email', instagram: 'Instagram', facebook: 'Facebook', phone: 'Phone', walkin: 'Walk-in', bmg: 'Book My Garage', sms: 'Text', tiktok: 'TikTok', gbp: 'Google' })[l.source] || 'Inbox');
    } catch (e) {}
  });
  arr(input.accounts).forEach(a => arr(a && a.contacts).forEach(p => {
    try {
      const id = idFor(p.phone, p.email); if (!id) return;
      const c = byId.get(id);
      setName(c, p.name, 0); addPhone(c, p.phone); addEmail(c, p.email);
      const ty = companyType(a.company, a.companyType);
      // in two accounts of different kinds → treat as "not sure" (needs a yes)
      c.companyType = c.accountId && c.companyType !== ty ? 'unknown' : ty;
      c.b2b = true; c.accountId = a.id; c.accountStage = a.stage || 'prospect'; c.company = str(a.company);
      c.sources.add('B2B');
    } catch (e) {}
  }));
  arr(input.prefs).forEach(p => {
    if (!p) return;
    const addrs = [p.phone && 'p:' + intlPhone(p.phone), p.email && 'e:' + normEmail(p.email)].filter(a => a && a.length > 3);
    const chans = Array.isArray(p.channels) ? p.channels : typeof p.channels === 'string' ? [p.channels] : ['email', 'sms', 'whatsapp'];
    addrs.forEach(a => chans.forEach(ch => mark(p.type === 'optout' ? OPTOUT : OPTIN, a, ch, toTime(p.at))));
  });
  arr(input.sends).forEach(s => {
    if (!s) return;
    const id = alias.get(s.contact) || alias.get(String(s.to || '').indexOf('@') > -1 ? 'e:' + s.to : 'p:' + s.to);
    const c = id && byId.get(id);
    if (!c) return;
    c.sends.push(s);
  });
  return [...byId.values()].map(c => finish(c, now, OPTIN, OPTOUT, WA));
}
function blank(id) {
  return { id, key: '', name: '', nameAt: -1, phones: [], emails: [], cars: [], jobs: [], leads: [], sends: [], sources: new Set(),
    optIn: {}, optOut: {}, b2b: false, thirdParty: false, company: '', companyType: '', accountId: '', accountStage: '', referralCode: '', waMessaged: 0, lastMarketing: 0 };
}
function fold(a, b) {
  if (!a || !b) return;
  ['phones', 'emails'].forEach(f => b[f].forEach(x => { if (!a[f].includes(x)) a[f].push(x); }));
  b.cars.forEach(car => addCar(a, car.reg, car.make, car.model, car.at));
  a.jobs = a.jobs.concat(b.jobs); a.leads = a.leads.concat(b.leads); a.sends = a.sends.concat(b.sends);
  b.sources.forEach(s => a.sources.add(s));
  if (b.nameAt > a.nameAt && b.name) { a.name = b.name; a.nameAt = b.nameAt; }
  a.b2b = a.b2b || b.b2b; a.thirdParty = a.thirdParty || b.thirdParty;
  if (b.accountId) { a.companyType = a.accountId && a.companyType !== b.companyType ? 'unknown' : b.companyType; a.company = a.company || b.company; a.accountId = a.accountId || b.accountId; a.accountStage = a.accountStage || b.accountStage; }
  a.referralCode = a.referralCode || b.referralCode;
}
function setName(c, n, t) {
  n = str(n);
  if (!n || /^(unknown|test|customer|n\/?a|-)$/i.test(n) || /^\+?\d[\d\s]+$/.test(n)) return;
  if ((t || 0) >= c.nameAt) { c.name = n; c.nameAt = t || 0; }
}
function addPhone(c, p) { const x = intlPhone(p); if (x && x.length >= 11 && !c.phones.includes(x)) c.phones.push(x); }
function addEmail(c, e) { const x = normEmail(e); if (x && !c.emails.includes(x)) c.emails.push(x); }
function addCar(c, reg, make, model, t) {
  const r = cleanReg(reg); if (!r) return;
  let car = c.cars.find(x => x.reg === r);
  if (!car) { car = { reg: r, make: '', model: '', at: 0 }; c.cars.push(car); }
  if (str(make) && !/^[-–—]|n\/?a/i.test(str(make))) car.make = str(make);
  if (str(model) && !/^[-–—]|n\/?a/i.test(str(model))) car.model = str(model);
  car.at = Math.max(car.at, t || 0);
}
function finish(c, now, OPTIN, OPTOUT, WA) {
  c.sources = [...c.sources];
  c.jobs.sort((a, b) => b.at - a.at);
  c.leads.sort((a, b) => b.at - a.at);
  c.cars.sort((a, b) => b.at - a.at);
  // The same person always gets the same key, however the rows come back:
  // their lowest mobile, else lowest number, else lowest email
  const mobs = c.phones.filter(isMobile).sort(), others = c.phones.filter(p => !isMobile(p)).sort(), ems = c.emails.slice().sort();
  c.key = mobs[0] ? 'p:' + mobs[0] : others[0] ? 'p:' + others[0] : 'e:' + ems[0];
  const won = c.jobs.filter(j => j.won);
  c.isCustomer = won.length > 0;
  // bought from US (not sent by the AA, a warranty firm or an insurer) — what soft opt-in rests on
  c.ownCustomer = won.some(j => !j.third);
  c.lastVisit = won.map(j => j.completedAt || j.at).sort((a, b) => b - a)[0] || 0;
  c.firstSeen = Math.min(...c.jobs.map(j => j.at || Infinity), ...c.leads.map(l => l.at || Infinity));
  if (!isFinite(c.firstSeen)) c.firstSeen = 0;
  c.lastSeen = Math.max(0, ...c.jobs.map(j => j.at || 0), ...c.leads.map(l => l.lastIn || l.at || 0));
  c.spent = Math.round(won.reduce((s, j) => s + j.quote, 0) * 100) / 100;
  c.visits = won.length;
  // MOT and service are per CAR: a year after the last one we did on that reg
  const only = c.cars.length === 1 ? c.cars[0].reg : '';
  c.cars.forEach(car => {
    const mine = won.filter(j => (j.reg || only) === car.reg);
    const last = k => mine.filter(j => j.kinds.includes(k)).map(j => j.completedAt || j.at).sort((a, b) => b - a)[0] || 0;
    car.lastMot = last('mot'); car.motDue = car.lastMot ? car.lastMot + 365 * DAY : 0;
    car.lastService = last('service'); car.serviceDue = car.lastService ? car.lastService + 365 * DAY : 0;
  });
  const soonest = f => c.cars.map(x => x[f]).filter(t => t && t > now - 30 * DAY).sort((a, b) => a - b)[0] || c.cars.map(x => x[f]).filter(Boolean).sort((a, b) => b - a)[0] || 0;
  c.motDue = soonest('motDue'); c.serviceDue = soonest('serviceDue');
  c.lastMot = c.motDue ? c.motDue - 365 * DAY : 0; c.lastService = c.serviceDue ? c.serviceDue - 365 * DAY : 0;
  // asked for a price (a range, a quote) — counts as "in negotiation" for soft opt-in
  c.askedPrice = c.leads.some(l => l.range) || c.jobs.some(j => !j.third && (j.quote > 0 || QUOTED.includes(j.stage) || j.lost));
  c.phone = mobs[0] || c.phones[0] || '';
  c.email = c.emails[0] || '';
  c.firstName = firstName(c.name);
  c.car = c.cars[0] || null;
  // opt-outs: any of their addresses → the whole person
  [...c.phones.map(p => 'p:' + p), ...c.emails.map(e => 'e:' + e)].forEach(a => {
    const o = OPTOUT && OPTOUT.get(a); if (!o) return;
    Object.keys(o).forEach(ch => { c.optOut[ch] = Math.max(c.optOut[ch] || 0, o[ch]); });
  });
  // a yes: only for the exact number / email we'd send to
  const ip = (OPTIN && OPTIN.get('p:' + c.phone)) || {}, ie = (OPTIN && OPTIN.get('e:' + c.email)) || {};
  c.optIn = {};
  if (ip.sms) c.optIn.sms = ip.sms;
  if (ip.whatsapp) c.optIn.whatsapp = ip.whatsapp;
  if (ie.email) c.optIn.email = ie.email;
  c.waMessaged = (WA && WA.get(c.phone)) || 0;
  c.lastMarketing = c.sends.filter(x => x.status === 'sent').map(x => x.sentAt || 0).sort((a, b) => b - a)[0] || 0;
  c.openLead = c.leads.find(l => !l.closed && !l.jobId) || null;
  c.openJob = c.jobs.find(j => !j.won && !j.lost && !['disapproved'].includes(j.stage)) || null;
  c.upcoming = c.jobs.find(j => j.won && !j.done && (j.at || 0) >= now - DAY) || null;
  return c;
}
// Ltd, Limited, LLP, PLC → a company. Anything else could be a person.
function companyType(name, given) {
  if (given === 'ltd' || given === 'sole') return given;
  return /\b(ltd|limited|llp|plc|l\.t\.d|cic|council|nhs|trust|university|school|academy|group)\b/i.test(str(name)) ? 'ltd' : 'unknown';
}

/* ---------------------------------------------------------- may we? ------ */
// Can this person get a MARKETING message on this channel? {ok, why}
function allowed(c, channel, settings) {
  const S = Object.assign({}, DEFAULTS, settings || {});
  if (c.optOut.all || c.optOut[channel]) return { ok: false, why: 'Opted out of ' + chName(channel) };
  if (channel === 'email' && !c.email) return { ok: false, why: 'No email' };
  if ((channel === 'sms' || channel === 'whatsapp') && !isMobile(c.phone)) return { ok: false, why: 'No mobile' };
  if (c.optIn[channel]) return { ok: true, why: 'Said yes' };
  if (channel === 'whatsapp') {
    if (S.waCountsMessaged && c.ownCustomer && c.waMessaged) return { ok: true, why: 'Customer who messaged us on WhatsApp' };
    return { ok: false, why: 'No WhatsApp yes' };
  }
  if (S.softOptIn && (c.ownCustomer || c.askedPrice)) return { ok: true, why: c.ownCustomer ? 'Past customer (soft opt-in)' : 'Asked us for a price (soft opt-in)' };
  if (c.thirdParty && !c.b2b) return { ok: false, why: 'Came through the AA / warranty / insurer — needs a yes' };
  if (channel === 'email' && c.b2b && c.companyType === 'ltd') return { ok: true, why: 'Limited company (B2B)' };
  if (c.b2b && c.companyType !== 'ltd') return { ok: false, why: 'Sole trader or unknown company type — needs a yes' };
  return { ok: false, why: 'No consent' };
}
const chName = ch => ({ email: 'email', sms: 'texts', whatsapp: 'WhatsApp' })[ch] || ch;
// The first channel in the campaign's order this person may get
function pickChannel(c, order, settings, campaign) {
  const tried = [];
  for (const ch of order || ['whatsapp', 'sms', 'email']) {
    if (campaign && !hasMessage(campaign, ch)) continue;
    const a = allowed(c, ch, settings);
    if (a.ok) return { channel: ch, why: a.why, tried };
    tried.push(chName(ch) + ': ' + a.why);
  }
  return { channel: '', why: tried.join(' · ') || 'No message written for any channel', tried };
}
function hasMessage(camp, ch) {
  const m = (camp.msg || {})[ch] || {};
  return ch === 'whatsapp' ? !!str(m.template) : !!str(m.body);
}

/* ---------------------------------------------------------- audiences ---- */
const SEGMENTS = {
  all:        { label: 'Everyone', f: () => true },
  customers:  { label: 'Customers', f: c => c.isCustomer },
  notBooked:  { label: 'Enquired, never booked', f: c => !c.isCustomer && (c.leads.length > 0 || c.jobs.length > 0) && !c.openLead && !c.openJob },
  motSoon:    { label: 'MOT due in 45 days', f: (c, now) => c.motDue && c.motDue > now - 7 * DAY && c.motDue < now + 45 * DAY },
  serviceSoon:{ label: 'Service due in 45 days', f: (c, now) => c.serviceDue && c.serviceDue > now - 30 * DAY && c.serviceDue < now + 45 * DAY },
  lapsed:     { label: 'Not been in for a year', f: (c, now) => c.isCustomer && c.lastVisit && c.lastVisit < now - 365 * DAY && !c.upcoming },
  b2b:        { label: 'B2B / fleet', f: c => c.b2b },
  optedOut:   { label: 'Opted out', f: c => Object.keys(c.optOut).length > 0 }
};
// Extra filters a campaign can add on top of a segment
function matches(c, aud, now) {
  aud = aud || {}; now = now || Date.now();
  const seg = SEGMENTS[aud.segment || 'all'] || SEGMENTS.all;
  if (!seg.f(c, now)) return false;
  if (aud.kind && !c.jobs.some(j => j.kinds.includes(aud.kind)) ) return false;
  if (aud.make) { const m = aud.make.toLowerCase(); if (!c.cars.some(x => x.make.toLowerCase().includes(m))) return false; }
  if (aud.visitedFrom && !(c.lastVisit >= toTime(aud.visitedFrom))) return false;
  if (aud.visitedTo && !(c.lastVisit && c.lastVisit <= toTime(aud.visitedTo) + DAY)) return false;
  if (aud.minSpent && c.spent < num(aud.minSpent)) return false;
  if (aud.noB2B && c.b2b) return false;
  if (aud.accounts && aud.accounts.length && aud.accounts.indexOf(c.accountId) < 0) return false;
  if (aud.b2bStage && c.accountStage !== aud.b2bStage) return false;
  if (aud.source && !c.sources.includes(aud.source)) return false;
  if (aud.q) {
    const q = aud.q.toLowerCase().replace(/\s+/g, '');
    const hay = [c.name, c.phone, c.email, c.company, ...c.cars.map(x => x.reg + x.make + x.model)].join(' ').toLowerCase().replace(/\s+/g, '');
    if (hay.indexOf(q) < 0) return false;
  }
  return true;
}
// Who a campaign would reach, by channel, and who is left out and why
function audience(contacts, camp, settings, now) {
  now = now || Date.now();
  const out = { reach: [], skipped: [], byChannel: { whatsapp: 0, sms: 0, email: 0 }, reasons: {} };
  contacts.forEach(c => {
    if (!matches(c, camp.audience, now)) return;
    const p = pickChannel(c, camp.channels, settings, camp);
    if (p.channel) { out.reach.push({ c, channel: p.channel, why: p.why }); out.byChannel[p.channel]++; }
    else {
      out.skipped.push({ c, why: p.why });
      const r = shortWhy(p.tried);
      out.reasons[r] = (out.reasons[r] || 0) + 1;
    }
  });
  return out;
}
function shortWhy(tried) {
  const t = (tried || []).join(' ');
  if (/Opted out/.test(t) && !/Said yes/.test(t)) return 'Opted out';
  if (/No mobile/.test(t) && /No email/.test(t)) return 'No mobile or email';
  if (/needs a yes|No consent|No WhatsApp yes/.test(t)) return 'No consent for these channels';
  if (/AA/.test(t)) return 'AA / warranty / insurance';
  return 'No usable channel';
}

/* ---------------------------------------------------------- messages ----- */
const FIELDS = {
  first_name: c => c.firstName || 'there',
  name: c => c.name || 'there',
  reg: c => (c.car && c.car.reg) || 'your car',
  car: c => c.car ? ([c.car.make, c.car.model].filter(Boolean).join(' ') || c.car.reg) : 'your car',
  mot_due: c => nice(c.motDue) || 'soon',
  service_due: c => nice(c.serviceDue) || 'soon',
  last_visit: c => nice(c.lastVisit) || 'a while back',
  company: c => c.company || '',
  referral_code: c => c.referralCode || '',
  review_link: (c, s) => (s && s.reviewLink) || SHOP.review,
  mot_price: (c, s) => '£' + num((s && s.motPrice) || DEFAULTS.motPrice).toFixed(2),
  shop_phone: () => SHOP.phone
};
const FIELD_LIST = Object.keys(FIELDS);
function fill(text, c, settings) {
  return str(text).replace(/\{(\w+)\}/g, (m, k) => FIELDS[k] ? FIELDS[k](c, settings) : m);
}
// Fields typed in a message that don't exist — shown before anything sends
function badFields(text) {
  const out = []; String(text || '').replace(/\{(\w+)\}/g, (m, k) => { if (!FIELDS[k] && !out.includes(k)) out.push(k); return m; });
  return out;
}
// Who we are + how to stop. Added to every marketing email and text.
function footer(channel) {
  if (channel === 'sms') return '\n' + SHOP.name + '. Reply STOP to opt out';
  if (channel === 'email') return '\n\n—\n' + SHOP.legal + ' · ' + SHOP.address + ' · ' + SHOP.phone + ' · ' + SHOP.web +
    '\nDon\'t want these emails? Reply UNSUBSCRIBE and we\'ll take you off straight away.';
  return '';
}
function render(camp, step, c, channel, settings) {
  const m = stepMsg(camp, step)[channel] || {};
  if (channel === 'whatsapp') {
    return { template: str(m.template), params: (m.params || []).map(k => FIELDS[k] ? FIELDS[k](c, settings) : str(k)),
      text: '[WhatsApp template ' + str(m.template) + '] ' + (m.params || []).map(k => FIELDS[k] ? FIELDS[k](c, settings) : k).join(' · ') };
  }
  const body = fill(m.body, c, settings) + footer(channel);
  return { subject: channel === 'email' ? fill(m.subject || camp.name, c, settings) : '', text: body };
}
const stepMsg = (camp, step) => step ? (((camp.followUps || [])[step - 1] || {}).msg || camp.msg || {}) : (camp.msg || {});
// An SMS of more than 160 plain characters is billed as 2+ messages
const smsParts = t => { const n = String(t || '').length, uni = /[^\x00-\x7F£€]/.test(t || ''); const one = uni ? 70 : 160, more = uni ? 67 : 153; return n <= one ? 1 : Math.ceil(n / more); };

/* ------------------------------------------------------- when it goes ---- */
// The next moment inside sending hours, UK time, at or after t
function nextSlot(t, settings) {
  const H = Object.assign({}, DEFAULTS.hours, (settings || {}).hours || {});
  let x = t;
  for (let i = 0; i < 24 * 14; i++) {
    const p = ukParts(x);
    const win = p.dow === 0 ? H.sunday : p.dow === 6 ? H.saturday : H.weekday;
    if (win && p.hour >= win[0] && p.hour < win[1]) return x;
    x = Math.floor(x / 3600e3) * 3600e3 + 3600e3;     // top of the next hour (UK is always a whole hour off UTC)
  }
  return t;
}
function inHours(t, settings) { return nextSlot(t, settings) === t; }
function ukParts(t) {
  // Europe/London without a library: BST runs last Sunday of March 01:00 UTC → last Sunday of October 01:00 UTC
  const d = new Date(t), y = d.getUTCFullYear();
  const lastSun = m => { const x = new Date(Date.UTC(y, m + 1, 0, 1)); x.setUTCDate(x.getUTCDate() - x.getUTCDay()); return x.getTime(); };
  const bst = t >= lastSun(2) && t < lastSun(9);
  const u = new Date(t + (bst ? 3600e3 : 0));
  return { dow: u.getUTCDay(), hour: u.getUTCHours(), ymd: ymd(u.getTime()) };
}
const dayKey = t => ukParts(t).ymd;

/* ------------------------------------------------------------- sends ----- */
// The same campaign, step and person (and occasion, for automations) always
// gives the same id — so it can only ever be queued once.
const sendId = (campId, step, contactKey, occasion) => 'S' + hash(campId) + '_' + (step || 0) + '_' + hash(contactKey + '|' + (occasion || ''));
// `car` — the car this message is about (an MOT reminder for one of two cars)
function view(c, car) {
  if (!car) return c;
  return Object.assign({}, c, { car, motDue: car.motDue || c.motDue, serviceDue: car.serviceDue || c.serviceDue });
}
function makeSend(camp, step, c, channel, at, settings, occasion, car) {
  const r = render(camp, step, view(c, car), channel, settings);
  return {
    id: sendId(camp.id, step, c.key, occasion), type: 'send', campaign: camp.id, campaignName: camp.name, step: step || 0, occasion: occasion || '',
    contact: c.key, name: c.name, channel,
    to: channel === 'email' ? c.email : intlPhone(c.phone),
    subject: r.subject || '', text: r.text, template: r.template || '', params: r.params || [],
    reg: car ? car.reg : '', sendAt: Math.round(at), status: 'queued', createdAt: Date.now()
  };
}
// Turn a campaign into the first round of sends
function plan(contacts, camp, settings, now) {
  now = now || Date.now();
  const a = audience(contacts, camp, settings, now);
  const at = nextSlot(Math.max(now, toTime(camp.sendAt) || now), settings);
  // one message per address — a shared family email only gets it once
  const seen = new Set(), sends = [];
  a.reach.forEach(x => { const s = makeSend(camp, 0, x.c, x.channel, at, settings); if (seen.has(s.channel + s.to)) return; seen.add(s.channel + s.to); sends.push(s); });
  return { sends, audience: a };
}
// After a step goes out, the next step (if any) is queued for later.
// It is cancelled if they reply or opt out before then.
function followUp(camp, sent, c, settings) {
  const next = (camp.followUps || [])[sent.step];
  if (!next) return null;
  const order = next.channel ? [next.channel] : (camp.channels || [sent.channel]);
  const p = pickChannel(c, order, settings, { msg: stepMsg(camp, sent.step + 1) });
  if (!p.channel) return null;
  const at = nextSlot((sent.sentAt || Date.now()) + num(next.afterDays || 3) * DAY, settings);
  const car = sent.reg ? (c.cars || []).find(x => x.reg === sent.reg) : null;
  return makeSend(camp, sent.step + 1, c, p.channel, at, settings, sent.occasion, car);
}

/* ------------------------------------------------- automations ----------- */
// Always-on campaigns. Each says who is due today and the occasion (so one
// MOT reminder per MOT, one review ask per job, ever).
const AUTOMATIONS = {
  motDue: {
    label: 'MOT reminder', when: '30 days before the MOT we did last year runs out',
    due: (c, now) => {
      if (c.upcoming || c.openJob) return '';
      const car = c.cars.find(x => x.motDue && x.motDue - now <= 30 * DAY && x.motDue - now > 10 * DAY);
      return car ? { occ: 'mot' + car.reg + ymd(car.motDue), car } : '';
    },
    msg: {
      sms: { body: 'Hi {first_name}, the MOT on {reg} is due around {mot_due}. Book it in with KITH Cars for {mot_price} — reply to this text or call {shop_phone}.' },
      email: { subject: 'MOT due on {reg}', body: 'Hi {first_name},\n\nJust a reminder that the MOT on {reg} is due around {mot_due}.\n\nWe can test it for {mot_price} and fix anything it needs while it\'s with us. Reply to this email or call {shop_phone} to book a slot.\n\nThanks,\nKITH Cars' },
      whatsapp: { template: '', params: ['first_name', 'reg', 'mot_due'] }
    }
  },
  serviceDue: {
    label: 'Service reminder', when: 'A year after the last service we did',
    due: (c, now) => {
      if (c.upcoming || c.openJob) return '';
      const car = c.cars.find(x => x.serviceDue && x.serviceDue - now <= 21 * DAY && x.serviceDue - now > -14 * DAY);
      return car ? { occ: 'svc' + car.reg + ymd(car.serviceDue), car } : '';
    },
    msg: {
      sms: { body: 'Hi {first_name}, {reg} is due its yearly service around {service_due}. Want us to book it in? Reply here or call {shop_phone} — KITH Cars.' },
      email: { subject: '{reg} is due a service', body: 'Hi {first_name},\n\nIt\'s nearly a year since we serviced {reg}, so it\'s due again around {service_due}.\n\nReply to this email or call {shop_phone} and we\'ll find you a slot.\n\nThanks,\nKITH Cars' },
      whatsapp: { template: '', params: ['first_name', 'reg', 'service_due'] }
    }
  },
  reviewAsk: {
    label: 'Review request', when: '2 days after a job is finished, if no review request went out',
    due: (c, now) => {
      const j = c.jobs.find(x => x.done && !x.third && x.completedAt && now - x.completedAt >= 2 * DAY && now - x.completedAt <= 10 * DAY && !x.reviewSentAt);
      return j ? { occ: 'rev' + j.id, car: c.cars.find(x => x.reg === j.reg) || null } : '';
    },
    msg: {
      sms: { body: 'Hi {first_name}, thanks for choosing KITH Cars. If we did a good job, a quick Google review really helps us: {review_link}' },
      email: { subject: 'How did we do?', body: 'Hi {first_name},\n\nThanks for choosing KITH Cars. If you were happy with the work on {reg}, a quick Google review really helps a small garage like ours:\n\n{review_link}\n\nAnd if anything isn\'t right, just reply and tell us.\n\nThanks,\nKITH Cars' },
      whatsapp: { template: '', params: ['first_name', 'review_link'] }
    }
  },
  winBack: {
    label: 'Win back — enquired, didn\'t book', when: '14 days after someone said no or went quiet',
    due: (c, now) => {
      if (c.isCustomer && c.lastVisit > now - 180 * DAY) return '';
      if (c.openLead || c.openJob || c.upcoming) return '';
      const l = c.leads.find(x => x.closed && !x.jobId && x.closedAt && now - x.closedAt >= 14 * DAY && now - x.closedAt <= 60 * DAY && !/opted out|junk|not a job/i.test(x.closedWhy) && x.status !== 'junk');
      const j = c.jobs.find(x => x.lost && x.at && now - x.at >= 14 * DAY && now - x.at <= 60 * DAY);
      const reg = (l && l.reg) || (j && j.reg) || '';
      const car = reg ? c.cars.find(x => x.reg === reg) || null : null;
      return l ? { occ: 'wb' + l.id, car } : j ? { occ: 'wb' + j.id, car } : '';
    },
    msg: {
      sms: { body: 'Hi {first_name}, KITH Cars here. Did you get {reg} sorted? If not, reply and we\'ll take another look at the price for you.' },
      email: { subject: 'Still need {reg} looking at?', body: 'Hi {first_name},\n\nYou asked us about {reg} a few weeks ago. If it still needs doing, reply to this email and we\'ll take another look at the price for you.\n\nThanks,\nKITH Cars' },
      whatsapp: { template: '', params: ['first_name', 'reg'] }
    }
  },
  lapsed: {
    label: 'Haven\'t seen you in a year', when: 'Customers whose last visit was over a year ago',
    due: (c, now) => c.isCustomer && c.lastVisit && now - c.lastVisit > 365 * DAY && now - c.lastVisit < 540 * DAY && !c.upcoming && !c.openJob ? 'lap' + ymd(c.lastVisit) : '',
    msg: {
      sms: { body: 'Hi {first_name}, it\'s been a while since we saw {reg} at KITH Cars. Due a service or MOT? Reply here or call {shop_phone}.' },
      email: { subject: 'It\'s been a while', body: 'Hi {first_name},\n\nIt\'s been over a year since we last saw {reg}. If it\'s due a service, MOT or anything else, reply to this email or call {shop_phone} and we\'ll book you in.\n\nThanks,\nKITH Cars' },
      whatsapp: { template: '', params: ['first_name', 'reg'] }
    }
  }
};
// An automation's campaign record (settings saved over the defaults)
function autoCampaign(key, saved) {
  const A = AUTOMATIONS[key];
  const s = saved || {};
  return { id: 'auto_' + key, name: A.label, auto: key, on: !!s.on, channels: s.channels || ['whatsapp', 'sms', 'email'],
    msg: mergeMsg(A.msg, s.msg), followUps: [], audience: { segment: 'all' } };
}
function mergeMsg(base, over) {
  const out = clone(base || {});
  Object.keys(over || {}).forEach(ch => { out[ch] = Object.assign({}, out[ch] || {}, over[ch] || {}); });
  return out;
}
// Today's automation sends. `existing` is every send id already made.
function runAutomations(contacts, saved, settings, now, existing) {
  now = now || Date.now();
  const have = existing instanceof Set ? existing : new Set(existing || []);
  const at = nextSlot(now, settings), out = [];
  Object.keys(AUTOMATIONS).forEach(k => {
    const camp = autoCampaign(k, (saved || {})[k]);
    if (!camp.on) return;
    contacts.forEach(c => {
      let d; try { d = AUTOMATIONS[k].due(c, now); } catch (e) { d = ''; }
      if (!d) return;
      const occ = typeof d === 'string' ? d : d.occ, car = typeof d === 'string' ? null : d.car;
      const p = pickChannel(c, camp.channels, settings, camp);
      if (!p.channel) return;
      const s = makeSend(camp, 0, c, p.channel, at, settings, occ, car);
      if (have.has(s.id) || have.has(s.campaign + s.occasion + s.to)) return;
      have.add(s.id); have.add(s.campaign + s.occasion + s.to); out.push(s);
    });
  });
  return out;
}

/* --------------------------------------------- sending, one at a time ---- */
// What the sender should do with a queued send right now:
//   {do:'send'} · {do:'wait', until} · {do:'skip', why}
function check(send, c, settings, now, sentToday) {
  const S = Object.assign({}, DEFAULTS, settings || {});
  now = now || Date.now();
  if (send.status !== 'queued') return { do: 'skip', why: 'Not queued' };
  if (!c) return { do: 'skip', why: 'Customer no longer found' };
  const a = allowed(c, send.channel, S);
  if (!a.ok) return { do: 'skip', why: a.why };
  if ((send.sendAt || 0) > now) return { do: 'wait', until: Math.round(send.sendAt) };
  if (!inHours(now, S)) return { do: 'wait', until: nextSlot(now, S) };
  const cap = (S.caps || {})[send.channel];
  if (cap && (sentToday || {})[send.channel] >= cap) return { do: 'wait', until: nextSlot(startOfNextDay(now), S) };
  // a reply since this campaign started stops the follow-ups
  if (send.step > 0 && repliedSince(c, send.campaign)) return { do: 'skip', why: 'They replied' };
  // they've something open with us — don't sell at them in the middle of it
  if (c.openLead && send.campaign.indexOf('auto_reviewAsk') < 0) return { do: 'wait', until: now + DAY };
  const gap = num(S.perPersonDays) * DAY;
  const last = c.sends.filter(x => x.status === 'sent' && x.id !== send.id).map(x => x.sentAt || 0).sort((a, b) => b - a)[0] || 0;
  if (gap && last && now - last < gap) return { do: 'wait', until: nextSlot(last + gap, S) };
  return { do: 'send' };
}
function startOfNextDay(t) { const p = ukParts(t); return Date.parse(p.ymd + 'T00:00:00Z') + DAY + 3600e3; }
function repliedSince(c, campId) {
  const first = c.sends.filter(s => s.campaign === campId && s.status === 'sent').map(s => s.sentAt || 0).sort((a, b) => a - b)[0];
  if (!first) return false;
  return c.sends.some(s => s.campaign === campId && s.replyAt) || c.leads.some(l => (l.lastIn || 0) > first);
}

/* ------------------------------------------------- replies and STOP ------ */
const STOP_RE = /^\s*(stop|stop all|stopall|unsubscribe|unsub|opt ?out|remove me|take me off|cancel|end|quit)\b(\s+(please|pls|thanks|thank you|now|it))*[\s.!]*$/i;
function isStop(t) {
  const s = String(t || '');
  return STOP_RE.test(s) ||
    /^\s*(please\s+)?(unsubscribe|remove|take)\s+me\b[^?]{0,40}\b(list|mailing|emails?|texts?|messages?|marketing|contacts?)\b[\s.!]*$/i.test(s) ||
    /^\s*please\s+(stop|unsubscribe)\b[^?]{0,30}$/i.test(s) ||
    /^\s*(stop|no more) (texting|emailing|messaging|contacting) me\b/i.test(s);
}
// A whole message as it lands in the inbox: an email arrives as
// "Subject: Re: MOT due…\nUNSUBSCRIBE\n\nSent from my iPhone" — look at what
// they actually wrote, the first line, and for email the subject too
function isStopMsg(text, channel) {
  const lines = String(text || '').split(/\r?\n/);
  const subj = ((lines.find(l => /^subject:/i.test(l)) || '').replace(/^subject:\s*(re|fw|fwd):?\s*/i, '').replace(/^subject:\s*/i, '')).trim();
  const body = lines.filter(l => !/^subject:/i.test(l) && !/^>/.test(l)).map(l => l.trim()).filter(Boolean);
  const first = body[0] || '';
  if (isStop(first)) return true;
  if (channel === 'email' || /^subject:/im.test(text)) {
    if (/^\s*unsubscribe\b/i.test(first)) return true;
    if (/^\s*unsubscribe\b/i.test(subj) && body.length <= 2) return true;
  }
  return false;
}

/* ------------------------------------------------------- results --------- */
// How a campaign did: sent, replied, booked, money
function results(campId, sends, contacts) {
  const mine = sends.filter(s => s.campaign === campId);
  const sent = mine.filter(s => s.status === 'sent');
  const r = { queued: mine.filter(s => s.status === 'queued').length, sent: sent.length, failed: mine.filter(s => s.status === 'failed').length,
    skipped: mine.filter(s => s.status === 'skipped' || s.status === 'cancelled').length, replied: 0, booked: 0, revenue: 0, optedOut: 0, people: new Set(sent.map(s => s.contact)).size };
  const byKey = new Map(); contacts.forEach(c => byKey.set(c.key, c));
  const seen = new Set();
  sent.forEach(s => {
    if (seen.has(s.contact)) return; seen.add(s.contact);
    const c = byKey.get(s.contact); if (!c) return;
    const first = Math.min(...sent.filter(x => x.contact === s.contact).map(x => x.sentAt || Infinity));
    if (mine.some(x => x.contact === s.contact && x.replyAt) || c.leads.some(l => (l.lastIn || 0) > first)) r.replied++;
    const job = c.jobs.find(j => j.won && j.at >= first - DAY && j.at <= first + 45 * DAY);
    if (job) { r.booked++; r.revenue += job.quote; }
    if (Object.values(c.optOut).some(t => t >= first)) r.optedOut++;
  });
  r.revenue = Math.round(r.revenue * 100) / 100;
  return r;
}

/* ------------------------------------------------------------- B2B ------- */
const B2B_STAGES = [
  { k: 'prospect', label: 'Prospect',  crm: 'new' },
  { k: 'contacted', label: 'Contacted', crm: 'emailed' },
  { k: 'replied',  label: 'Replied',   crm: 'contact2' },
  { k: 'meeting',  label: 'Meeting / trial', crm: 'contact2' },
  { k: 'quoted',   label: 'Quoted',    crm: 'quoted' },
  { k: 'won',      label: 'Account won', crm: 'won' },
  { k: 'lost',     label: 'Lost',      crm: 'lost' }
];
const FROM_CRM = { new: 'prospect', contact1: 'contacted', emailed: 'contacted', contact2: 'replied', quoted: 'quoted', won: 'won', lost: 'lost' };
// A row from the CRM's own B2B board (kith_b2b) as an account
function accountFromB2B(b) {
  const contact = { name: str(b.contact), role: '', phone: str(b.phone), email: normEmail(b.email) || normEmail((str(b.notes).match(/[^\s@]+@[^\s@]+\.[a-z]{2,}/i) || [])[0]) };
  return { id: 'A' + String(b.id).replace(/[^A-Za-z0-9]/g, ''), type: 'account', b2bId: b.id, company: str(b.company) || str(b.contact) || 'Unknown company',
    companyType: companyType(b.company), contacts: (contact.name || contact.phone || contact.email) ? [contact] : [],
    fleet: str(b.fleet), area: [str(b.town), str(b.postcode)].filter(Boolean).join(' '), address: str(b.address), services: str(b.services),
    source: str(b.source) || 'CRM B2B board', stage: FROM_CRM[b.status] || 'prospect', owner: str(b.createdBy), notes: str(b.notes),
    nextAt: 0, nextWhat: '', log: (b.log || []).map(x => ({ t: toTime(x.t || x.at) || 0, by: str(x.by), what: str(x.s || x.what || x.text) })).filter(x => x.what), createdAt: toTime(b.createdAt) };
}
// Spreadsheet in → accounts out. Header names are guessed generously.
const HEADS = {
  company: /^(company|company ?name|business|business ?name|trading ?name|organisation|organization|account|firm)$/i,
  contact: /^(contact|contact ?name|name|person|first ?name|full ?name|decision ?maker)$/i,
  role: /^(role|title|job ?title|position)$/i,
  email: /^(e-?mail|email ?address|contact ?email)$/i,
  phone: /^(phone|telephone|tel|mobile|phone ?number|contact ?number|number)$/i,
  fleet: /^(fleet|fleet ?size|vehicles|no\.? of vehicles|vans)$/i,
  area: /^(town|city|area|location|postcode|post ?code)$/i,
  sector: /^(sector|industry|type|category)$/i,
  type: /^(company ?type|entity|entity ?type|legal ?form)$/i
};
function parseCSV(text) {
  const rows = []; let row = [], cell = '', q = false;
  const t = String(text || '').replace(/^﻿/, '');
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (q) { if (ch === '"') { if (t[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; continue; }
    if (ch === '"') q = true;
    else if (ch === ',' || ch === '\t') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && t[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(x => str(x)));
}
function importAccounts(text, existing, by) {
  const rows = parseCSV(text);
  if (rows.length < 2) return { added: [], updated: [], skipped: 0, map: {}, error: 'Needs a header row and at least one company' };
  const head = rows[0].map(h => str(h));
  const map = {};
  Object.keys(HEADS).forEach(k => { const i = head.findIndex(h => HEADS[k].test(h)); if (i > -1) map[k] = i; });
  if (map.company == null && map.email == null) return { added: [], updated: [], skipped: 0, map, error: 'Couldn\'t find a company or email column. Headers seen: ' + head.join(', ') };
  const list = (existing || []).map(a => clone(a));
  const byEmail = new Map(), byPhone = new Map(), byName = new Map();
  const index = a => { (a.contacts || []).forEach(p => { if (normEmail(p.email)) byEmail.set(normEmail(p.email), a); if (intlPhone(p.phone)) byPhone.set(intlPhone(p.phone), a); }); byName.set(normCo(a.company), a); };
  list.forEach(index);
  const added = [], updated = []; let skipped = 0;
  const now = Date.now();
  rows.slice(1).forEach((r, i) => {
    const v = k => map[k] != null ? str(r[map[k]]) : '';
    const company = v('company'), email = normEmail(v('email')), phone = v('phone');
    if (!company && !email) { skipped++; return; }
    let a = (email && byEmail.get(email)) || (intlPhone(phone) && byPhone.get(intlPhone(phone))) || (company && byName.get(normCo(company)));
    const contact = { name: v('contact'), role: v('role'), email, phone };
    if (!a) {
      a = { id: 'A' + now.toString(36) + i.toString(36) + hash(company + email).slice(0, 4), type: 'account', company: company || email.split('@')[1] || 'Unknown company',
        companyType: /sole|partner/i.test(v('type')) ? 'sole' : companyType(company, /ltd|limited|llp|plc/i.test(v('type')) ? 'ltd' : ''),
        contacts: [], fleet: v('fleet'), area: v('area'), sector: v('sector'), source: 'Imported list', stage: 'prospect', owner: by || '',
        nextAt: 0, nextWhat: '', log: [{ t: now, by: by || '', what: 'Imported from a list' }], createdAt: now, cold: true };
      list.push(a); added.push(a);
    } else if (!added.includes(a) && !updated.includes(a)) updated.push(a);
    if ((contact.name || contact.email || contact.phone) && !a.contacts.some(p => (email && normEmail(p.email) === email) || (intlPhone(phone) && intlPhone(p.phone) === intlPhone(phone)))) a.contacts.push(contact);
    if (!a.fleet && v('fleet')) a.fleet = v('fleet');
    index(a);
  });
  return { added, updated, skipped, map, list };
}
const normCo = s => str(s).toLowerCase().replace(/\b(ltd|limited|llp|plc|the|uk|group)\b|[^a-z0-9]/g, '');

// Accounts whose next step is due
function b2bDue(accounts, now) {
  now = now || Date.now();
  return (accounts || []).filter(a => a.stage !== 'won' && a.stage !== 'lost' && a.nextAt && a.nextAt <= now + DAY - 1)
    .sort((x, y) => x.nextAt - y.nextAt);
}

/* ------------------------------------------------------- the pipeline -- */
// Every lead in the business on one ladder, coldest to hottest:
//   cold      B2B prospects we're reaching out to, no reply yet
//   enquiry   someone got in touch; we're getting details / a range to send
//              (and B2B companies that replied)
//   range     the first price (the range) has gone — waiting for YES / NO
//   exact     they said YES (or came straight in): being priced properly in
//              the CRM — labour, parts, sign-off (and B2B meetings / trials)
//   quoted    the exact quote has gone — waiting for them to book
//   booked    booked in the last 30 days
// plus `cooled`: said no, went quiet or lost in the last 60 days — the
// people a win-back is for.
// Each card: {id, kind:'lead'|'job'|'account', stage, name, what, reg,
// value, since (when it entered this step), stale (sitting too long)}.
const PIPE = [
  { k: 'cold',    label: 'Cold',             sub: 'B2B outreach, no reply yet', staleDays: 14 },
  { k: 'enquiry', label: 'New enquiry',      sub: 'Getting details, range to send', staleDays: 1 },
  { k: 'range',   label: 'Warm',             sub: 'Range sent — waiting for YES', staleDays: 2 },
  { k: 'exact',   label: 'Warmer',           sub: 'Wants the exact price — being estimated', staleDays: 1 },
  { k: 'quoted',  label: 'Hot',              sub: 'Exact quote sent — waiting to book', staleDays: 3 },
  { k: 'booked',  label: 'Booked',           sub: 'Last 30 days', staleDays: 0 }
];
const EXACT_STAGES = ['intake', 'labour', 'parts', 'financial', 'signoff', 'disapproved'];
const QUOTE_STAGES = ['contact', 'contacted', 'waiting', 'waiting2', 'ready'];
// leadStage(lead) → the inbox's own stage (details / range / rangeSent / crm / closed)
function pipeline(input, leadStage, now) {
  now = now || Date.now();
  const out = { cards: [], cooled: [] };
  const jobs = arr(input.jobs).filter(j => j && j.id && !j.mergedInto && !bool(j.isTest) && !String(j.id).startsWith('__') && !bool(j.historic));
  const jobIds = new Set(jobs.map(j => j.id));
  const jobVal = j => num(j.quote) || num(j.finalEst) || (num(j.rangeLow) && num(j.rangeHigh) ? (num(j.rangeLow) + num(j.rangeHigh)) / 2 : 0);
  const since = j => toTime(j.stageAt) || toTime(j.createdAt) || 0;
  jobs.forEach(j => {
    const st = j.stage || 'intake';
    let k = EXACT_STAGES.includes(st) ? 'exact' : QUOTE_STAGES.includes(st) ? 'quoted' : WON.includes(st) ? 'booked' : '';
    if (k === 'booked' && since(j) < now - 30 * DAY) return;
    if (st === 'lost') { if (since(j) > now - 60 * DAY) out.cooled.push({ id: j.id, kind: 'job', name: str(j.name), what: str(j.work), reg: cleanReg(j.reg), value: jobVal(j), since: since(j), why: 'Lost in the CRM', phone: str(j.phone), email: str(j.email) }); return; }
    if (!k) return;
    out.cards.push({ id: j.id, kind: 'job', stage: k, crmStage: st, name: str(j.name) || 'No name', what: str(j.work), reg: cleanReg(j.reg), value: jobVal(j),
      since: since(j), b2b: isTradeJob(j), third: isThirdParty(j), lead: str(j.fromLead || j.leadId), phone: str(j.phone), email: str(j.email) });
  });
  arr(input.leads).forEach(l => {
    if (!l || !l.id) return;
    const st = leadStage ? leadStage(l) : (l.jobId ? 'crm' : 'details');
    const f = l.from || {};
    const base = { id: l.id, kind: 'lead', name: str(f.name) || (f.handle ? '@' + str(f.handle).replace(/^@/, '') : '') || str(f.phone) || str(f.email) || 'Unknown',
      what: str(l.work || l.workGuess), reg: cleanReg(l.reg), source: l.source, phone: str(f.phone), email: str(f.email),
      value: l.range && num(l.range.low) ? (num(l.range.low) + num(l.range.high || l.range.low)) / 2 : 0 };
    const lastIn = arr(l.msgs).filter(m => m && m.dir === 'in').map(m => m.ts || 0).sort((a, b) => b - a)[0] || l.ts || 0;
    if (st === 'crm') {
      if (l.jobId && jobIds.has(l.jobId)) return;                       // the job card stands for it
      out.cards.push(Object.assign(base, { stage: 'exact', since: toTime(l.convertedAt) || lastIn }));
      return;
    }
    if (st === 'closed') {
      const at = toTime(l.closedAt) || lastIn;
      if (l.status !== 'junk' && !/opted out|not a job/i.test(str(l.closedWhy)) && !l.jobId && at > now - 60 * DAY)
        out.cooled.push(Object.assign(base, { since: at, why: str(l.closedWhy) || 'Closed' }));
      return;
    }
    const k = st === 'rangeSent' ? 'range' : 'enquiry';
    out.cards.push(Object.assign(base, { stage: k, since: k === 'range' ? ((l.bot || {}).rangeAt || lastIn) : (l.ts || lastIn) }));
  });
  arr(input.accounts).forEach(a => {
    if (!a || !a.id) return;
    const k = { prospect: 'cold', contacted: 'cold', replied: 'enquiry', meeting: 'exact', quoted: 'quoted' }[a.stage || 'prospect'];
    const p = arr(a.contacts)[0] || {};
    const last = arr(a.log).map(x => x.t || 0).sort((x, y) => y - x)[0] || a.createdAt || 0;
    if (a.stage === 'lost') return;
    if (a.stage === 'won') { if (last > now - 30 * DAY) out.cards.push({ id: a.id, kind: 'account', stage: 'booked', name: str(a.company), what: 'Account won' + (a.fleet ? ' · ' + a.fleet + ' vehicles' : ''), value: 0, since: last, b2b: true }); return; }
    out.cards.push({ id: a.id, kind: 'account', stage: k, name: str(a.company) || 'Unknown company', what: [p.name, a.fleet && a.fleet + ' vehicles', a.area].filter(Boolean).join(' · '),
      value: 0, since: last, b2b: true, next: a.nextAt || 0, owner: str(a.owner), email: str(p.email), phone: str(p.phone) });
  });
  out.cards.forEach(c => {
    const P = PIPE.find(x => x.k === c.stage);
    c.age = Math.max(0, Math.floor((now - (c.since || now)) / DAY));
    c.stale = !!(P && P.staleDays && c.since && now - c.since > P.staleDays * DAY);
  });
  out.cooled.sort((a, b) => b.since - a.since);
  out.byStage = {};
  PIPE.forEach(P => {
    const list = out.cards.filter(c => c.stage === P.k);
    out.byStage[P.k] = { list, n: list.length, value: Math.round(list.reduce((s, c) => s + (c.value || 0), 0)), stale: list.filter(c => c.stale).length };
  });
  return out;
}
// How enquiries turned out, for the last `days`: of the people who got in
// touch, how many got a range, said YES, got an exact quote, booked
function funnel(input, days, now) {
  now = now || Date.now();
  const from = now - (days || 30) * DAY;
  const leads = arr(input.leads).filter(l => l && (l.ts || 0) >= from && l.status !== 'junk');
  const jobs = new Map(arr(input.jobs).filter(j => j && j.id).map(j => [j.id, j]));
  const r = { enquiries: leads.length, ranged: 0, yes: 0, quoted: 0, booked: 0 };
  leads.forEach(l => {
    if ((l.bot || {}).rangeAt || (l.range && l.range.low)) r.ranged++;
    const j = l.jobId && jobs.get(l.jobId);
    if (l.jobId) r.yes++;
    if (j && (QUOTE_STAGES.includes(j.stage) || WON.includes(j.stage) || (j.stage === 'lost' && num(j.quote) > 0))) r.quoted++;
    if (j && WON.includes(j.stage)) r.booked++;
  });
  return r;
}

/* ------------------------------------------- a job's messages + chase -- */
// The CRM's own chase ladder (index.html CHASE_STEPS), counted from the
// moment the job entered Contacted / Awaiting Response. Kept in step here
// so the Pipeline can say what has gone and what pings next.
const CHASE = [
  { hrs: 1, label: 'Day 1 · Phone call', call: true },
  { hrs: 4, label: 'Day 1 · Text if no answer' },
  { hrs: 8, label: 'Day 1 · End of day nudge' },
  { hrs: 25, label: 'Day 2 · Phone call', call: true },
  { hrs: 28, label: 'Day 2 · Text if no answer' },
  { hrs: 32, label: 'Day 2 · Last nudge' }
];
const CHASE_GIVE_UP_HRS = 48;
const CHASE_STAGES = ['contacted', 'waiting', 'waiting2'];
const parseJSON = v => { if (v == null || v === '') return null; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch (e) { return null; } };
// Everything said to and from the customer about one job, and where the chase is.
//   j      — the job's full data
//   extra  — { outbox: the CRM's __outbox__ messages, lead: the inbox lead it came from }
function jobActivity(j, extra, now) {
  now = now || Date.now(); extra = extra || {};
  const msgs = [];
  const add = (t, dir, who, text, o) => { if (!text && !o) return; msgs.push(Object.assign({ t: t || 0, dir, who: who || '', text: str(text) }, o || {})); };
  arr(parseJSON(j.msgOutbox)).forEach(m => add(toTime(m.t) || toTime(m.at), 'out', m.by || 'CRM', m.text || ({ quote: 'The quote' })[m.kind] || m.kind,
    { auto: true, status: m.status, via: m.sentVia || (m.route || [])[0] || '', kind: m.kind }));
  arr(extra.outbox).filter(m => m && m.jobId === j.id).forEach(m => {
    if (msgs.some(x => x.kind === m.kind && Math.abs(x.t - (toTime(m.t) || toTime(m.at))) < 60e3)) return;
    add(toTime(m.t) || toTime(m.at), 'out', m.by || 'CRM', m.text, { auto: true, status: m.status, via: m.sentVia || '', kind: m.kind });
  });
  arr(parseJSON(j.adviserOutbox)).forEach(m => add(m.ts || toTime(m.at), 'out', 'Adviser bot', 'Automatic ' + String(m.kind || '').replace(/-/g, ' '), { auto: true, status: m.status, kind: m.kind }));
  arr(parseJSON(j.chasesSent)).forEach(c => {
    const cfg = CHASE[c.step] || {};
    add(toTime(c.at), cfg.call ? 'call' : 'out', c.by || '', c.label || cfg.label, { chase: true, status: 'sent' });
  });
  arr(parseJSON(j.chaseLog)).forEach(c => add(toTime(c.at), 'out', 'Auto-chase', 'Day ' + c.day + ' chase', { auto: true, chase: true }));
  const lead = extra.lead;
  if (lead) arr(lead.msgs).forEach(m => m && add(m.ts, m.dir === 'in' ? 'in' : 'out', m.dir === 'in' ? 'Customer' : (m.by || 'Staff'), m.text,
    { auto: m.by === 'Bot', status: m.status, via: m.via || '' }));
  const lr = toTime(j.lastReplyAt);
  if (lr && !msgs.some(m => m.dir === 'in' && Math.abs(m.t - lr) < 120e3)) add(lr, 'in', 'Customer', j.lastReply || '(replied)');
  msgs.sort((a, b) => a.t - b.t);
  // the CRM's history log, newest first, with who did it pulled out
  const history = arr(parseJSON(j.log)).map(x => {
    const s0 = str(x.s), m = s0.match(/\s*\[([^\]]+)\]\s*$/);
    return { t: toTime(x.t), text: m ? s0.slice(0, m.index) : s0, who: m ? m[1] : '' };
  }).sort((a, b) => b.t - a.t);
  // the chase
  const since = toTime(j.stageAt) || toTime(j.adviserFirstContactAt) || 0;
  const said = parseJSON(j.saidNo);
  const lastIn = msgs.filter(m => m.dir === 'in').map(m => m.t).sort((a, b) => b - a)[0] || 0;
  const replied = !!(toTime(j.customerYesAt) || said || (lastIn && since && lastIn > since));
  const chase = { active: CHASE_STAGES.includes(j.stage) && !said && !toTime(j.customerYesAt), done: arr(parseJSON(j.chasesSent)).length, total: CHASE.length, replied, since };
  if (chase.active && since) {
    const nxt = CHASE[chase.done];
    chase.next = nxt ? { label: nxt.label, call: !!nxt.call, dueAt: since + nxt.hrs * 3600e3 } : null;
    if (chase.next) chase.next.overdue = chase.next.dueAt < now;
    chase.closesAt = since + CHASE_GIVE_UP_HRS * 3600e3;
  }
  const outs = msgs.filter(m => m.dir !== 'in');
  return {
    messages: msgs, history, chase,
    quoteSentAt: toTime(j.signedOffAt) || (msgs.find(m => m.kind === 'quote') || {}).t || 0,
    lastOut: outs.length ? outs[outs.length - 1] : null, lastIn,
    queued: msgs.filter(m => m.status === 'queued' || m.status === 'stuck').length
  };
}

/* --------------------------------------- the live inbox's leads (__leads__) */
// The live inbox (kith-inbox.html + inbox-ingest) keeps every lead in one
// list in the jobs row __leads__, in kith-bot.js's shape:
//   {id, channel, name, phone, email, handle, reg, make, model, what, state,
//    jobId, t, messages:[{dir, channel, t, text, status}], triage:{…}}
// fromLive() turns one into the shape the rules here read, so nothing about
// the live inbox has to change.
const CH_IN = { website: 'webform', whatsapp: 'whatsapp', instagram: 'instagram', facebook: 'facebook', tiktok: 'tiktok', email: 'email',
  phone: 'phone', walkin: 'walkin', bmg: 'bmg', gbp: 'gbp', sms: 'sms' };
function fromLive(l) {
  if (!l || !l.id) return null;
  const t = l.triage || {};
  const rf = t.rapidFireRange || null;
  const at = v => toTime(v) || 0;
  const msgs = arr(l.messages).filter(Boolean).map(m => ({
    dir: m.dir === 'out' ? 'out' : 'in', text: str(m.text), ts: m.t || at(m.at) || l.t || 0, channel: CH_IN[m.channel] || m.channel || '',
    status: m.status || '', by: m.by || (m.dir === 'out' ? (m.msgId && /-(rf|ack)$/.test(m.msgId) ? 'Triage AI' : '') : '')
  }));
  const junk = l.state === 'junk';
  return {
    id: l.id, live: true, source: CH_IN[l.channel] || l.channel || 'other',
    from: { name: str(l.name), phone: str(l.phone), email: str(l.email), handle: str(l.handle) },
    reg: cleanReg(l.reg), make: str(l.make), model: str(l.model), work: str(l.what),
    ts: l.t || (msgs[0] || {}).ts || 0, msgs,
    status: junk ? 'junk' : l.jobId ? 'converted' : 'open', jobId: l.jobId || '', convertedAt: at(l.jobAt),
    closed: junk, closedWhy: junk ? 'Not a job' : '', closedAt: junk ? at(l.junkAt) || l.t : 0,
    range: rf && rf.lo ? { low: num(rf.lo), high: num(rf.hi || rf.lo) } : null,
    bot: { rangeAt: at(t.rapidFireSentAt) },
    triage: { category: t.category || '', rapid: !!t.is_rapid_fire, ambiguous: !!t.is_ambiguous, custType: t.suggestedCustType || '' },
    custType: t.suggestedCustType && t.suggestedCustType !== 'retail' ? t.suggestedCustType : ''
  };
}
// Where a live lead is on the road, for the Pipeline
//   closed · crm (became a job) · rangeSent · details (still with the inbox)
function liveStage(l, job) {
  if (!l) return 'closed';
  if (l.status === 'junk' || l.closed) return 'closed';
  if (l.jobId) return job && (WON.includes(job.stage) || job.stage === 'lost') ? 'closed' : 'crm';
  if (l.bot && l.bot.rangeAt) return 'rangeSent';
  return 'details';
}

return {
  fromLive, liveStage,
  CHASE, jobActivity,
  PIPE, pipeline, funnel,
  VERSION, SHOP, DEFAULTS, DAY, WON, SEGMENTS, AUTOMATIONS, FIELDS, FIELD_LIST, B2B_STAGES, FROM_CRM,
  intlPhone, isMobile, normEmail, firstName, hash, toTime, ymd, nice, ukParts, dayKey,
  buildContacts, companyType, allowed, pickChannel, hasMessage, matches, audience, fill, badFields, footer, render, smsParts,
  nextSlot, inHours, sendId, makeSend, view, plan, followUp, autoCampaign, runAutomations, check, repliedSince, isStop, isStopMsg, results, isThirdParty,
  accountFromB2B, parseCSV, importAccounts, b2bDue, chName
};
}));
