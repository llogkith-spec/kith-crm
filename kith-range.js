/* =============================================================================
   KITH RANGE v1.0 — the first price a customer hears
   =============================================================================
   Stage one of the two-stage estimate. Before anyone opens TechMan, the
   customer gets "usually between £X and £Y". Only a YES goes on to the
   labour / parts / sign-off pipeline for the exact figure, so a NO costs
   nothing.

   WHERE THE NUMBERS COME FROM — never made up:
     1. Fixed prices Logan has set (MOT, remaps, the diagnostic check).
     2. KITH's own signed-off quotes. Every retail job that got a real quote
        is grouped by kind of work (clutch, front brakes, timing belt…) and
        the range is the middle of what those jobs actually cost.
   If there is not enough history to be sure, there is NO range: the lead is
   handed to the adviser to set one. A range is only sent when it is backed
   by at least MIN_SAMPLE real quotes and is not absurdly wide.

   Bodywork is never ranged from text — it needs photos and a person.
   Works in Node and the browser. No dependencies.
   ============================================================================= */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.KITHRange = factory();
}(typeof self !== 'undefined' ? self : this, function () {
'use strict';
const VERSION = '1.0';

const MIN_SAMPLE = 3;        // fewer real quotes than this → no automatic range
const MAX_SPREAD = 3;        // high more than 3× low → too vague to send
const LOW_PCT = 0.2, HIGH_PCT = 0.8;   // the middle 60% of real quotes
const ROUND_TO = 10;         // £10 steps, low rounded down, high rounded up

// Fixed prices, INC VAT (what the customer pays). Logan can change these on
// the inbox Settings screen; the CRM row __rangecfg__ wins over these.
const FIXED_DEFAULTS = {
  mot: 54.85,          // the CRM's MOT test fee default (outside the scope of VAT)
  remap1: 240,         // Stage 1 remap, software only
  remap2: 360,         // Stage 2 remap, software only
  diagnostic: 72       // mechanical diagnostic, £60 ex VAT (engine v8)
};

/* ---------------------------------------------------------------- kinds ---- */
// Order matters: the first matching rule in a GROUP wins, so the specific
// rules (front brakes) sit above the general ones (brakes).
//   phrase  — how the customer message names it
//   source  — 'fixed' | 'history' | 'person' (a human has to price it)
//   bypass  — skips the range altogether and goes to a person / the CRM
const KINDS = [
  { k: 'recovery',   group: 'recovery', label: 'Recovery / breakdown', phrase: 'recovery', source: 'person', bypass: 'urgent',
    re: /\b(recovery|need(s|ing)? (a )?tow|tow (it|me|the car|my car|the van)|broken ?down|broke down|stranded|stuck on the|roadside|won'?t move)\b/i },
  { k: 'insurance',  group: 'insurance', label: 'Insurance claim', phrase: 'an insurance repair', source: 'person', bypass: 'estimate',
    re: /\b(insurance|insurer|claim number|claim ref|third party|non[- ]fault)\b/i },
  { k: 'mot',        group: 'mot', label: 'MOT', phrase: 'an MOT', source: 'fixed', fixed: 'mot',
    re: /\bm\.?\s?o\.?\s?t\b/i },
  { k: 'remap2',     group: 'remap', label: 'Stage 2 remap', phrase: 'a Stage 2 remap', source: 'fixed', fixed: 'remap2',
    re: /\bstage\s?(2|two)\b/i },
  { k: 'remap1',     group: 'remap', label: 'Stage 1 remap', phrase: 'a Stage 1 remap', source: 'fixed', fixed: 'remap1',
    re: /\b(stage\s?(1|one)|remap|re-map|ecu tun(e|ing))\b/i },
  { k: 'service',    group: 'service', label: 'Service', phrase: 'a service', source: 'history',
    re: /\b(servic(e|ing)|oil (and filter )?change)\b/i },
  { k: 'brakes-front', group: 'brakesF', label: 'Front brakes', phrase: 'front brakes', source: 'history',
    re: /\bfront\b[^.?!\n]{0,30}\b(brakes?|pads?|discs?|rotors?|calip?p?ers?)\b|\b(brakes?|pads?|discs?)\b[^.?!\n]{0,20}\bfront\b/i },
  { k: 'brakes-rear', group: 'brakesR', label: 'Rear brakes', phrase: 'rear brakes', source: 'history',
    re: /\brear\b[^.?!\n]{0,30}\b(brakes?|pads?|discs?|shoes|drums?|calip?p?ers?)\b|\bback (brakes?|pads?|discs?|shoes|drums?)\b|\b(brakes?|pads?|discs?)\b[^.?!\n]{0,20}\brear\b/i },
  { k: 'brakes',     group: 'brakes', label: 'Brakes', phrase: 'brakes', source: 'history',
    re: /\b(brakes?|brake pads?|pads and discs|discs and pads|calip?p?ers?)\b/i },
  { k: 'clutch',     group: 'clutch', label: 'Clutch', phrase: 'a clutch', source: 'history',
    re: /\b(clutch|flywheel|dmf|dual mass)\b/i },
  { k: 'timing',     group: 'timing', label: 'Timing belt / chain', phrase: 'a timing belt', source: 'history',
    re: /\b(timing (belt|chain|kit)|cam ?belt)\b/i },
  { k: 'battery',    group: 'battery', label: 'Battery', phrase: 'a battery', source: 'history',
    re: /\bbatter(y|ies)\b/i },
  { k: 'alternator', group: 'alternator', label: 'Alternator', phrase: 'an alternator', source: 'history',
    re: /\balternator\b/i },
  { k: 'starter',    group: 'starter', label: 'Starter motor', phrase: 'a starter motor', source: 'history',
    re: /\bstarter( motor)?\b/i },
  { k: 'dpf',        group: 'dpf', label: 'DPF', phrase: 'DPF work', source: 'history',
    re: /\b(dpf|diesel particulate)\b/i },
  { k: 'exhaust',    group: 'exhaust', label: 'Exhaust', phrase: 'exhaust work', source: 'history',
    re: /\b(exhaust|back ?box|silencer|downpipe|catalytic|cat converter|manifold)\b/i },
  { k: 'suspension', group: 'suspension', label: 'Suspension', phrase: 'suspension work', source: 'history',
    re: /\b(shocks?|shock absorbers?|struts?|coil springs?|suspension|wishbones?|control arms?|drop links?|anti[- ]?roll|bushe?s?|track ?rod)\b/i },
  { k: 'aircon',     group: 'aircon', label: 'Air con', phrase: 'an air con re-gas', source: 'history',
    re: /\b(air ?con|a\/c|aircon|re-?gas)\b/i },
  { k: 'alignment',  group: 'alignment', label: 'Wheel alignment', phrase: 'wheel alignment', source: 'history',
    re: /\b(alignment|tracking)\b/i },
  { k: 'tyres',      group: 'tyres', label: 'Tyres', phrase: 'tyres', source: 'person', ask: 'the tyre size (on the side of the tyre, e.g. 205/55 R16)',
    re: /\b(tyres?|tires?|puncture)\b/i },
  { k: 'bodywork',   group: 'bodywork', label: 'Bodywork', phrase: 'bodywork', source: 'person', ask: 'two or three photos of the damage',
    re: /\b(scratch(es|ed)?|dents?|dented|bumper|panel|respray|paint(work)?|scuff(ed|s)?|accident|crash(ed)?|smart repair|bonnet|wing mirror|wing|quarter panel|door (damage|dent|scratch))\b/i },
  { k: 'diagnostic', group: 'diagnostic', label: 'Fault / diagnostic', phrase: 'a diagnostic check', source: 'fixed', fixed: 'diagnostic',
    re: /\b(warning light|engine light|eml|check engine|diagnos(is|tic|e)|fault codes?|limp mode|knocking|rattl(e|ing)|grinding|squeal(ing)?|smok(e|ing)|won'?t start|not starting|cuts? out|losing power|juddering|vibrat(ion|ing)|noise)\b/i }
];
const KIND = Object.fromEntries(KINDS.map(x => [x.k, x]));

/* ---------------------------------------------------------- classifying ---- */
// Every kind of work a piece of text mentions, one per group.
// "front brakes and an MOT" → ['mot', 'brakes-front'].
// A fault description that ALSO names the repair ("squealing, needs front
// pads") is the repair, not a diagnostic.
function classify(text) {
  const t = String(text || '');
  if (!t.trim()) return [];
  const seen = new Set(), out = [];
  for (const k of KINDS) {
    if (seen.has(k.group)) continue;
    if (k.re.test(t)) { seen.add(k.group); out.push(k.k); }
  }
  // "front and rear brakes" is both; plain "brakes" only when no side was named
  if ((out.includes('brakes-front') || out.includes('brakes-rear')) && out.includes('brakes')) out.splice(out.indexOf('brakes'), 1);
  // a real repair named alongside a symptom is the repair — but an MOT or a
  // service next to a warning light is not, the light still needs a check
  const repairs = out.filter(k => KIND[k].source === 'history' && k !== 'service');
  if (repairs.length && out.includes('diagnostic')) out.splice(out.indexOf('diagnostic'), 1);
  return out;
}

/* ------------------------------------------------------------- history ----- */
// A job counts as a real price only once it was quoted for real: signed off
// by Logan or moved past sign-off. Retail only — trade, AA, warranty and
// insurance pricing is different and would drag the range down.
const QUOTED_STAGES = ['contact', 'contacted', 'waiting', 'waiting2', 'ready', 'booked', 'po', 'raised', 'so', 'soraised',
  'checkin', 'authwait', 'inprog', 'done', 'accounts', 'receivable', 'review', 'followup', 'lost'];
// 'disapproved' is left out on purpose: that is Logan rejecting the figure
const num = v => { const n = parseFloat(v); return isFinite(n) ? n : 0; };
function isRetail(j) {
  const c = String((j && j.custType) || '').toLowerCase();
  if (!c) return !(j && j.fleetAccount);
  return c === 'retail';
}
function usable(j) {
  if (!j || j.mergedInto || j.isTest) return false;
  if (num(j.quote) <= 0) return false;
  if (!isRetail(j)) return false;
  const signed = j.signedOff === true || j.signedOff === 'true' || QUOTED_STAGES.includes(j.stage);
  if (!signed) return false;
  if (/warrant|comeback|come back|goodwill|no charge|\bfoc\b/i.test(String(j.work || ''))) return false;
  return true;
}
const normMake = s => String(s || '').toLowerCase().replace(/[^a-z]/g, '');

// Build once from the jobs list: {kind: [{price, make}]}
// Only jobs that are about ONE kind of work go in, so a "clutch + service"
// job can't inflate the clutch range.
function learn(jobs) {
  const book = {};
  (jobs || []).forEach(j => {
    if (!usable(j)) return;
    const kinds = classify(j.work);
    if (kinds.length !== 1) return;
    const k = kinds[0];
    if (KIND[k].source !== 'history') return;
    (book[k] = book[k] || []).push({ price: num(j.quote), make: normMake(j.make) });
  });
  return book;
}

function pct(sorted, p) {
  if (!sorted.length) return 0;
  const i = (sorted.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}
// Throw away anything three times the median either way — a mis-keyed quote
function trim(prices) {
  const s = prices.slice().sort((a, b) => a - b);
  const med = pct(s, 0.5);
  return s.filter(x => x <= med * 3 && x >= med / 3);
}
const down = n => Math.max(ROUND_TO, Math.floor(n / ROUND_TO) * ROUND_TO);
const up = n => Math.ceil(n / ROUND_TO) * ROUND_TO;

// The range for ONE kind of work.
function rangeFor(kind, book, opts) {
  opts = opts || {};
  const K = KIND[kind];
  if (!K) return { ok: false, kind, why: 'Not a kind of work the range knows' };
  if (K.bypass) return { ok: false, kind, bypass: K.bypass, why: K.label + ' goes straight to a person' };
  if (K.source === 'person') return { ok: false, kind, ask: K.ask || '', why: K.label + ' needs a person to price it' };
  if (K.source === 'fixed') {
    const fx = Object.assign({}, FIXED_DEFAULTS, opts.fixed || {});
    const p = num(fx[K.fixed]);
    if (!p) return { ok: false, kind, why: 'No fixed price set for ' + K.label };
    return { ok: true, kind, low: p, high: p, fixed: true, n: 0, basis: 'fixed price' };
  }
  const all = (book && book[kind]) || [];
  // same make if there is enough of it, otherwise every make
  const mk = normMake(opts.make);
  const same = mk ? all.filter(x => x.make === mk) : [];
  const pool = same.length >= MIN_SAMPLE ? same : all;
  const prices = trim(pool.map(x => x.price));
  if (prices.length < MIN_SAMPLE)
    return { ok: false, kind, n: prices.length, why: 'Only ' + prices.length + ' signed-off ' + K.label.toLowerCase() + ' quote' + (prices.length === 1 ? '' : 's') + ' to go on — needs ' + MIN_SAMPLE };
  let low = down(pct(prices, LOW_PCT)), high = up(pct(prices, HIGH_PCT));
  if (high <= low) high = up(low * 1.1);
  if (high > low * MAX_SPREAD)
    return { ok: false, kind, n: prices.length, low, high, why: K.label + ' prices vary too much (£' + low + '–£' + high + ') to send a range' };
  return { ok: true, kind, low, high, n: prices.length, sameMake: pool === same,
    basis: prices.length + ' signed-off ' + K.label.toLowerCase() + ' quote' + (prices.length === 1 ? '' : 's') + (pool === same ? ' on the same make' : '') };
}

// The range for a whole enquiry. Several kinds of work add up
// ("service and MOT" = service range + MOT). If ANY part can't be ranged
// the whole thing goes to a person — half a price is worse than none.
function estimate(text, book, opts) {
  const kinds = classify(text);
  if (!kinds.length) return { ok: false, kinds, why: 'Can\'t tell what work they want yet' };
  const parts = kinds.map(k => rangeFor(k, book, opts));
  const bypass = parts.find(p => p.bypass);
  if (bypass) return { ok: false, kinds, parts, bypass: bypass.bypass, why: bypass.why };
  const bad = parts.filter(p => !p.ok);
  if (bad.length) return { ok: false, kinds, parts, ask: (bad.find(p => p.ask) || {}).ask || '', why: bad.map(p => p.why).join('; ') };
  const low = Math.round(parts.reduce((s, p) => s + p.low, 0) * 100) / 100;
  const high = Math.round(parts.reduce((s, p) => s + p.high, 0) * 100) / 100;
  return { ok: true, kinds, parts, low, high, fixed: parts.every(p => p.fixed),
    phrase: joinWords(kinds.map(k => KIND[k].phrase)),
    basis: parts.map(p => KIND[p.kind].label + ': ' + p.basis).join(' · ') };
}

function joinWords(a) {
  if (a.length <= 1) return a[0] || '';
  return a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1];
}
const money = n => {
  const v = num(n);
  return '£' + (Math.round(v) === v ? String(v) : v.toFixed(2));
};
// "between £180 and £240" or, for a fixed price, "£54.85"
function say(r) {
  if (!r || !r.ok) return '';
  return r.low === r.high ? money(r.low) : 'between ' + money(r.low) + ' and ' + money(r.high);
}

/* ------------------------------------------------------- their answer ------ */
// What a customer meant when they answered the range.
//   yes — go ahead, price it properly
//   no  — not for them
//   other — anything else (a question, a haggle): a person reads it
function readReply(text) {
  let t = String(text || '').trim().toLowerCase().replace(/[’`]/g, "'");
  if (!t) return 'other';
  if (/\?/.test(t)) return 'other';
  // "no problem, go ahead" is a yes
  t = t.replace(/\b(no (problem|worries|bother|probs)|not a problem|no prob)\b/g, ' fine ').replace(/\bnot (sure|certain)\b/g, ' unsure ');
  if (/^(y|ye|yh|k)[!.\s]*$/.test(t)) return 'yes';
  const no = /\b(no|nah|nope|not (now|for now|today|interested|at the moment|right now|for me)|too (much|expensive|dear|pricey)|leave it|forget it|cancel|don'?t|do not|sorted|found (someone|somewhere|a garage)|elsewhere|pass on it|i'?ll pass|can'?t afford)\b/.test(t);
  const yes = /\b(yes+|yeah|yea|yep|yup|ok|okay|okey|go ahead|go for it|please do|sure|sounds good|fine|deal|do it|book (it|me) in|happy to( go ahead)?|perfect|great|lovely)\b|👍|✅/.test(t);
  if (no && yes) return 'other';     // a person reads anything mixed
  if (no) return 'no';
  if (yes) return 'yes';
  return 'other';
}

return {
  VERSION, MIN_SAMPLE, MAX_SPREAD, FIXED_DEFAULTS, KINDS, KIND, QUOTED_STAGES,
  classify, learn, rangeFor, estimate, say, money, readReply, usable, isRetail
};
}));
