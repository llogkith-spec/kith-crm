/* =============================================================================
   KITH LEARNING STORE v1.0
   =============================================================================
   What this is, precisely:

     NOT the model learning. Claude is never retrained on KITH data and never
     will be. This is a record of what actually happened at KITH, aggregated
     into advice, and injected into the prompt before the AI answers.

   Why that distinction matters: a memory can be inspected, corrected and
   switched off. A retrained model cannot. When this gets something wrong you
   can see exactly which jobs caused it and retire them.

   THE ONE RULE: only CONFIRMED OUTCOMES go in.
   Actual hours from a finished job. A rejection reason from Logan. A comeback.
   The AI's own suggestions never enter the store — an AI learning from its own
   output drifts further from reality with every pass, confidently.

   Works in Node and the browser. No dependencies.
   ============================================================================= */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.KITHLearn = factory();
}(typeof self !== 'undefined' ? self : this, function () {
'use strict';

const VERSION = '1.0';

/* --------------------------------------------------------------- domains --- */
// One store, partitioned by domain. Each section of the business gets its own
// brain, but they share one approval queue — Logan approves in one place, not
// six. A brain only ever reads its own domain, so a parts lesson can never
// influence a labour answer.
const DOMAINS = {
  // Labour and parts are ONE brain. A quote is both together, and the
  // interesting lessons cross the line: the job ran long BECAUSE the wrong
  // part turned up. Split them and neither half ever learns that.
  estimating: { label: 'Estimating', what: 'SRTs, tiers, real hours, supplier prices, lead times, what actually fits' },
  bodywork:   { label: 'Bodywork',   what: 'panel times, paint, damage assessment' },
  adviser:    { label: 'Service adviser', what: 'what customers say and what it turns out to be' },
  recovery:   { label: 'Recovery',   what: 'distances, access, what a job really costs us' },
  accounts:   { label: 'Accounts',   what: 'payment behaviour, chasing, terms' }
};
const DEFAULT_DOMAIN = 'estimating';

// Anything written before the merge still resolves.
const DOMAIN_ALIASES = { labour: 'estimating', parts: 'estimating' };
function resolveDomain(d) {
  const k = String(d || DEFAULT_DOMAIN);
  return DOMAIN_ALIASES[k] || k;
}

function isDomain(d) { return Object.prototype.hasOwnProperty.call(DOMAINS, resolveDomain(d)); }

/* -------------------------------------------------------------- approval --- */
// Two independent gates. A record must pass BOTH before it teaches anything:
//   confirmed  - it is a real outcome, not something the AI proposed
//   status     - a human with authority has let it in
// Anyone can propose. Only these names can approve.
const APPROVERS = ['Logan'];
const STATUS = { PENDING: 'pending', APPROVED: 'approved', REJECTED: 'rejected', RETIRED: 'retired' };

function canApprove(who) {
  return APPROVERS.indexOf(String(who || '').trim()) > -1;
}

/* ---------------------------------------------------------------- tuning --- */
const MIN_SAMPLE      = 3;     // below this, we report but never advise
const HIGH_CONFIDENCE = 6;     // at or above this, advice is stated plainly
const DRIFT_FLAG      = 1.15;  // actual/SRT above this = book time is optimistic
const DRIFT_LOW       = 0.85;  // below this = book time is generous
const PREREQ_COMMON   = 0.5;   // seen in half or more = mention it every time
const OUTLIER_FACTOR  = 3;     // discard anything 3x the median, both ways

/* ------------------------------------------------------------------ keys --- */
// Vehicles are grouped by make + model + engine. Year is deliberately excluded:
// a 2016 and a 2019 Focus cambelt are the same job, and splitting by year
// would mean never reaching a useful sample size.
function vehicleKey(v) {
  const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9.]/g, '');
  const k = [norm(v.make), norm(v.model), norm(v.engine)].filter(Boolean).join('|');
  return k || 'unknown';
}
function jobKey(j) {
  const norm = s => String(s || '').toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  return [norm(j.category), norm(j.name)].filter(Boolean).join('|') || 'unknown';
}
const recordKey = (v, j) => vehicleKey(v) + '::' + jobKey(j);

