/* =============================================================================
   KITH SOP AMENDMENTS v1.0
   =============================================================================
   What Logan changes at sign-off, turned into rules the whole system follows.

   The base SOP (engine) is never edited. An amendment sits on top of it:
     "Clutch jobs, retail: multiplier x1.9, rate £70/hr"
   Once Logan approves it in the brain, every screen that prices labour —
   the estimator app, the CRM sign-off, the pipeline re-price, the SOP page
   and the AI prompt — reads the same list.

   Only LABOUR changes. Parts markup is fixed and never touched here.
   AA work is never touched (AA rate cards charge raw SRT).
   Bodywork is never touched (it takes no multiplier).

   Precedence on a labour line, highest first:
     1. Logan's own figure on that job (override) — sacred, nothing replaces it
     2. An approved amendment matching the job name
     3. The base SOP
   Works in Node and the browser. No dependencies.
   ============================================================================= */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.KITHRules = factory();
}(typeof self !== 'undefined' ? self : this, function () {
'use strict';

const VERSION = '1.0';
const ROW = '__soprules__';                  // one row in the jobs table
const DECIDERS = ['Logkith', 'Logan'];       // the only names that can approve or override
const KITH_CUSTOMERS = ['retail', 'trade'];  // AA types are never amended
const CUSTOMER_LABEL = { retail: 'Retail', trade: 'Trade' };
const MULT_MIN = 1.0, MULT_MAX = 4.0;        // SOP rule 2: never quote below raw SRT
const RATE_MIN = 30,  RATE_MAX = 250;        // £/hr ex VAT
const REPRICE_STAGES = ['labour', 'parts', 'financial', 'signoff', 'disapproved'];
const STATUS = { PENDING: 'pending', APPROVED: 'approved', REJECTED: 'rejected', RETIRED: 'retired' };

const money = n => Math.round(n * 100) / 100;
const num = v => (v === '' || v == null || isNaN(parseFloat(v))) ? null : parseFloat(v);
const canDecide = who => DECIDERS.indexOf(String(who || '')) > -1;
const stamp = () => new Date().toISOString();
const logTime = () => new Date().toLocaleString('en-GB',
  { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

/* ------------------------------------------------------------- matching --- */
// "Clutches" must match "Clutch kit & DMF". Word-level, plural-tolerant,
// order-free. A rule for "brakes" also matches any line in the brakes category.
function stem(w) {
  w = String(w || '').toLowerCase();
  if (w.length > 4 && /(ches|shes|sses|xes)$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && /ies$/.test(w)) return w.slice(0, -3) + 'y';
  if (w.length > 3 && /s$/.test(w) && !/ss$/.test(w)) return w.slice(0, -1);
  return w;
}
function words(s) {
  return String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).map(stem);
}
function phrases(appliesTo) {
  return String(appliesTo || '').toLowerCase()
    .split(/,|\/|&|\+|;|\band\b|\bor\b/)
    .map(p => words(p)).filter(p => p.length);
}
// Score = words in the best matching phrase (longer phrase = more specific). 0 = no match.
function matchScore(rule, label, category) {
  const have = new Set(words(label).concat(words(category)));
  let best = 0;
  phrases(rule.appliesTo).forEach(p => {
    if (p.every(w => have.has(w))) best = Math.max(best, p.length);
  });
  return best;
}

/* ---------------------------------------------------------------- rules --- */
function newId() { return 'R' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

/**
 * A labour amendment proposed at sign-off or from the Disapproved lane.
 * It changes nothing until a decider approves it.
 */
function makeRule(o) {
  const errs = [];
  const appliesTo = String(o.appliesTo || '').trim();
  if (!appliesTo) errs.push('say what kind of job it is for (e.g. clutches)');
  else if (!phrases(appliesTo).length) errs.push('"' + appliesTo + '" has no words to match on');
  const customers = (o.customers || []).filter(c => KITH_CUSTOMERS.indexOf(c) > -1);
  if (!customers.length) errs.push('pick Retail, Trade or both — AA rate cards are never amended');
  const multiplier = num(o.multiplier), rate = num(o.rate);
  if (multiplier == null && rate == null) errs.push('give a new multiplier, a new labour rate, or both');
  if (multiplier != null && (multiplier < MULT_MIN || multiplier > MULT_MAX))
    errs.push('multiplier must be between ×' + MULT_MIN + ' and ×' + MULT_MAX);
  if (rate != null && (rate < RATE_MIN || rate > RATE_MAX))
    errs.push('labour rate must be between £' + RATE_MIN + ' and £' + RATE_MAX + ' an hour ex VAT');
  if (!o.by) errs.push('a rule needs a name against it');
  if (!String(o.reason || '').trim()) errs.push('say why — the brain learns from the reason');
  if (errs.length) throw new Error(errs.join('; '));
  const was = o.was || {};
  return {
    id: newId(), kind: 'rule', appliesTo, customers,
    multiplier, rate,
    was: { multiplier: num(was.multiplier), rate: num(was.rate) },
    reason: String(o.reason).trim(), source: o.source || 'signoff',
    jobId: o.jobId || null, reg: o.reg || '',
    status: STATUS.PENDING, proposedBy: o.by, proposedAt: stamp()
  };
}

/** A plain reason with no rule — "why Dad said no". Approved notes are read by the AI. */
function makeNote(o) {
  const text = String(o.text || '').trim();
  if (!text) throw new Error('a note needs some words');
  if (!o.by) throw new Error('a note needs a name against it');
  return {
    id: newId(), kind: 'note', text, source: o.source || 'disapproved',
    jobId: o.jobId || null, reg: o.reg || '', job: o.job || '',
    status: STATUS.PENDING, proposedBy: o.by, proposedAt: stamp()
  };
}

function sameTarget(a, b) {
  const k = r => phrases(r.appliesTo).map(p => p.slice().sort().join(' ')).sort().join('|');
  return a.kind === 'rule' && b.kind === 'rule' && k(a) === k(b);
}

/**
 * Approve. Returns the NEW list. An older approved rule for the same job type
 * and the same customer type is retired, so two live rules never fight.
 */
function approve(list, id, { by, note = '' } = {}) {
  if (!canDecide(by)) throw new Error('only Logan can approve an SOP amendment');
  const target = list.find(r => r.id === id);
  if (!target) throw new Error('that amendment no longer exists');
  if (target.status !== STATUS.PENDING) throw new Error('that amendment is already ' + target.status);
  const at = stamp();
  return list.map(r => {
    if (r.id === id) return Object.assign({}, r, { status: STATUS.APPROVED, decidedBy: by, decidedAt: at, decisionNote: note });
    if (target.kind === 'rule' && r.status === STATUS.APPROVED && sameTarget(r, target)) {
      const left = r.customers.filter(c => target.customers.indexOf(c) < 0);
      if (!left.length) return Object.assign({}, r, { status: STATUS.RETIRED, retiredBy: by, retiredAt: at,
        retiredWhy: 'replaced by a newer amendment', supersededBy: id });
      if (left.length < r.customers.length) return Object.assign({}, r, { customers: left });
    }
    return r;
  });
}
function reject(list, id, { by, reason } = {}) {
  if (!canDecide(by)) throw new Error('only Logan can turn an amendment down');
  if (!String(reason || '').trim()) throw new Error('say why it is being turned down');
  return list.map(r => r.id === id
    ? Object.assign({}, r, { status: STATUS.REJECTED, decidedBy: by, decidedAt: stamp(), decisionNote: reason })
    : r);
}
function retire(list, id, { by, reason } = {}) {
  if (!canDecide(by)) throw new Error('only Logan can take an amendment back out');
  if (!String(reason || '').trim()) throw new Error('say why it is coming out');
  return list.map(r => (r.id === id && r.status === STATUS.APPROVED)
    ? Object.assign({}, r, { status: STATUS.RETIRED, retiredBy: by, retiredAt: stamp(), retiredWhy: reason })
    : r);
}
const pending = list => (list || []).filter(r => r.status === STATUS.PENDING);
const live    = list => (list || []).filter(r => r.status === STATUS.APPROVED);
const liveRules = list => live(list).filter(r => r.kind === 'rule');

/** A fingerprint of what is live. A job re-prices only when this changes. */
function signature(list) {
  return liveRules(list).slice().sort((a, b) => a.id < b.id ? -1 : 1)
    .map(r => [r.id, r.multiplier, r.rate, r.customers.join('+')].join(':')).join('|') || 'none';
}

/** The approved rule for one labour line, or null. */
function ruleFor(label, category, customer, list) {
  if (KITH_CUSTOMERS.indexOf(customer) < 0) return null;
  const hits = liveRules(list)
    .filter(r => r.customers.indexOf(customer) > -1)
    .map(r => ({ r, s: matchScore(r, label, category) }))
    .filter(x => x.s > 0);
  if (!hits.length) return null;
  hits.sort((a, b) => (b.s - a.s) ||
    (a.r.customers.length - b.r.customers.length) ||
    String(b.r.decidedAt || '').localeCompare(String(a.r.decidedAt || '')));
  return hits[0].r;
}

/* --------------------------------------------------------------- labour --- */
/**
 * Price one labour line: the engine first, then Logan's figure or an amendment.
 * `engine` is the KITH engine (engine.js or the one inlined in the app).
 * opts are the engine's labourLine opts, plus optional opts.override from Logan:
 *   { srt, multiplier, rate, by, at }
 */
function labour(engine, opts, list) {
  const ov = opts.override || null;
  const o = Object.assign({}, opts);
  delete o.override;
  if (ov && num(ov.srt) != null) o.srt = num(ov.srt);
  const base = engine.labourLine(o);
  const out = Object.assign({}, base, {
    baseMultiplier: base.multiplier, baseRate: base.rate, baseTotal: base.total,
    sopRule: null, override: ov ? Object.assign({}, ov) : null, bookSrt: num(opts.srt)
  });
  if (base.isBodywork || engine.isAA(o.customer)) return out;

  let m = null, r = null;
  if (ov && (num(ov.multiplier) != null || num(ov.rate) != null)) {
    m = num(ov.multiplier); r = num(ov.rate);
  } else {
    const rule = ruleFor(o.label, o.category, o.customer, list);
    if (rule) {
      // The ramp ladder REPLACES the normal one; an amendment never undercuts it.
      if (!o.rampExempt) m = rule.multiplier;
      r = rule.rate;
      if (m != null || r != null)
        out.sopRule = { id: rule.id, appliesTo: rule.appliesTo, multiplier: m, rate: r };
    }
  }
  if (m == null && r == null) return out;
  const mult = m != null ? m : base.multiplier;
  const rate = r != null ? r : base.rate;
  const charged = base.hours * mult + (base.pairSecondarySrt || 0);
  return Object.assign(out, { multiplier: mult, rate, chargedHours: charged, total: money(charged * rate) });
}

/** One line of working, for screens and the stored quote. */
function working(l) {
  const h = n => Number(n).toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
  const bits = [];
  if (l.override) bits.push('Logan\u2019s figure' + (l.override.by ? ' (' + l.override.by + ')' : ''));
  if (l.sopRule) bits.push('SOP amendment: ' + l.sopRule.appliesTo);
  return h(l.hours) + ' hr \u00d7 ' + l.multiplier + ' = ' + h(l.chargedHours) + ' charged hr \u00d7 \u00a3' + l.rate +
    (bits.length ? ' \u2014 ' + bits.join('; ') : '');
}

/* -------------------------------------------------------------- reprice --- */
function customerOf(job) {
  const d = job.estimateDraft || {}, e = job.estimate || {};
  return d.customer || e.customer_type || 'retail';
}
function handSet(job) {
  return !!job.labourOverride ||
    ((job.estimateDraft || {}).labour || []).some(l => l && l.override);
}

/**
 * Re-price a job's labour against the rules. Parts and fixed lines are carried
 * over untouched. Returns { skip } or { changed, before, after, estimate, labour }.
 * `respectOverride:false` is used only when Logan is editing the job himself.
 */
function reprice(engine, job, list, { respectOverride = true } = {}) {
  const d = job.estimateDraft, e = job.estimate;
  if (!d || !e || !Array.isArray(e.lines)) return { skip: 'not priced in the estimator app' };
  const cust = customerOf(job);
  if (!engine.CUSTOMERS[cust]) return { skip: 'unknown customer type ' + cust };
  if (engine.isAA(cust)) return { skip: 'AA rate card \u2014 amendments never apply' };
  if (respectOverride && handSet(job)) return { skip: 'Logan set this job\u2019s labour by hand' };
  const draft = (d.labour || []);
  const stored = e.lines.filter(l => l.kind === 'labour');
  if (draft.length !== stored.length) return { skip: 'the saved quote and the saved work disagree \u2014 open it in the estimator' };

  const lab = draft.map(l => labour(engine, Object.assign({}, l, {
    customer: cust, rampExempt: !!d.rampExempt, inspection: l.inspection || null
  }), list));
  let i = 0;
  const lines = e.lines.map(l => {
    if (l.kind !== 'labour') return Object.assign({}, l);
    const n = lab[i++];
    return Object.assign({}, l, {
      label: n.label, total: n.total, tier: n.tier, srt: n.srt, charged_hours: n.chargedHours,
      multiplier: n.multiplier, rate: n.rate, vatable: true, working: working(n),
      sop_rule: n.sopRule ? n.sopRule.id : null, override: !!n.override
    });
  });
  let net = 0, outside = 0;
  lines.forEach(l => { if (l.vatable === false) outside += (+l.total || 0); else net += (+l.total || 0); });
  net = money(net);
  const vatAmt = money(net * (engine.VAT_RATE || 0.2));
  const pays = money(net + vatAmt + outside);
  const depositRequired = pays >= 200;
  const estimate = Object.assign({}, e, {
    lines, net, vat: vatAmt, outside_vat: money(outside), customer_pays: pays,
    deposit_required: depositRequired, deposit: depositRequired ? money(pays / 2) : 0,
    sop_rules: signature(list)
  });
  const before = money(+e.customer_pays || 0);
  return { changed: Math.abs(before - pays) > 0.005, before, after: pays, estimate, labour: lab };
}

/** Write a reprice result onto the job the same way the estimator app does. */
function applyToJob(job, res, { by, why, sig, asOf } = {}) {
  const e = res.estimate;
  job.estimate = e;
  job.quote = e.customer_pays;
  job.finalEst = e.customer_pays;
  if (job.approval) job.approval = Object.assign({}, job.approval, { amount: e.customer_pays });
  const lab = e.lines.filter(l => l.kind === 'labour');
  const other = e.lines.filter(l => ['fixed', 'mot', 'panel'].indexOf(l.kind) > -1);
  job.labourCost = money(lab.concat(other).reduce((a, l) => a + (+l.total || 0), 0));
  job.labourDesc = lab.map(l => (l.label || 'Labour') + ': ' + Number(l.charged_hours).toFixed(2) + 'h @ \u00a3' + l.rate + '/hr = \u00a3' + Number(l.total).toFixed(2))
    .concat(other.map(l => (l.label || l.kind) + ' = \u00a3' + Number(l.total).toFixed(2))).join('\n');
  job.srtCharged = money(lab.reduce((a, l) => a + (+l.charged_hours || 0), 0));
  job.srtLines = lab.map(l => ({ op: l.label || 'Labour', book: l.srt, charged: l.charged_hours, by: by || 'SOP', at: logTime() }));
  if (sig) job.sopRulesSig = sig;
  if (asOf) job.sopRulesAt = asOf;
  job.log = (job.log || []).concat([{ t: logTime(),
    s: '\u267b Re-priced \u00a3' + res.before.toFixed(2) + ' \u2192 \u00a3' + res.after.toFixed(2) + (why ? ' \u2014 ' + why : '') + (by ? ' [' + by + ']' : '') }]);
  job.updatedAt = stamp();
  return job;
}

/**
 * The pipeline sweep. Which jobs move when the live rules change.
 * Returns { changed:[{job,before,after}], skipped:[{job,why}] } — the caller saves.
 */
// asOf = the store's updatedAt for `list`. A job already priced on a NEWER
// version by another screen is left alone, so two screens never flap a price.
function sweep(engine, jobs, list, { by = 'SOP amendments', asOf = null } = {}) {
  const sig = signature(list), changed = [], skipped = [];
  (jobs || []).forEach(j => {
    if (!j || !j.id || String(j.id).indexOf('__') === 0 || j.mergedInto) return;
    if (REPRICE_STAGES.indexOf(j.stage) < 0 || j.signedOff) return;
    if (!j.estimate) return;
    if (j.sopRulesSig === sig) return;
    if (asOf && j.sopRulesAt && j.sopRulesAt > asOf) return;
    const r = reprice(engine, j, list);
    if (r.skip) { skipped.push({ job: j, why: r.skip }); return; }
    if (!r.changed) { j.sopRulesSig = sig; if (asOf) j.sopRulesAt = asOf; return; }
    const why = 'SOP amendments changed' + (j.stage === 'signoff' ? ' \u2014 check before signing off' : '');
    applyToJob(j, r, { by, why, sig, asOf });
    changed.push({ job: j, before: r.before, after: r.after });
  });
  return { changed, skipped, sig };
}

/* ---------------------------------------------------------------- words --- */
function customersText(r) { return (r.customers || []).map(c => CUSTOMER_LABEL[c] || c).join(' & '); }
function describe(r) {
  if (r.kind === 'note') return r.text;
  const bits = [];
  if (r.multiplier != null) bits.push('multiplier \u00d7' + r.multiplier + (r.was && r.was.multiplier != null ? ' (was \u00d7' + r.was.multiplier + ')' : ''));
  if (r.rate != null) bits.push('labour rate \u00a3' + r.rate + '/hr ex VAT' + (r.was && r.was.rate != null ? ' (was \u00a3' + r.was.rate + ')' : ''));
  return cap(r.appliesTo) + ' \u2014 ' + customersText(r) + ': ' + bits.join(', ');
}
function cap(s) { s = String(s || ''); return s.charAt(0).toUpperCase() + s.slice(1); }

/** The block the AI reads before it answers. */
function toPromptBlock(list) {
  const rules = liveRules(list), notes = live(list).filter(r => r.kind === 'note');
  if (!rules.length && !notes.length) return '';
  const L = ['SOP AMENDMENTS \u2014 approved by Logan. Where one applies it OVERRIDES the base rules above.'];
  if (rules.length) {
    L.push('A labour line matches an amendment when its job name contains the words shown. ' +
      'An amendment multiplier is flat: it replaces the ladder for that line (never on ramp-exempt jobs). ' +
      'Never on AA or bodywork. A figure Logan set by hand on a job beats all of these.');
    rules.forEach(r => L.push('- ' + describe(r) + '. Why: ' + r.reason));
  }
  if (notes.length) {
    L.push('WHY LOGAN HAS TURNED QUOTES DOWN (approved lessons \u2014 avoid repeating these):');
    notes.forEach(n => L.push('- ' + n.text + (n.job ? ' (' + n.job + ')' : '')));
  }
  return L.join('\n');
}

/* ---------------------------------------------------------------- store --- */
// One row in `jobs`, the same pattern as __notifs__ and __schedcap__, so no new
// table or SQL is needed. Every write re-reads first and changes only what it means to.
function hdr(key, extra) {
  return Object.assign({ apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, extra || {});
}
async function load(url, key, fetchFn) {
  const f = fetchFn || fetch;
  const r = await f(String(url).replace(/\/$/, '') + '/rest/v1/jobs?id=eq.' + ROW + '&select=data', { headers: hdr(key) });
  if (!r.ok) throw new Error('SOP amendments: store returned ' + r.status);
  const rows = await r.json();
  const d = (rows && rows[0] && rows[0].data) || {};
  return { rules: Array.isArray(d.rules) ? d.rules : [], updatedAt: d.updatedAt || null };
}
async function update(url, key, change, fetchFn) {
  const f = fetchFn || fetch;
  const cur = await load(url, key, f);
  const rules = change(cur.rules.slice());
  const data = { rules, updatedAt: stamp(), signature: signature(rules), prompt: toPromptBlock(rules), version: VERSION };
  const r = await f(String(url).replace(/\/$/, '') + '/rest/v1/jobs', {
    method: 'POST', headers: hdr(key, { Prefer: 'resolution=merge-duplicates,return=minimal' }),
    body: JSON.stringify([{ id: ROW, data, updated_at: data.updatedAt }])
  });
  if (!r.ok) throw new Error('SOP amendments: save failed ' + r.status);
  return data;
}

return {
  VERSION, ROW, DECIDERS, KITH_CUSTOMERS, CUSTOMER_LABEL, STATUS, REPRICE_STAGES,
  MULT_MIN, MULT_MAX, RATE_MIN, RATE_MAX,
  canDecide, stem, words, phrases, matchScore,
  makeRule, makeNote, approve, reject, retire, pending, live, liveRules, signature, ruleFor,
  labour, working, reprice, applyToJob, sweep, handSet, customerOf,
  describe, customersText, toPromptBlock,
  load, update
};
}));
