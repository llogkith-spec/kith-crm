/* =============================================================================
   KITH FLOW v1.0 — where every lead is, who spoke last, what happens next
   =============================================================================
   One lead = one conversation in the Supabase table `kith_leads`
   {id, data, updated_at}. The CRM's inbox, the WhatsApp relay, the feeds
   script (website, email, Instagram, Facebook) and the inbox page all read
   and write the same rows, so a message only ever lives in one place.

   THE ROAD A LEAD TAKES
     details    → we still need name, number, reg or what's wrong
     range      → we have all four; the range goes out (or a person sets one)
     rangeSent  → waiting for their YES / NO
     crm        → they said YES: a job in the CRM for the exact estimate,
                  showing its live CRM stage
     closed     → booked, said no, no reply, or not a job
   Fleet / B2B, insurance and Book My Garage skip the range and go straight
   to the CRM. A breakdown goes straight to a person.

   The bot only messages when something is MISSING or the next step is due.
   A complete enquiry gets no pointless "we've got your enquiry" — it gets
   its range.

   decide() is pure: it looks at a lead and says what to do. The page does it.
   Works in Node and the browser. Needs kith-range.js.
   ============================================================================= */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./kith-range.js'));
  else root.KITHFlow = factory(root.KITHRange);
}(typeof self !== 'undefined' ? self : this, function (R) {
'use strict';
const VERSION = '1.0';
const SHOP = 'KITH Cars';
const SHOP_PHONE = '020 4629 9469';

const MIN = 60000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const PENDING_MS = 3 * MIN;   // a send claimed but not confirmed this long → a person checks it
const TIMING = {
  firstReplyMins: 5,        // a customer waiting longer than this goes red
  chaseAfterMs: 3 * HOUR,   // no answer to "can you send your reg" → one nudge
  maxAsks: 2,               // ask, nudge, then a person calls them
  rangeNudgeMs: DAY,        // no YES/NO a day after the range → one nudge
  rangeCloseMs: 3 * DAY     // still nothing three days on → closed, no reply
};

const SOURCES = {
  whatsapp:  { label: 'WhatsApp',  col: '--c-wa',    phoneFree: true,  reply: 'whatsapp' },
  webform:   { label: 'Website',   col: '--c-web',   phoneFree: false, reply: 'whatsapp' },
  email:     { label: 'Email',     col: '--c-email', phoneFree: false, reply: 'email' },
  instagram: { label: 'Instagram', col: '--c-ig',    phoneFree: false, reply: 'meta' },
  facebook:  { label: 'Facebook',  col: '--c-fb',    phoneFree: false, reply: 'meta' },
  tiktok:    { label: 'TikTok',    col: '--c-tt',    phoneFree: false, reply: '' },
  gbp:       { label: 'Google',    col: '--c-gbp',   phoneFree: false, reply: '' },
  sms:       { label: 'Text',      col: '--c-sms',   phoneFree: true,  reply: 'sms' },
  bmg:       { label: 'Book My Garage', col: '--c-bmg', phoneFree: false, reply: 'whatsapp', bypass: 'estimate' },
  phone:     { label: 'Phone call', col: '--c-phone', phoneFree: true, reply: 'whatsapp' },
  walkin:    { label: 'Walk-in',   col: '--c-walk',  phoneFree: true,  reply: 'whatsapp' }
};
const src = l => SOURCES[(l && l.source) || ''] || { label: (l && l.source) || 'Other', col: '--muted', reply: '' };

const STAGES = {
  details:   { label: 'Getting details', short: 'Details' },
  range:     { label: 'Range to send',   short: 'Range' },
  rangeSent: { label: 'Range sent',      short: 'Range sent' },
  crm:       { label: 'Exact estimate',  short: 'Estimating' },
  closed:    { label: 'Closed',          short: 'Closed' }
};

// The CRM's own stage names, so a converted lead shows where its job is
const CRM_STAGES = {
  intake: '1 · Intake', labour: '2 · Labour Estimate', parts: '3 · Parts Estimate', financial: '4 · Final Estimate',
  signoff: '5 · Logan Sign-Off', disapproved: '5b · Disapproved', contact: '6 · Service Adviser', contacted: '7 · Contacted',
  waiting: '8 · Awaiting · Day 1', waiting2: '9 · Awaiting · Day 2', ready: '10 · Deposit & T&Cs', booked: '11 · Booked',
  po: '12 · POs to Raise', raised: '13 · POs Raised', so: '13b · SOs to Raise', soraised: '13c · SOs Raised',
  checkin: '14 · Vehicle Check-In', authwait: '15 · Awaiting Authority', inprog: '16 · In Progress', done: '17 · Work Complete',
  accounts: '18 · Accounts', receivable: '19 · Accounts Receivable', review: '20 · Review / Referral', followup: '21 · Follow-up Call',
  lost: 'Lost'
};
const WON = ['booked', 'po', 'raised', 'so', 'soraised', 'checkin', 'authwait', 'inprog', 'done', 'accounts', 'receivable', 'review', 'followup'];
const PRE_QUOTE = ['intake', 'labour', 'parts', 'financial', 'signoff', 'disapproved'];

const str = v => String(v == null ? '' : v).trim();
// "STOP" and friends — the bot never answers these; the sender opts them out
const isStop = t => /^\s*(stop|stop all|unsubscribe|unsub|opt ?out|remove me|take me off|end|quit)\b[\s.!]*$/i.test(String(t || '')) ||
  /^\s*(please\s+)?(unsubscribe|remove|take)\s+me\b[^?]{0,40}\b(list|mailing|emails?|texts?|messages?|marketing|contacts?)\b[\s.!]*$/i.test(String(t || '')) ||
  /^\s*(stop|no more) (texting|emailing|messaging|contacting) me\b/i.test(String(t || ''));
const clone = o => JSON.parse(JSON.stringify(o));
const fmt = t => new Date(t).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

/* ------------------------------------------------------------- details ---- */
function intlPhone(p) {
  let d = str(p).replace(/[^\d+]/g, '');
  if (!d) return '';
  if (d.startsWith('+')) d = d.slice(1).replace(/\D/g, '');
  else if (d.startsWith('00')) d = d.slice(2);
  else if (d.startsWith('0')) d = '44' + d.slice(1);
  if (d.startsWith('440')) d = '44' + d.slice(3);     // +44 (0)7700… written with the 0
  return d;
}
const goodPhone = p => { const d = intlPhone(p); return d.length >= 11 && d.length <= 15; };
const PLATE = [/^[A-Z]{2}\d{2}[A-Z]{3}$/, /^[A-Z]\d{1,3}[A-Z]{3}$/, /^[A-Z]{3}\d{1,3}[A-Z]$/, /^[A-Z]{1,3}\d{1,4}$/, /^\d{1,4}[A-Z]{1,3}$/];
// Words that look like a dateless plate but aren't one
const NOT_REG = /^(MOT|A\d|M\d{1,2}|M25|A23|A24|A217|A232|A237|COVID\d*|MK\d|V\d|V6|V8|V10|V12|E\d{1,2}|B\d{1,2})$/;
function cleanReg(r) {
  const s = str(r).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (s.length < 3 || s.length > 8 || !/\d/.test(s) || !/[A-Z]/.test(s) || NOT_REG.test(s)) return '';
  return PLATE.some(re => re.test(s)) ? s : '';
}
const looksLikeEmail = e => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(str(e));

// Pull a reg, a number and an email out of whatever the customer typed
// Today's plates (AB12 CDE) are picked out anywhere. Older ones (A123 BCD,
// ABC 123D) look too much like model names — "A4 TDI", "X5", "GTI 16V" — so
// they only count after the word reg / plate, or when the whole message is
// just the plate.
function findReg(text) {
  const t = ' ' + str(text).toUpperCase().replace(/[’`]/g, "'") + ' ';
  const cur = /\b([A-Z]{2}\d{2}\s?[A-Z]{3})\b/g;
  let m; while ((m = cur.exec(t))) { const c = cleanReg(m[1]); if (c) return c; }
  const lab = t.match(/\b(?:REG(?:ISTRATION)?|PLATE|NUMBER ?PLATE)(?:\s+(?:NUMBER|NO\.?))?(?:\s+IS)?[\s:#-]*([A-Z0-9]{1,4}\s?[A-Z0-9]{1,4})\b/);
  if (lab) { const c = cleanReg(lab[1]); if (c) return c; }
  const alone = t.trim().replace(/^(IT'?S|ITS|IT IS|REG|THE REG IS)\s+/, '').replace(/[.!\s]+$/, '');
  if (alone.length <= 9 && /^[A-Z0-9 ]+$/.test(alone)) return cleanReg(alone);
  return '';
}
function findPhone(text) {
  const m = str(text).match(/(\+?44\s?7\d{3}|\(?07\d{3}\)?|\+?44\s?\(?0?[12]\d{1,3}\)?|\(?0[12]\d{1,3}\)?)[\s.-]?\d{3}[\s.-]?\d{3,4}/);
  return m && goodPhone(m[0]) ? m[0].replace(/[^\d+]/g, '') : '';
}
function findEmail(text) { const m = str(text).match(/[^\s@<>()]+@[^\s@<>()]+\.[a-z]{2,}/i); return m ? m[0] : ''; }
const NOT_NAMES = /^(Looking|Wondering|After|Interested|Having|Just|Trying|Not|Sorry|Hoping|Asking|Booked|Here|Back|On|In|At|Free|Available|Sure|Fine|Ok|Okay|Good|Great|Yes|No|The|My|A|An|Due|Booked|Coming|Going|Ready|Stuck|Broken|Making|Leaking|Still|Also|Abarth|Alfa|Aston|Audi|Bentley|Citroen|Cupra|Dacia|Ds|Ferrari|Fiat|Ford|Honda|Hyundai|Jaguar|Jeep|Kia|Land|Range|Lexus|Mazda|Mercedes|Mini|Mitsubishi|Nissan|Peugeot|Porsche|Renault|Seat|Skoda|Smart|Subaru|Suzuki|Tesla|Toyota|Vauxhall|Volkswagen|Volvo|Golf|Polo|Corsa|Astra|Focus|Fiesta|Transit|Qashqai|Juke|Clio|Yaris|Prius|Octavia|Civic|Insignia|Mondeo|Kuga|Sprinter|Vito|Caddy|Zafira|Picanto|Sportage|Tucson|Jazz)$/;
function findName(text) {
  const m = str(text).replace(/[’`]/g, "'").match(/(?:^|\b)(?:[Mm]y name(?:'s| is)|[Nn]ame(?:'s| is|:)|I'?m|i'?m|I am|[Tt]his is|[Ii]t'?s)\s+([A-Z][a-z'-]+(?:\s+[A-Z][a-z'-]+)?)\b/);
  if (!m) return '';
  const parts = m[1].split(' ');
  if (NOT_NAMES.test(parts[0])) return '';
  if (parts[1] && NOT_NAMES.test(parts[1])) return parts[0];
  return m[1];
}
const firstName = n => (str(n).replace(/^(mr|mrs|miss|ms|dr)\.?\s+/i, '').split(/\s+/)[0]) || 'there';

/* ---------------------------------------------------- a lead, tidied up ---- */
// Rows arrive from the relay, the feeds, the CRM and this page in slightly
// different shapes. Everything goes through here first.
function normalise(raw) {
  const l = clone(raw || {});
  l.from = Object.assign({ name: '', phone: '', email: '', handle: '' }, l.from || {});
  if (!l.from.name && l.name) l.from.name = l.name;
  if (!l.from.phone && l.phone) l.from.phone = l.phone;
  if (!l.from.email && l.email) l.from.email = l.email;
  if (!l.from.handle && l.handle) l.from.handle = l.handle;
  l.source = SOURCES[l.source] ? l.source : (l.source === 'website' ? 'webform' : (l.source || 'whatsapp'));
  l.msgs = Array.isArray(l.msgs) ? l.msgs : [];
  if (!l.msgs.length && str(l.text)) l.msgs = [{ dir: 'in', text: str(l.text), ts: l.ts || Date.now(), channel: l.source }];
  l.msgs.forEach(m => { if (!m.ts) { const p = Date.parse(m.at); m.ts = p && new Date(p).getFullYear() >= 2025 ? p : (l.ts || 0); } });
  l.msgs.sort((a, b) => (a.ts || 0) - (b.ts || 0));
  l.ts = l.ts || (l.msgs[0] && l.msgs[0].ts) || Date.now();
  l.status = l.status || 'new';
  l.reg = cleanReg(l.reg) || '';
  l.work = str(l.work);
  l.bot = l.bot || {};          // what the bot has done: asks, rangeAt, nudgedAt…
  return l;
}

// Everything they've told us so far, filled in from their messages.
// Never overwrites what a person typed into the lead.
function fill(l) {
  const out = normalise(l);
  const said = out.msgs.filter(m => m.dir === 'in').map(m => str(m.text));
  const all = said.join('\n');
  if (!out.reg) out.reg = said.map(findReg).find(Boolean) || '';
  if (!out.from.phone) out.from.phone = findPhone(all);
  if (!out.from.email) out.from.email = findEmail(all);
  if (!out.from.name) out.from.name = findName(all);
  if (!out.work) {
    // the messages that talk about the car, not the ones that are only a reg or a name
    const about = said.filter(t => R.classify(t).length || t.length > 25);
    out.workGuess = (about.length ? about : said).join(' · ').slice(0, 400);
  }
  return out;
}
const workText = l => str(l.work) || str(l.workGuess);

// The four a job can't be priced without
function missing(l) {
  const out = [];
  if (!str(l.from.name)) out.push('name');
  if (!goodPhone(l.from.phone)) out.push('phone');
  if (!cleanReg(l.reg)) out.push('reg');
  if (!R.classify(workText(l)).length && workText(l).length < 25) out.push('what');
  return out;
}

// Fleet / trade customers skip the range: they want the exact price.
function isTrade(l) {
  if (l.custType) return !/^retail$/i.test(l.custType);
  return /\b(fleet|our (vans|vehicles|cars|fleet)|company (car|van|vehicle)s?|business account|purchase order|\bpo number|on account|trade account)\b/i.test(workText(l) + ' ' + (l.subject || ''));
}
// Why this lead goes round the range, if it does
function bypass(l) {
  if (l.bypass) return l.bypass;
  if (src(l).bypass) return src(l).bypass;
  const kinds = R.classify(workText(l));
  if (kinds.includes('recovery')) return 'urgent';
  if (kinds.includes('insurance')) return 'estimate';
  if (isTrade(l)) return 'estimate';
  return '';
}

/* ------------------------------------------------------------- the stage --- */
const lastIn = l => [...l.msgs].reverse().find(m => m.dir === 'in') || null;
const lastOut = l => [...l.msgs].reverse().find(m => m.dir === 'out') || null;
const lastMsg = l => l.msgs[l.msgs.length - 1] || null;
// customer messages since a moment
const inSince = (l, t) => l.msgs.filter(m => m.dir === 'in' && (m.ts || 0) > (t || 0));

// Closed stays closed — unless the customer writes again afterwards
function isClosed(l) {
  if (l.status === 'junk') return true;
  if (!(l.closed || l.status === 'closed')) return false;
  const i = lastIn(l);
  return !(i && l.closedAt && (i.ts || 0) > l.closedAt);
}
function stage(l, job) {
  if (isClosed(l)) return 'closed';
  if (l.jobId || l.status === 'converted') {
    if (job && (WON.includes(job.stage) || job.stage === 'lost')) return 'closed';
    return 'crm';
  }
  if (l.bot.rangeAt) return 'rangeSent';
  if (missing(l).length) return 'details';
  return 'range';
}

// Has the customer been left hanging? Their last word came after ours.
function waitingOnUs(l) {
  const i = lastIn(l), o = lastOut(l);
  if (!i) return false;
  if (o && (o.ts || 0) >= (i.ts || 0)) return false;
  return !i.handled;
}
const waitMins = (l, now) => { const i = lastIn(l); return i ? Math.max(0, Math.floor(((now || Date.now()) - i.ts) / MIN)) : 0; };

// Who spoke last, in words: "Ali → 4 min" / "Customer ← 12 min"
function lastWord(l, now) {
  const m = lastMsg(l); if (!m) return { who: '', ago: '', dir: '' };
  const who = m.dir === 'in' ? 'Customer' : (m.by || 'Staff');
  return { who, dir: m.dir, ago: ago(m.ts, now), status: m.status || '' };
}
function ago(t, now) {
  const d = Math.max(0, (now || Date.now()) - (t || 0));
  if (d < MIN) return 'just now';
  if (d < HOUR) return Math.floor(d / MIN) + ' min';
  if (d < DAY) return Math.floor(d / HOUR) + 'h';
  return Math.floor(d / DAY) + 'd';
}

/* -------------------------------------------- what a person has to do ---- */
// The single next action for this lead, and whether it's on us (a person)
// or on the bot / the customer. This is what the inbox sorts by.
function next(l, ctx) {
  ctx = ctx || {};
  const now = ctx.now || Date.now(), job = ctx.job || null;
  const st = stage(l, job);
  const queued = l.msgs.filter(m => m.dir === 'out' && (m.status === 'queued' || m.status === 'stuck'));
  const say = (text, person, urgent) => ({ text, person: !!person, urgent: !!urgent, stage: st });
  const late0 = waitMins(l, now) > TIMING.firstReplyMins;
  const li1 = lastIn(l);
  if (li1 && isStop(li1.text) && !(lastOut(l) && lastOut(l).ts > li1.ts)) return say('Asked us to stop — opted out of marketing', false);
  const pend = l.bot && l.bot.pending;
  if (pend && now - (pend.at || 0) > PENDING_MS) return Object.assign(say('Check the thread — the bot was interrupted here', true, true), { stuck: true });
  if (pend) return say('Bot is working on it', false);
  if (l.bot.crmError && !l.jobId) return Object.assign(say('The CRM wouldn\'t take it — put it in', true, true), { crmRetry: true });
  if (st === 'closed') {
    // a customer writing after it closed (a returning customer) is a person's job
    if (l.status !== 'junk' && waitingOnUs(l)) return say('Customer messaged after it closed — reply', true, late0);
    if (job && WON.includes(job.stage)) return say('Booked — ' + (CRM_STAGES[job.stage] || job.stage), false);
    if (job && job.stage === 'lost') return say('Lost in the CRM', false);
    return say(l.status === 'junk' ? 'Not a job' : (l.closedWhy || 'Closed'), false);
  }
  if (queued.length) return say('Send ' + (queued.length === 1 ? 'the message' : queued.length + ' messages') + ' by hand — the bot couldn\'t', true, true);
  const late = waitMins(l, now) > TIMING.firstReplyMins;
  if (st === 'crm') {
    const s = job ? (CRM_STAGES[job.stage] || job.stage) : 'in the CRM';
    if (waitingOnUs(l)) return say('Customer messaged — reply (job at ' + s + ')', true, late);
    return say('Exact estimate: ' + s, false);
  }
  const by = bypass(l);
  if (by === 'urgent') return Object.assign(say('Breakdown — call them now', true, true), { top: true });
  if (l.manual) return waitingOnUs(l) ? say('Bot is off — reply to them', true, waitMins(l, now) > TIMING.firstReplyMins) : say('Bot is off for this lead — your move', true);
  // the bot gets two minutes to answer; after that a customer message is a person's job
  const botHad = waitMins(l, now) >= (ctx.botOn === false ? 0 : 2);
  if (st === 'rangeSent') {
    const ans = l.bot.answer;
    if (ans === 'other' && waitingOnUs(l)) return say('They answered the range — read it and reply', true, true);
    if (waitingOnUs(l) && botHad) return say('Customer messaged — reply', true, late);
    return say('Waiting for YES / NO · range sent ' + ago(l.bot.rangeAt, now) + ' ago', false);
  }
  if (waitingOnUs(l) && botHad && st === 'details') return say('Customer messaged — reply (still need their ' + listMissing(missing(l)) + ')', true, late);
  if (st === 'details') {
    const miss = missing(l);
    if (!canMessage(l, ctx)) return say('Get their ' + listMissing(miss) + ' — no way to message them', true, true);
    if ((l.bot.asks || 0) >= TIMING.maxAsks && !inSince(l, l.bot.askedAt).length) return say('No answer to the bot — call them for their ' + listMissing(miss), true, true);
    return say('Bot is asking for their ' + listMissing(miss), false);
  }
  // range
  if (by === 'estimate') return say('Goes straight to the CRM for an exact estimate', false);
  const r = ctx.range || l.bot.lastRange;
  if (r && !r.ok && r.ask && l.bot.askedExtra && !inSince(l, l.bot.askedExtra).length) return say('Bot asked for ' + r.ask + ' — waiting for them', false);
  if (r && !r.ok) return say('Set a range — ' + (r.why || 'the bot can\'t price it'), true, waitMins(l, now) > TIMING.firstReplyMins);
  return say('Range about to go out', false);
}
const NICE = { name: 'name', phone: 'mobile number', reg: 'reg', what: 'what the car needs' };
function listMissing(miss) {
  const w = miss.map(k => NICE[k] || k);
  return w.length <= 1 ? (w[0] || '') : w.slice(0, -1).join(', ') + ' and ' + w[w.length - 1];
}
// Can the bot reach them at all right now?
function canMessage(l, ctx) {
  const c = (ctx && ctx.channels) || {};
  if (goodPhone(l.from.phone) && c.whatsapp) return true;
  const r = src(l).reply;
  if (r === 'meta' && c.meta && l.from.handle) return true;
  if (r === 'email' && c.email && looksLikeEmail(l.from.email)) return true;
  // nothing connected: the bot still writes it, a person sends it in one tap
  return goodPhone(l.from.phone) || looksLikeEmail(l.from.email) || (r === 'meta' && !!l.from.handle);
}

/* ------------------------------------------------------------ messages ---- */
const sign = t => t + '\n\n— ' + SHOP;
const carRef = l => cleanReg(l.reg) ? cleanReg(l.reg) : 'your car';
const MESSAGES = {
  ask: (l, miss, extra) => {
    const nm = str(l.from.name) ? ' ' + firstName(l.from.name) : '';
    const want = miss.map(k => ({ name: 'your name', phone: 'the best mobile number for you', reg: 'the registration', what: 'what the car is doing or what you need' })[k]);
    if (extra) want.push(extra);
    return sign('Hi' + nm + ', thanks for getting in touch with ' + SHOP + '. So we can price it up for you, could you send ' +
      (want.length === 1 ? want[0] : want.slice(0, -1).join(', ') + ' and ' + want[want.length - 1]) + '?');
  },
  nudgeDetails: (l, miss) => sign('Hi' + (str(l.from.name) ? ' ' + firstName(l.from.name) : '') + ', just a nudge from ' + SHOP +
    ' — we still need ' + listMissing(miss).replace('mobile number', 'best mobile number') + ' to price it up. Whenever you get a minute.'),
  range: (l, r) => sign('Hi ' + firstName(l.from.name) + ', thanks for that. For ' + r.phrase + ' on ' + carRef(l) + ', ' +
    (r.fixed && r.low === r.high ? 'the price is ' + R.say(r) + (r.kinds.length === 1 && r.kinds[0] === 'mot' ? '' : ' including VAT') + '.' +
      (r.kinds.includes('diagnostic') ? ' That covers the check — once we know what\'s wrong we\'ll price any repair before doing anything.' : '') :
      'it\'s usually ' + R.say(r) + ' including VAT. The exact figure depends on the parts your car takes' +
      (r.kinds.includes('diagnostic') ? ' and what the check finds' : '') + '.') +
    (r.fixed && r.low === r.high ? '\n\nWould you like to book it in? Reply YES and we\'ll sort a time with you, or NO if it\'s not for you.' :
      '\n\nWould you like us to work out your exact price? Reply YES and we\'ll get it priced properly, or NO if it\'s not for you.')),
  rangeNudge: l => sign('Hi ' + firstName(l.from.name) + ', just checking in — would you like us to work out the exact price for ' + carRef(l) + '? Reply YES or NO.'),
  yes: l => sign(l.range && l.range.fixed ? 'Great, thanks ' + firstName(l.from.name) + ' — we\'ll be in touch shortly to find a time for ' + carRef(l) + '.' :
    'Great, thanks ' + firstName(l.from.name) + ' — give us a moment, we\'re working out the exact price for ' + carRef(l) + ' now and will send it over shortly.'),
  straightIn: l => sign('Thanks ' + firstName(l.from.name) + ' — we\'ve got everything we need for ' + carRef(l) + '. We\'re putting your exact price together now and will send it over shortly.'),
  no: l => sign('No problem at all, thanks for letting us know ' + firstName(l.from.name) + '. If you have a second — was it the price, the timing or something else?\n\n' +
    'And whenever you need servicing, an MOT, tyres, bodywork or recovery, we\'re here on ' + SHOP_PHONE + '.')
};

/* ------------------------------------------------------- what to do now ---- */
// Looks at one lead and returns the bot's actions, in order:
//   {do:'send', kind, text}       message the customer
//   {do:'crm', why}               make the job in the CRM (exact estimate)
//   {do:'close', why}             close the lead
//   {do:'note', patch}            remember something on the lead
// ctx: { now, book (from KITHRange.learn), fixed, channels, botOn, job }
function decide(raw, ctx) {
  ctx = ctx || {};
  const now = ctx.now || Date.now();
  const l = fill(raw);
  const acts = [];
  if (!ctx.botOn || l.manual) return acts;
  if (l.bot.pending || l.bot.crmError) return acts;   // mid-send, or stuck — never act twice
  const li0 = lastIn(l);
  if (li0 && isStop(li0.text)) return acts;            // they asked us to stop
  // Leads from before the bot was switched on are left to people — no
  // surprise messages to old enquiries the first time the page is opened
  if (ctx.since && (l.ts || 0) < ctx.since) return acts;
  // nothing for a lead that has gone quiet for a week
  const li = lastIn(l);
  if (li && now - (li.ts || 0) > 7 * DAY && !l.bot.rangeAt) return acts;
  // a person is talking to them — the bot keeps out of it for half an hour
  const lo = lastOut(l);
  if (lo && lo.by && lo.by !== 'Bot' && now - (lo.ts || 0) < 30 * MIN) return acts;
  const st = stage(l, ctx.job);
  if (st === 'closed' || st === 'crm') return acts;
  if (l.msgs.some(m => m.dir === 'out' && (m.status === 'queued' || m.status === 'sending'))) return acts;   // wait for that to go
  const by = bypass(l);
  if (by === 'urgent') return acts;   // a person rings a breakdown — no bot

  if (st === 'details') {
    const miss = missing(l);
    if (!canMessage(l, ctx)) return acts;
    const asks = l.bot.asks || 0;
    const answeredSinceAsk = inSince(l, l.bot.askedAt).length > 0;
    const k = R.classify(workText(l));
    const extra = k.map(x => R.KIND[x] && R.KIND[x].ask).find(Boolean) || '';
    if (!asks) {
      acts.push({ do: 'send', kind: 'ask', text: MESSAGES.ask(l, miss, extra) });
      acts.push({ do: 'note', patch: { bot: Object.assign({ asks: 1, askedAt: now, askedFor: miss }, extra ? { askedExtra: now } : {}) } });
    } else if (answeredSinceAsk && asks <= TIMING.maxAsks && !sameList(miss, l.bot.askedFor)) {
      // they answered part of it — ask only for what is still missing
      acts.push({ do: 'send', kind: 'ask', text: MESSAGES.ask(l, miss) });
      acts.push({ do: 'note', patch: { bot: { asks: asks + 1, askedAt: now, askedFor: miss } } });
    } else if (!answeredSinceAsk && asks < TIMING.maxAsks && now - (l.bot.askedAt || 0) > TIMING.chaseAfterMs) {
      acts.push({ do: 'send', kind: 'nudge', text: MESSAGES.nudgeDetails(l, miss) });
      acts.push({ do: 'note', patch: { bot: { asks: asks + 1, askedAt: now, askedFor: miss } } });
    }
    return acts;
  }

  if (st === 'range') {
    if (by === 'estimate') {
      if (!l.bot.straightInAt) acts.push({ do: 'send', kind: 'straightIn', text: MESSAGES.straightIn(l) });
      acts.push({ do: 'note', patch: { bot: { straightInAt: l.bot.straightInAt || now } } });
      acts.push({ do: 'crm', why: 'Exact estimate — ' + bypassWhy(l) });
      return acts;
    }
    const r = R.estimate(workText(l), ctx.book, { make: l.make, fixed: ctx.fixed });
    if (!r.ok) {
      const want = r.ask && !l.bot.askedExtra ? r.ask : '';
      if (want && canMessage(l, ctx)) {
        acts.push({ do: 'send', kind: 'ask', text: MESSAGES.ask(l, [], want) });
        acts.push({ do: 'note', patch: { bot: { askedExtra: now, lastRange: slim(r) } } });
      } else if (!l.bot.lastRange || l.bot.lastRange.why !== r.why) {
        acts.push({ do: 'note', patch: { bot: { lastRange: slim(r) } } });
      }
      return acts;
    }
    acts.push({ do: 'send', kind: 'range', text: MESSAGES.range(l, r) });
    acts.push({ do: 'note', patch: { range: { low: r.low, high: r.high, fixed: !!r.fixed, basis: r.basis, kinds: r.kinds, at: now, by: 'Bot' }, bot: { rangeAt: now, lastRange: slim(r) } } });
    return acts;
  }

  if (st === 'rangeSent') {
    // readFrom moves on when a person answers an unclear reply, so the bot
    // only reads what the customer says after that
    const replies = inSince(l, Math.max(l.bot.rangeAt || 0, l.bot.readFrom || 0));
    if (replies.length && !l.bot.answer) {
      const ans = replies.map(m => R.readReply(m.text));
      const a = ans.includes('no') ? 'no' : ans.includes('yes') && !ans.includes('other') ? 'yes' : 'other';
      if (a === 'yes') {
        acts.push({ do: 'send', kind: 'yes', text: MESSAGES.yes(l) });
        acts.push({ do: 'note', patch: { bot: { answer: 'yes', answerAt: now } } });
        acts.push({ do: 'crm', why: 'Said YES to the range ' + R.say(l.range || {}) });
      } else if (a === 'no') {
        acts.push({ do: 'send', kind: 'no', text: MESSAGES.no(l) });
        acts.push({ do: 'note', patch: { bot: { answer: 'no', answerAt: now } } });
        acts.push({ do: 'close', why: 'Said no to the range' });
      } else {
        acts.push({ do: 'note', patch: { bot: { answer: 'other', answerAt: now } } });
      }
      return acts;
    }
    if (!replies.length && !l.bot.answer) {
      if (!l.bot.nudgedAt && now - l.bot.rangeAt > TIMING.rangeNudgeMs) {
        acts.push({ do: 'send', kind: 'rangeNudge', text: MESSAGES.rangeNudge(l) });
        acts.push({ do: 'note', patch: { bot: { nudgedAt: now } } });
      } else if (l.bot.nudgedAt && now - l.bot.rangeAt > TIMING.rangeCloseMs) {
        acts.push({ do: 'close', why: 'No reply to the range' });
      }
    }
  }
  return acts;
}
const sameList = (a, b) => JSON.stringify((a || []).slice().sort()) === JSON.stringify((b || []).slice().sort());
const slim = r => ({ ok: !!r.ok, low: r.low, high: r.high, why: r.why || '', basis: r.basis || '', kinds: r.kinds || [], ask: r.ask || '' });
function bypassWhy(l) {
  if (src(l).bypass) return src(l).label + ' booking';
  const k = R.classify(workText(l));
  if (k.includes('insurance')) return 'insurance work';
  if (isTrade(l)) return 'fleet / trade customer';
  return 'straight in';
}

// Apply a note patch: bot fields merge, everything else overwrites
function applyPatch(l, patch) {
  const out = clone(l);
  Object.keys(patch || {}).forEach(k => {
    if (k === 'bot') out.bot = Object.assign({}, out.bot || {}, patch.bot);
    else out[k] = patch[k];
  });
  return out;
}

/* -------------------------------------------------------- lead → job ------ */
// The job id comes from the lead id, so trying twice can never make two jobs
const jobIdFor = l => 'JL' + String(l.id || '').replace(/[^A-Za-z0-9]/g, '');
function toJob(raw, by, why, now) {
  now = now || Date.now();
  const l = fill(raw);
  const miss = missing(l).filter(k => k !== 'what');
  if (miss.length) throw new Error('Still needs ' + listMissing(miss) + ' before it can go in the CRM.');
  const kinds = R.classify(workText(l));
  const r = l.range && l.range.low ? l.range : null;
  return {
    id: raw && raw.id ? jobIdFor(raw) : 'J' + now + Math.floor(Math.random() * 997),
    name: str(l.from.name), phone: str(l.from.phone), email: str(l.from.email), wa: l.source === 'whatsapp' || goodPhone(l.from.phone),
    reg: cleanReg(l.reg), make: str(l.make), model: str(l.model),
    work: workText(l), by: by || 'Bot', source: src(l).label,
    custType: l.custType || (isTrade(l) ? 'B2B / Trade' : ''),
    stage: 'intake', tmJob: '', parts: [], payments: [], stageAt: now, createdAt: new Date(now).toISOString(),
    fromLead: l.id,
    rangeLow: r ? r.low : null, rangeHigh: r ? r.high : null, rangeBasis: r ? r.basis : '',
    log: [{ t: fmt(now), s: '📨 From the inbox — ' + src(l).label + (str(l.from.name) ? ' · ' + str(l.from.name) : '') + ' · ' + (why || 'exact estimate') + ' [' + (by || 'Bot') + ']' }]
      .concat(r ? [{ t: fmt(now), s: '📏 Customer accepted the range ' + R.say({ ok: true, low: r.low, high: r.high }) + ' — price it properly (' + (r.basis || '') + ')' }] : [])
      .concat(l.msgs.filter(m => m.dir === 'in').slice(-6).map(m => ({ t: fmt(m.ts), s: '💬 ' + str(m.text).slice(0, 220) })))
  };
}

/* --------------------------------------------------------- one message ----- */
// The key the CRM uses to tell messages apart when two screens save at once
const msgKey = m => (m.ts || '') + '|' + (m.dir || '') + '|' + String(m.text || '').slice(0, 40);
function addMsg(l, m) {
  const out = clone(l);
  out.msgs = (out.msgs || []).concat([Object.assign({ ts: Date.now() }, m, { at: fmt(m.ts || Date.now()) })]);
  if (out.msgs.length > 200) out.msgs = out.msgs.slice(-200);
  return out;
}
// Server copy + my copy → one list of messages, nothing lost, nothing doubled
function mergeMsgs(a, b) {
  const seen = new Map();
  (a || []).concat(b || []).forEach(m => {
    const k = m.id || msgKey(m);
    seen.set(k, Object.assign({}, seen.get(k) || {}, m));
  });
  return [...seen.values()].sort((x, y) => (x.ts || 0) - (y.ts || 0));
}

return {
  VERSION, SHOP, SHOP_PHONE, TIMING, SOURCES, STAGES, CRM_STAGES, WON, PRE_QUOTE, MESSAGES,
  src, intlPhone, goodPhone, cleanReg, findReg, findPhone, findEmail, findName, firstName, looksLikeEmail,
  normalise, fill, workText, missing, isTrade, bypass, stage, isClosed, waitingOnUs, waitMins, lastWord, ago, lastIn, lastOut,
  isStop, next, listMissing, canMessage, decide, applyPatch, toJob, jobIdFor, msgKey, addMsg, mergeMsgs, fmt, PENDING_MS
};
}));