/* ----------------------------------------------------------------- stats --- */
function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function dropOutliers(xs) {
  if (xs.length < 4) return xs;               // too few to judge
  const m = median(xs);
  if (!m) return xs;
  return xs.filter(x => x <= m * OUTLIER_FACTOR && x >= m / OUTLIER_FACTOR);
}

/* =============================================================================
   RECORD TYPES — the four things worth learning from
   ============================================================================= */

/**
 * 1. HOURS — the big one. What the book said versus what it took.
 *    Requires actual_hours, which nothing at KITH currently records.
 */
function hoursRecord({ jobId, vehicle, job, srtQuoted, chargedHours,
                       actualHours, prerequisitesFound = [], note = '', at,
                       domain = DEFAULT_DOMAIN }) {
  if (!(actualHours > 0)) throw new Error('hoursRecord needs actualHours — that is the whole point');
  if (!(srtQuoted > 0))   throw new Error('hoursRecord needs the SRT that was quoted');
  return {
    type: 'hours', domain, key: recordKey(vehicle, job), jobId,
    vehicle: { make: vehicle.make, model: vehicle.model, engine: vehicle.engine },
    job: { category: job.category, name: job.name },
    srtQuoted, chargedHours, actualHours,
    prerequisitesFound, note,
    at: at || new Date().toISOString(),
    confirmed: true
  };
}

/**
 * 2. CORRECTION — a human changed what the AI proposed. Tier, category, routing.
 */
function correctionRecord({ jobId, vehicle, job, field, aiSaid, humanSaid, by, reason = '', at,
                            domain = DEFAULT_DOMAIN }) {
  return {
    type: 'correction', domain, key: recordKey(vehicle, job), jobId,
    job: { category: job.category, name: job.name },
    field, aiSaid, humanSaid, by, reason,
    at: at || new Date().toISOString(), confirmed: true
  };
}

/**
 * 3. REJECTION — Logan sent a quote back at sign-off, and why.
 */
function rejectionRecord({ jobId, vehicle, job, amount, reason, by, at,
                           domain = DEFAULT_DOMAIN }) {
  if (!reason) throw new Error('a rejection with no reason teaches nothing');
  return {
    type: 'rejection', domain, key: recordKey(vehicle, job), jobId,
    job: { category: job.category, name: job.name },
    amount, reason, by, at: at || new Date().toISOString(), confirmed: true
  };
}

/**
 * 4. COMEBACK — the strongest quality signal there is. The work returned.
 */
function comebackRecord({ jobId, originalJobId, vehicle, job, verdict, whatWentWrong = '', at,
                          domain = DEFAULT_DOMAIN }) {
  return {
    type: 'comeback', domain, key: recordKey(vehicle, job), jobId, originalJobId,
    job: { category: job.category, name: job.name },
    verdict, whatWentWrong,
    at: at || new Date().toISOString(), confirmed: true
  };
}

/**
 * 5. PARTS — what the supplier actually charged and actually delivered.
 *    The other half of an estimate. A price quoted on the phone in March is
 *    not the price in August, and "next day" is a claim, not a fact.
 */
function partsRecord({ jobId, vehicle, job, supplier, part,
                       netQuoted, netCharged, etaPromisedDays, etaActualDays,
                       fittedOk = true, whatWentWrong = '', at,
                       domain = DEFAULT_DOMAIN }) {
  if (!supplier) throw new Error('a parts lesson needs to say which supplier');
  if (!part)     throw new Error('a parts lesson needs to say which part');
  return {
    type: 'parts', domain, key: recordKey(vehicle, job), jobId,
    vehicle: { make: vehicle.make, model: vehicle.model, engine: vehicle.engine },
    job: { category: job.category, name: job.name },
    supplier: String(supplier).trim(), part: String(part).trim(),
    netQuoted, netCharged, etaPromisedDays, etaActualDays,
    fittedOk: fittedOk !== false, whatWentWrong,
    at: at || new Date().toISOString(), confirmed: true
  };
}

