/* KITH Adviser — the rules the CRM and the Service Adviser app share.
 *
 * Sending the quote, chasing for an answer, the deposit and terms gate,
 * offering booking slots, and the checks before a customer is told the
 * car is ready. Plain data in, plain data out, so it can be tested
 * without a browser and both screens follow the same rules.
 *
 * Every figure here matches the CRM (index.html) — the tests check that,
 * so the app and the board can't drift apart.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.KITHAdviser = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const VERSION = '1.0';

  // ── who pays what, and when ───────────────────────────────────
  const DEPOSIT_THRESHOLD = 200;   // quote inc VAT at or above this needs a deposit
  const DEPOSIT_PERCENT = 50;      // half up front, per the Service Adviser SOP
  const TC_PAGE = 'https://www.jotform.com/262225038229050';

  // ── the calendar ──────────────────────────────────────────────
  const SCHED_DAYS = { mechanical: [1, 2, 3, 4, 5, 6], bodywork: [1, 2, 3, 4, 5] };
  const JOB_DAY_RULES = [
    { re: /timing chain|cambelt|timing belt|cam belt/i, days: [5, 6, 0], label: 'timing chain (Fri/Sat/Sun only)' },
    { re: /brake pad|brake disc|brakes?\b|pads? (and|&) discs?/i, days: [1, 2, 3, 4, 5, 6], label: 'brakes (any working day)' }
  ];
  const DEFAULT_CAP = { mechanical: 3, bodywork: 2 };

  const num = v => { const n = parseFloat(v); return isFinite(n) ? n : 0; };
  const money = n => Math.round(n * 100) / 100;
  const gbp = n => '£' + num(n).toFixed(2);
  const dstr = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  function ts(d) { return (d || new Date()).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }); }
  function fmtBookDate(ds) {
    if (!ds) return '';
    const d = new Date(ds + 'T00:00:00');
    return isNaN(d.getTime()) ? ds : d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
  }
  function fmt12(t) {
    if (!t) return '';
    const m = String(t).match(/^(\d{1,2}):(\d{2})/); if (!m) return t;
    let h = parseInt(m[1], 10); const mi = m[2]; const ap = h >= 12 ? 'pm' : 'am';
    if (h === 0) h = 12; else if (h > 12) h -= 12;
    return h + (mi === '00' ? '' : ':' + mi) + ap;
  }

  // ── who the customer is, and what the job is ──────────────────
  function firstName(j) {
    const p = String((j && j.name) || '').trim().split(/\s+/).filter(Boolean);
    const T = /^(mr|mrs|ms|miss|mx|dr|prof|sir|madam|rev)\.?$/i;
    while (p.length > 1 && T.test(p[0])) p.shift();
    return p[0] || 'there';
  }
  function vehDesc(j, withReg) {
    const junk = v => { const t = String(v || '').trim(); return !t || /^[.…\-_/]+$/.test(t) || t.toLowerCase() === 'n/a' || t.toLowerCase() === 'na'; };
    const mm = [junk(j.make) ? '' : String(j.make).trim(), junk(j.model) ? '' : String(j.model).trim()].filter(Boolean).join(' ');
    const reg = String(j.reg || '').trim();
    if (mm && reg && withReg !== false) return mm + ' (' + reg + ')';
    return mm || reg || 'vehicle';
  }
  const BODYWORK_RE = /body ?work|bodywork|panel|bumper|wing|door skin|paint|respray|dent|scratch|arch|quarter|bonnet|tailgate|sill|accident|crash/i;
  const isBodywork = j => !!j && (BODYWORK_RE.test(String(j.work || '')) || BODYWORK_RE.test(String(j.notes || '')));
  function isClearlyBodywork(j) {
    const t = String((j && j.work) || '') + ' ' + String((j && j.labourDesc) || '');
    if (/\b(engine|brake|clutch|gearbox|suspension|oil|service|mot|diagnos\w*|exhaust|timing|coolant|battery|tyre|instrument)\b/i.test(t)) return false;
    return /\b(body ?work|panels?|bumpers?|wings?|door skin|paint\w*|respray|dents?|scratch\w*|arch|quarter|bonnet|tailgate|sills?|accident|crash)\b/i.test(t);
  }
  const jobRoute = j => isBodywork(j) ? 'bodywork' : 'mechanical';
  const schedSide = j => (j && (j.calSide === 'bodywork' || j.calSide === 'mechanical')) ? j.calSide : (isClearlyBodywork(j) ? 'bodywork' : 'mechanical');
  function allowedDays(j) {
    const txt = String((j && j.work) || '') + ' ' + String((j && j.notes) || '');
    for (const r of JOB_DAY_RULES) if (r.re.test(txt)) return { days: r.days, label: r.label };
    const side = schedSide(j);
    return { days: SCHED_DAYS[side], label: side + ' (normal days)' };
  }

  // ── deposit and terms ─────────────────────────────────────────
  // Mechanical only: half up front over £200. Bodywork is paid at the end,
  // and fleet accounts are on terms.
  const depositNeeded = j => !j.fleetAccount && jobRoute(j) === 'mechanical' && num(j.quote) >= DEPOSIT_THRESHOLD;
  const noDepositReason = j => j.fleetAccount ? 'Fleet account — on terms'
    : jobRoute(j) === 'bodywork' ? 'Bodywork — paid at the end'
    : 'Under ' + gbp(DEPOSIT_THRESHOLD);
  const depositAmount = j => money(num(j.quote) * DEPOSIT_PERCENT / 100);
  const depositDone = j => !!j.fleetAccount || !depositNeeded(j) || !!j.depositConfirmed;
  const tcDone = j => !!j.fleetAccount || !!j.tcAgreedAt;
  const readyToBook = j => depositDone(j) && tcDone(j);

  // ── chasing for an answer ─────────────────────────────────────
  // Two contacts a day — a call, then a message if there's no answer —
  // for the first two days, then it's a lost booking.
  const CHASE_STEPS = [
    { hrs: 1, day: 1, label: 'Day 1 · Phone call', call: true,
      build: j => 'Ring ' + (j.name || 'the customer') + ' about the estimate for ' + vehDesc(j) + ' — ' + gbp(j.quote) + '.' },
    { hrs: 4, day: 1, label: 'Day 1 · Text if no answer', call: false,
      build: j => 'Hi ' + firstName(j) + ', tried to give you a ring about your ' + vehDesc(j) + '. The estimate comes to ' + gbp(j.quote) + ' inc VAT. Any questions, just reply here and I will talk you through it. — KITH Cars' },
    { hrs: 8, day: 1, label: 'Day 1 · End of day nudge', call: false,
      build: j => 'Hi ' + firstName(j) + ', we are probably at the bottom of your phone by now — just a reminder about our quote for your ' + vehDesc(j) + ' (' + gbp(j.quote) + '). If you have found somewhere else that is no problem at all, just let us know and we will close it off. — KITH Cars' },
    { hrs: 25, day: 2, label: 'Day 2 · Phone call', call: true,
      build: j => 'Second day — ring ' + (j.name || 'the customer') + ' about ' + vehDesc(j) + '.' },
    { hrs: 28, day: 2, label: 'Day 2 · Text if no answer', call: false,
      build: j => 'Hi ' + firstName(j) + ', tried you again today about your ' + vehDesc(j) + '. Happy to hold the slot if you would like to go ahead — just reply either way. — KITH Cars' },
    { hrs: 32, day: 2, label: 'Day 2 · Last nudge', call: false,
      build: j => 'Hi ' + firstName(j) + ', last one from us on your ' + vehDesc(j) + '. If the timing is not right just say and we will close it off — no hard feelings, and we are here whenever you need us. — KITH Cars' }
  ];
  const CHASE_GIVE_UP_HRS = 48;
  const CHASE_STAGES = ['contacted', 'waiting', 'waiting2'];

  const hoursWaiting = (j, now) => { const from = j.stageAt || 0; return from ? ((now || Date.now()) - from) / 3600000 : 0; };
  function chaseDayOf(j, now) {
    if (j.stage === 'waiting2') return 2;
    const h = hoursWaiting(j, now);
    return h < 24 ? 1 : (h < 48 ? 2 : 3);
  }
  // What this job needs next: a step to do now, a wait, or give up.
  function chaseDue(j, now) {
    if (!CHASE_STAGES.includes(j.stage)) return null;
    const hrs = hoursWaiting(j, now);
    const done = (j.chasesSent || []).length;
    if (done >= CHASE_STEPS.length && hrs >= CHASE_GIVE_UP_HRS) return { giveUp: true, hrs };
    for (let i = done; i < CHASE_STEPS.length; i++) if (hrs >= CHASE_STEPS[i].hrs) return { step: i, cfg: CHASE_STEPS[i], hrs };
    const next = CHASE_STEPS[done];
    return next ? { waiting: true, nextIn: next.hrs - hrs, label: next.label, hrs } : { allSent: true, hrs };
  }
  function fmtWait(h) {
    if (h < 1) return Math.round(h * 60) + ' min';
    if (h < 24) return Math.round(h) + 'h';
    return Math.floor(h / 24) + 'd ' + Math.round(h % 24) + 'h';
  }

  // ── what we say ───────────────────────────────────────────────
  function quoteMsg(j) {
    return 'Hi ' + firstName(j) + ', thanks for bringing your ' + vehDesc(j) + ' to KITH Cars.\n\n' +
      'Work: ' + (j.work || 'as discussed') + '\n' +
      'Price: ' + gbp(j.quote) + ' inc VAT\n' +
      (depositNeeded(j) ? 'Deposit to book in: ' + gbp(depositAmount(j)) + '\n' : '') +
      '\nHappy to talk any of it through. Shall we get you booked in?\n\n— KITH Cars';
  }
  function tcMsg(j) {
    return 'Hi ' + firstName(j) + ', your booking with KITH Cars is nearly set.\n\n' +
      (j.reg ? 'Vehicle: ' + j.reg + '\n' : '') +
      'Work: ' + (j.work || 'as discussed') + '\n' +
      'Price: ' + gbp(j.quote) + ' inc VAT' + (j.fleetAccount && j.payTerms ? ' — ' + j.payTerms : '') + '\n' +
      (j.bookedFor ? 'Date: ' + fmtBookDate(j.bookedFor) + (j.bookedTime ? ' at ' + fmt12(j.bookedTime) : '') + '\n' : '') +
      '\n↓ Please read and sign our terms here:\n' + TC_PAGE +
      '\n\nQuote your reg (' + (j.reg || '') + ') on the form. Takes a minute.';
  }
  function depositMsg(j) {
    return 'Hi ' + firstName(j) + ', to hold the slot for your ' + vehDesc(j) + ' we take a deposit of ' +
      gbp(depositAmount(j)) + ' (' + DEPOSIT_PERCENT + '% of ' + gbp(j.quote) + '). The rest is due when the work is done.\n\n' +
      'Bank transfer is easiest — reply here and I will send the details over. — KITH Cars';
  }
  function slotsMsg(j, slots) {
    return 'Hi ' + firstName(j) + ', we can get your ' + vehDesc(j) + ' in on:\n\n' +
      (slots || []).slice(0, 3).map(s => '• ' + s.label).join('\n') +
      '\n\nThe earliest is filling up fastest — reply with the day that suits and we will lock it in for you.\n\n— KITH Cars';
  }
  function bookedMsg(j) {
    return 'Hi ' + firstName(j) + ', you are booked in ✓\n\n' +
      (j.reg ? 'Vehicle: ' + j.reg + '\n' : '') +
      'Work: ' + (j.work || 'as discussed') + '\n' +
      'Date: ' + fmtBookDate(j.bookedFor) + (j.bookedTime ? ' at ' + fmt12(j.bookedTime) : '') + '\n' +
      'Price: ' + gbp(j.quote) + ' inc VAT\n\n' +
      'We are at Unit 1, Soho Mills, London Road, Hackbridge SM6 7HN. Anything changes, just message us here. — KITH Cars';
  }
  function rebookMsg(j, eta) {
    return 'Hi ' + firstName(j) + ', quick one about your ' + vehDesc(j) + '. One of the parts is not with us until ' +
      fmtBookDate(eta) + ', which is after your slot on ' + fmtBookDate(j.bookedFor) + '.\n\n' +
      'Rather than have you bring it in and wait, shall we move you to the first day after that? — KITH Cars';
  }
  function readyMsg(j) {
    return 'Hi ' + firstName(j) + ', your ' + vehDesc(j) + ' is ready to collect ✓\n\n' +
      'Total: ' + gbp(j.quote) + ' inc VAT' + (num(j.depositPaid) ? ' (deposit of ' + gbp(j.depositPaid) + ' already paid)' : '') + '\n\n' +
      'We are open until 5pm. See you soon. — KITH Cars';
  }
  const waLink = (phone, msg) => 'https://wa.me/' + String(phone || '').replace(/^0/, '44').replace(/\D/g, '') + '?text=' + encodeURIComponent(msg);
  const telLink = phone => 'tel:' + String(phone || '').replace(/\s/g, '');

  // ── offering slots ────────────────────────────────────────────
  // jobs = everything on the board, so a full day can be spotted.
  // partsEta = the latest ETA of anything still on order for this job.
  function offerSlots(j, jobs, opts) {
    opts = opts || {};
    const horizon = opts.horizon || 21, maxSlots = opts.maxSlots || 6;
    const cap = (opts.cap || DEFAULT_CAP)[schedSide(j)] || 99;
    const side = schedSide(j), rule = allowedDays(j);
    const now = opts.now ? new Date(opts.now) : new Date();
    let from = new Date(now); from.setHours(0, 0, 0, 0);
    if (now.getHours() >= 15) from.setDate(from.getDate() + 1);     // too late to take a car in today
    if (opts.partsEta) { const p = new Date(opts.partsEta + 'T00:00:00'); if (p > from) from = p; }
    const booked = ds => (jobs || []).filter(x => x && x.bookedFor === ds && x.id !== j.id && x.stage !== 'lost' && !x.mergedInto && schedSide(x) === side).length;
    const out = [];
    for (let i = 0; i < horizon && out.length < maxSlots; i++) {
      const d = new Date(from); d.setDate(d.getDate() + i);
      if (rule.days.indexOf(d.getDay()) < 0) continue;
      const ds = dstr(d);
      if (booked(ds) >= cap) continue;
      out.push({ date: ds, weekday: d.getDay(), label: fmtBookDate(ds), taken: booked(ds), cap });
    }
    return { side, ruleLabel: rule.label, earliest: opts.partsEta || null, slots: out };
  }
  function slotProblems(j, ds, jobs, opts) {
    opts = opts || {};
    const out = [];
    if (!ds) return out;
    const d = new Date(ds + 'T00:00:00');
    if (isNaN(d.getTime())) return out;
    const side = schedSide(j), rule = allowedDays(j);
    if (rule.days.indexOf(d.getDay()) < 0) out.push('Wrong day for this job — ' + rule.label);
    const cap = (opts.cap || DEFAULT_CAP)[side] || 99;
    const n = (jobs || []).filter(x => x && x.bookedFor === ds && x.id !== j.id && x.stage !== 'lost' && !x.mergedInto && schedSide(x) === side).length;
    if (n >= cap) out.push('The ' + side + ' calendar is full that day (' + n + ' of ' + cap + ')');
    if (opts.partsEta && d < new Date(opts.partsEta + 'T00:00:00')) out.push('Parts are not due until ' + fmtBookDate(opts.partsEta));
    const today = opts.now ? new Date(opts.now) : new Date(); today.setHours(0, 0, 0, 0);
    if (d < today) out.push('That date has passed');
    return out;
  }

  // ── before a customer is told the car is ready (SOP v2.0) ─────
  const COLLECT_GATE = [
    { k: 'checkin', label: 'Check-in form done, including the diagnostic scan' },
    { k: 'damage', label: 'Photos of any damage' },
    { k: 'social', label: 'Photos for social media' },
    { k: 'invoice', label: 'Invoice raised, with the mileage on it' },
    { k: 'jobsheet', label: 'Job sheet filled out' }
  ];
  const collectGate = j => COLLECT_GATE.map(i => ({ k: i.k, label: i.label, done: !!((j.collectGate || {})[i.k]) }));
  const readyToCollect = j => collectGate(j).every(i => i.done);

  // ── the moves the adviser makes ───────────────────────────────
  const clone = o => JSON.parse(JSON.stringify(o));
  function stamp(j, to, by, now) {
    j.stage = to; j.stageAt = (now || new Date()).getTime();
    j.stageHistory = j.stageHistory || [];
    const last = j.stageHistory[j.stageHistory.length - 1];
    if (last && !last.left) last.left = j.stageAt;
    j.stageHistory.push({ stage: to, at: j.stageAt, by: by || '' });
    return j;
  }
  const logLine = (s, by, now) => ({ t: ts(now), s: s + (by ? ' [' + by + ']' : '') });

  // The quote has gone to the customer.
  function markSent(job, via, by, now) {
    const j = clone(job);
    j.quoteSentAt = ts(now); j.quoteSentVia = via || 'whatsapp';
    j.log = j.log || []; j.log.push(logLine('💬 Estimate sent to the customer via ' + (via || 'WhatsApp'), by, now));
    stamp(j, 'contacted', by, now);
    return j;
  }
  // A chase was made. step = index into CHASE_STEPS.
  function recordChase(job, step, outcome, by, now) {
    const cfg = CHASE_STEPS[step]; if (!cfg) throw new Error('No such chase step.');
    const j = clone(job);
    j.chasesSent = j.chasesSent || [];
    j.chasesSent.push({ step, label: cfg.label, at: ts(now), by: by || '', outcome: outcome || '' });
    j.log = j.log || [];
    j.log.push(logLine('💬 ' + cfg.label + (outcome ? ' — ' + outcome : '') + ' — ' + (j.name || 'customer'), by, now));
    if (j.stage === 'contacted') stamp(j, 'waiting', by, now);
    return j;
  }
  // The customer said yes: terms and the deposit step, then the diary.
  function customerYes(job, via, by, now) {
    const j = clone(job);
    j.customerYesAt = ts(now); j.customerYesVia = via || '';
    j.estApproved = true;
    j.log = j.log || [];
    j.log.push(logLine('✓ Customer said YES' + (via ? ' via ' + via : '') + ' — ' + jobRoute(j) + ' route', by, now));
    j.paymentPlan = jobRoute(j) === 'mechanical'
      ? { type: 'deposit', pct: DEPOSIT_PERCENT, of: 'quote', amount: depositAmount(j), reason: 'mechanical — half up front, covers the parts' }
      : { type: 'flexible', cashAllowed: true, reason: 'bodywork — pays at the end' };
    stamp(j, 'ready', by, now);
    return j;
  }
  function customerNo(job, why, by, now) {
    const j = clone(job);
    j.lostReason = String(why || '').trim();
    j.log = j.log || []; j.log.push(logLine('✕ Lost' + (j.lostReason ? ' — ' + j.lostReason : ''), by, now));
    stamp(j, 'lost', by, now);
    return j;
  }
  function markTerms(job, by, now) {
    const j = clone(job);
    j.tcAgreedAt = ts(now);
    j.log = j.log || []; j.log.push(logLine('✓ Terms signed', by, now));
    return j;
  }
  function markDeposit(job, amount, method, by, now) {
    const amt = num(amount);
    if (!amt) throw new Error('How much did they send?');
    const j = clone(job);
    j.payments = j.payments || [];
    j.payments.push({ amount: amt, method: String(method || '').trim() || 'Deposit', ref: 'DEPOSIT', at: ts(now), by: by || '' });
    j.depositConfirmed = true; j.depositAt = ts(now); j.depositPaid = amt;
    j.log = j.log || []; j.log.push(logLine('£ Deposit received — ' + gbp(amt) + ' by ' + (method || 'transfer'), by, now));
    return j;
  }
  // Into the diary. Refuses while the deposit or terms are outstanding
  // unless the adviser says why (that reason goes on the job).
  function book(job, date, time, by, now, override) {
    if (!date) throw new Error('Pick a day first.');
    const j = clone(job);
    if (!readyToBook(j)) {
      if (!override) {
        const miss = [depositDone(j) ? null : 'deposit', tcDone(j) ? null : 'terms'].filter(Boolean);
        const e = new Error('Not ready to book — ' + miss.join(' and ') + ' outstanding.');
        e.missing = miss; throw e;
      }
      j.log = j.log || []; j.log.push(logLine('⚠ Booked in anyway — ' + override, by, now));
    }
    j.bookedFor = date; j.bookedTime = time || '';
    j.log = j.log || [];
    j.log.push(logLine('📅 Booked in for ' + fmtBookDate(date) + (time ? ' at ' + fmt12(time) : ''), by, now));
    stamp(j, 'booked', by, now);
    return j;
  }
  function setCollectItem(job, key, on, by, now) {
    const j = clone(job);
    j.collectGate = j.collectGate || {};
    j.collectGate[key] = !!on;
    const label = (COLLECT_GATE.find(i => i.k === key) || {}).label || key;
    j.log = j.log || []; j.log.push(logLine((on ? '✓ ' : '✕ ') + label, by, now));
    return j;
  }
  // Only once all five are done. Then it is accounts' job, not the adviser's.
  function tellReady(job, by, now) {
    const j = clone(job);
    if (!readyToCollect(j)) { const e = new Error('Not everything is done yet.'); e.missing = collectGate(j).filter(i => !i.done).map(i => i.label); throw e; }
    j.readyToldAt = ts(now);
    j.log = j.log || []; j.log.push(logLine('💬 Customer told the car is ready', by, now));
    stamp(j, 'accounts', by, now);
    return j;
  }

  return {
    VERSION, DEPOSIT_THRESHOLD, DEPOSIT_PERCENT, TC_PAGE, SCHED_DAYS, JOB_DAY_RULES, DEFAULT_CAP,
    CHASE_STEPS, CHASE_GIVE_UP_HRS, CHASE_STAGES, COLLECT_GATE,
    firstName, vehDesc, isBodywork, isClearlyBodywork, jobRoute, schedSide, allowedDays,
    depositNeeded, noDepositReason, depositAmount, depositDone, tcDone, readyToBook,
    hoursWaiting, chaseDayOf, chaseDue, fmtWait,
    quoteMsg, tcMsg, depositMsg, slotsMsg, bookedMsg, rebookMsg, readyMsg, waLink, telLink,
    offerSlots, slotProblems, collectGate, readyToCollect,
    markSent, recordChase, customerYes, customerNo, markTerms, markDeposit, book, setCollectItem, tellReady,
    ts, gbp, fmtBookDate, fmt12, dstr
  };
});