/* =============================================================================
   THE APPROVAL LIFECYCLE
   Anyone on the floor can propose a lesson. Nothing takes effect until it is
   approved. A rejected lesson is kept, not deleted — knowing what was turned
   down is as useful as knowing what got in.
   ============================================================================= */

/**
 * Wrap a record as a proposal. This is what the "teach the brain" button makes.
 * It has no effect on any answer until somebody approves it.
 */
function propose(record, { by, why = '' }) {
  if (!by) throw new Error('a proposal needs a name against it');
  const gate = accept(record);
  if (!gate.ok) throw new Error('cannot propose: ' + gate.reasons.join('; '));
  return Object.assign({}, record, {
    status: STATUS.PENDING,
    proposedBy: by,
    proposedAt: new Date().toISOString(),
    why: why
  });
}

/**
 * Let a proposal into the store. Only an approver may do this.
 * The edit is recorded on the record itself, so it can always be traced back.
 */
function approve(record, { by, note = '' }) {
  if (!canApprove(by))
    throw new Error(by + ' cannot approve what the brain learns. Only ' + APPROVERS.join(', ') + '.');
  if (record.status === STATUS.APPROVED) return record;
  return Object.assign({}, record, {
    status: STATUS.APPROVED, approvedBy: by,
    approvedAt: new Date().toISOString(), approvalNote: note
  });
}

/** Turn a proposal down. A reason is required — a silent no teaches nobody. */
function reject(record, { by, reason }) {
  if (!canApprove(by))
    throw new Error(by + ' cannot reject what the brain learns.');
  if (!reason) throw new Error('a rejection needs a reason');
  return Object.assign({}, record, {
    status: STATUS.REJECTED, rejectedBy: by,
    rejectedAt: new Date().toISOString(), rejectionReason: reason
  });
}

/**
 * Pull something back out that has already been approved — because it turned
 * out to be wrong. This is why a memory beats a retrained model: it is
 * reversible, and you can see exactly what changed.
 */
function retire(record, { by, reason }) {
  if (!canApprove(by)) throw new Error(by + ' cannot retire a lesson.');
  if (!reason) throw new Error('retiring a lesson needs a reason');
  return Object.assign({}, record, {
    status: STATUS.RETIRED, retiredBy: by,
    retiredAt: new Date().toISOString(), retirementReason: reason
  });
}

/**
 * Everything waiting on a decision, oldest first.
 * Pass a domain to see one brain's queue; omit it for Logan's whole queue.
 */
function pending(records, domain) {
  return records.filter(r => r.status === STATUS.PENDING)
    .filter(r => !domain || resolveDomain(r.domain) === resolveDomain(domain))
    .sort((a, b) => String(a.proposedAt || '').localeCompare(String(b.proposedAt || '')));
}

/**
 * Only these records ever influence an answer.
 * A domain is a wall, not a filter: a parts lesson can never reach a labour
 * answer, because every read passes through here with its own domain.
 */
function live(records, domain) {
  return records.filter(r => r.status === STATUS.APPROVED && r.confirmed === true)
    .filter(r => !domain || resolveDomain(r.domain) === resolveDomain(domain));
}

/* =============================================================================
   AGGREGATION — records in, advice out
   ============================================================================= */

/**
 * Everything KITH knows about one vehicle + job combination.
 * Returns null when there is nothing worth saying.
 */
function summarise(records, vehicle, job, domain = DEFAULT_DOMAIN) {
  const key = recordKey(vehicle, job);
  // live() is the gate: pending and rejected records are invisible here,
  // so a proposal genuinely has no effect until it is approved.
  const mine = live(records, domain).filter(r => r.key === key);
  if (!mine.length) return null;

  const hours      = mine.filter(r => r.type === 'hours');
  const partsRecs  = mine.filter(r => r.type === 'parts');
  const corrections= mine.filter(r => r.type === 'correction');
  const rejections = mine.filter(r => r.type === 'rejection');
  const comebacks  = mine.filter(r => r.type === 'comeback');

  const out = {
    key, domain, vehicle, job,
    sample: hours.length,
    confidence: hours.length >= HIGH_CONFIDENCE ? 'high'
              : hours.length >= MIN_SAMPLE      ? 'medium' : 'low',
    advise: hours.length >= MIN_SAMPLE,
    srtMedian: null, actualMedian: null, ratio: null, drift: null,
    commonPrerequisites: [], corrections: [], rejections: [],
    comebackCount: comebacks.length, comebackNotes: [],
    parts: null
  };

  if (partsRecs.length) {
    const bySupplier = {};
    partsRecs.forEach(r => {
      const k = r.supplier.toLowerCase();
      (bySupplier[k] = bySupplier[k] || { supplier: r.supplier, n: 0,
        priceDrift: [], etaSlip: [], wrongParts: 0 });
      const b = bySupplier[k];
      b.n++;
      if (r.netQuoted > 0 && r.netCharged > 0) b.priceDrift.push(r.netCharged / r.netQuoted);
      if (r.etaPromisedDays != null && r.etaActualDays != null)
        b.etaSlip.push(r.etaActualDays - r.etaPromisedDays);
      if (r.fittedOk === false) b.wrongParts++;
    });
    out.parts = {
      sample: partsRecs.length,
      suppliers: Object.keys(bySupplier).map(k => {
        const b = bySupplier[k];
        return {
          supplier: b.supplier, jobs: b.n,
          priceRatio: b.priceDrift.length ? Math.round(median(b.priceDrift) * 100) / 100 : null,
          etaSlipDays: b.etaSlip.length ? median(b.etaSlip) : null,
          wrongParts: b.wrongParts
        };
      }).sort((a, b) => b.jobs - a.jobs),
      commonParts: (function () {
        const c = {};
        partsRecs.forEach(r => { const k = r.part.toLowerCase(); c[k] = (c[k] || 0) + 1; });
        return Object.keys(c).filter(k => c[k] >= 2)
          .map(k => ({ part: k, times: c[k] })).sort((a, b) => b.times - a.times);
      })()
    };
  }

  if (hours.length) {
    const srts    = dropOutliers(hours.map(r => r.srtQuoted));
    const actuals = dropOutliers(hours.map(r => r.actualHours));
    out.srtMedian    = median(srts);
    out.actualMedian = median(actuals);
    if (out.srtMedian > 0) {
      out.ratio = Math.round((out.actualMedian / out.srtMedian) * 100) / 100;
      out.drift = out.ratio >= DRIFT_FLAG ? 'srt_optimistic'
                : out.ratio <= DRIFT_LOW  ? 'srt_generous' : 'srt_about_right';
    }
    // a prerequisite seen in half the jobs or more is not a surprise any more
    const counts = {};
    hours.forEach(r => (r.prerequisitesFound || []).forEach(p => {
      const k = String(p).toLowerCase().trim();
      counts[k] = (counts[k] || 0) + 1;
    }));
    out.commonPrerequisites = Object.keys(counts)
      .filter(k => counts[k] / hours.length >= PREREQ_COMMON)
      .map(k => ({ prerequisite: k, seen: counts[k], of: hours.length }))
      .sort((a, b) => b.seen - a.seen);
  }

  // corrections repeated more than once are a pattern, not a one-off
  const cc = {};
  corrections.forEach(r => {
    const k = r.field + ': ' + r.aiSaid + ' -> ' + r.humanSaid;
    cc[k] = (cc[k] || 0) + 1;
  });
  out.corrections = Object.keys(cc).filter(k => cc[k] > 1)
    .map(k => ({ correction: k, times: cc[k] })).sort((a, b) => b.times - a.times);

  out.rejections = rejections.slice(-3).map(r => ({ reason: r.reason, amount: r.amount }));
  out.comebackNotes = comebacks.map(c => c.whatWentWrong).filter(Boolean).slice(-3);

  return out;
}

/**
 * Turn a summary into the plain-English block that goes into the prompt.
 * Deliberately hedged when the sample is thin — thin evidence stated
 * confidently is worse than no evidence at all.
 */
function toPromptBlock(sum) {
  if (!sum) return '';
  const L = [];
  const dom = DOMAINS[sum.domain] || DOMAINS[DEFAULT_DOMAIN];
  L.push(`WHAT KITH HAS LEARNED \u2014 ${dom.label.toUpperCase()}`);
  L.push(`(${sum.vehicle.make || '?'} ${sum.vehicle.model || ''} ${sum.vehicle.engine || ''} — ${sum.job.name})`);

  if (!sum.sample) {
    L.push(`No completed jobs of this kind on record yet.`);
  } else if (!sum.advise) {
    L.push(`Only ${sum.sample} completed job(s) on record — too few to draw on.`);
    L.push(`For information only: book time ${sum.srtMedian} hr, actual ${sum.actualMedian} hr.`);
    L.push(`Do NOT adjust anything on the strength of this. Mention it, nothing more.`);
  } else {
    L.push(`${sum.sample} completed jobs on record (${sum.confidence} confidence).`);
    L.push(`Book time median ${sum.srtMedian} hr. Actual median ${sum.actualMedian} hr. Ratio ${sum.ratio}.`);
    if (sum.drift === 'srt_optimistic')
      L.push(`THE BOOK TIME RUNS SHORT HERE — about ${Math.round((sum.ratio - 1) * 100)}% short on average. Say so in your critique.`);
    if (sum.drift === 'srt_generous')
      L.push(`The book time runs long here — the job usually comes in under. Worth noting, not worth acting on alone.`);
  }

  if (sum.commonPrerequisites.length) {
    L.push(`PREREQUISITES KITH KEEPS HITTING:`);
    sum.commonPrerequisites.forEach(p =>
      L.push(`  - ${p.prerequisite} (${p.seen} of ${p.of} jobs)`));
  }
  if (sum.parts && sum.parts.sample) {
    L.push(`PARTS — what suppliers actually did on this job (${sum.parts.sample} time(s)):`);
    sum.parts.suppliers.forEach(sp => {
      const bits = [`${sp.supplier} (${sp.jobs})`];
      if (sp.priceRatio && sp.priceRatio >= 1.05)
        bits.push(`charged ${Math.round((sp.priceRatio - 1) * 100)}% over the phone quote`);
      if (sp.priceRatio && sp.priceRatio <= 0.95)
        bits.push(`came in under the phone quote`);
      if (sp.etaSlipDays > 0) bits.push(`ran ${sp.etaSlipDays} day(s) late`);
      if (sp.wrongParts) bits.push(`WRONG PART ${sp.wrongParts} time(s)`);
      L.push(`  - ${bits.join(', ')}`);
    });
    L.push(`  Phone for a fresh price anyway. This is what happened, not what it costs today.`);
  }
  if (sum.corrections.length) {
    L.push(`CORRECTIONS STAFF HAVE MADE MORE THAN ONCE:`);
    sum.corrections.forEach(c => L.push(`  - ${c.correction} (${c.times} times)`));
  }
  if (sum.rejections.length) {
    L.push(`QUOTES SENT BACK AT SIGN-OFF:`);
    sum.rejections.forEach(r => L.push(`  - ${r.reason}`));
  }
  if (sum.comebackCount) {
    L.push(`THIS JOB HAS COME BACK ${sum.comebackCount} TIME(S). Treat the estimate with extra care.`);
    sum.comebackNotes.forEach(n => L.push(`  - ${n}`));
  }

  L.push(`This is KITH's own history, not a rule. The SOP still decides the price.`);
  return L.join('\n');
}

/* =============================================================================
   HOUSE VIEW — what KITH has learned across everything, not one job
   ============================================================================= */
function houseView(records, domain) {
  const hours = live(records, domain).filter(r => r.type === 'hours');
  const byCategory = {};
  hours.forEach(r => {
    const c = r.job.category || 'unknown';
    (byCategory[c] = byCategory[c] || []).push(r.actualHours / r.srtQuoted);
  });
  const drift = Object.keys(byCategory)
    .filter(c => byCategory[c].length >= MIN_SAMPLE)
    .map(c => ({
      category: c, sample: byCategory[c].length,
      ratio: Math.round(median(dropOutliers(byCategory[c])) * 100) / 100
    }))
    .filter(x => x.ratio >= DRIFT_FLAG || x.ratio <= DRIFT_LOW)
    .sort((a, b) => b.ratio - a.ratio);

  const rejections = live(records, domain).filter(r => r.type === 'rejection');
  const rc = {};
  rejections.forEach(r => {
    const k = String(r.reason).toLowerCase().slice(0, 60);
    rc[k] = (rc[k] || 0) + 1;
  });
  const topRejections = Object.keys(rc).map(k => ({ reason: k, times: rc[k] }))
    .filter(x => x.times > 1).sort((a, b) => b.times - a.times).slice(0, 5);

  return {
    domain: domain || 'all',
    totalRecords: domain ? records.filter(r => resolveDomain(r.domain) === resolveDomain(domain)).length : records.length,
    liveRecords: live(records, domain).length,
    awaitingApproval: pending(records, domain).length,
    completedJobsWithHours: hours.length,
    categoriesDrifting: drift,
    repeatedRejections: topRejections,
    comebacks: live(records, domain).filter(r => r.type === 'comeback').length
  };
}

/* =============================================================================
   THE GATE — nothing enters the store without passing this
   ============================================================================= */
function accept(record) {
  const reasons = [];
  if (!record || !record.type) reasons.push('no record type');
  if (record && record.confirmed !== true)
    reasons.push('not a confirmed outcome — only finished jobs and human decisions learn');
  if (record && record.source === 'ai')
    reasons.push('came from the AI — the store never learns from its own output');
  if (record && record.type === 'hours') {
    if (!(record.actualHours > 0)) reasons.push('no actual hours');
    if (!(record.srtQuoted > 0))   reasons.push('no quoted SRT to compare against');
    if (record.actualHours > 100)  reasons.push('actual hours look like a typo');
  }
  if (record && record.type === 'parts') {
    if (!record.supplier) reasons.push('no supplier named');
    if (!record.part)     reasons.push('no part named');
  }
  if (record && record.type === 'rejection' && !record.reason)
    reasons.push('a rejection with no reason teaches nothing');
  if (record && record.domain && !isDomain(record.domain))
    reasons.push('unknown domain: ' + record.domain);
  return { ok: reasons.length === 0, reasons };
}

return {
  VERSION, MIN_SAMPLE, HIGH_CONFIDENCE, DRIFT_FLAG, DRIFT_LOW,
  APPROVERS, STATUS, canApprove,
  DOMAINS, DEFAULT_DOMAIN, isDomain,
  propose, approve, reject, retire, pending, live,
  vehicleKey, jobKey, recordKey, median, dropOutliers,
  hoursRecord, correctionRecord, rejectionRecord, comebackRecord, partsRecord,
  DOMAIN_ALIASES, resolveDomain,
  summarise, toPromptBlock, houseView, accept
};
}));
