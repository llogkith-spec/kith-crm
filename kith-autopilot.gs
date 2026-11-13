/* =============================================================================
   KITH AUTOPILOT  ·  kith-autopilot.gs  ·  v1.0 (13 Nov 2026)
   =============================================================================
   The part that works when nobody has the CRM or the inbox open. It runs once
   a minute on Google's servers, next to kith-relay.gs, in the SAME Apps Script
   project (it uses the relay's Script Properties and its sendMessage()).

   Every minute it does three things:

     1. TRIAGE    New inbox messages (last 24 h) go through the triage AI —
                  exactly what kith-inbox.html does when it is open: a rapid
                  fire price range for retail mechanical enquiries, otherwise
                  a short "we've got your enquiry" reply, plus a WhatsApp ping
                  to the right person. Ambiguous ones are left for Logan.
     2. RANGE     Retail jobs typed in on the intake form get their instant
                  price range from the Brain on WhatsApp — the same message
                  as the CRM's "Send this range" button. Not for trade, AA,
                  warranty, insurance, comebacks, walk-ins, BMG, MOT-only,
                  tyre-fit-only, recovery, "diagnostic first" (safety) jobs,
                  or a customer the inbox already sent a range to.
     3. SEND      Empties the outbox: every queued WhatsApp message from the
                  inbox and the CRM (acks, ranges, staff pings, the quote you
                  approve at sign-off) goes out through the relay. Outside
                  Meta's 24-hour window it uses the approved template instead
                  (see WHATSAPP-TEMPLATES.md). Nothing older than 24 h is
                  sent, so an old backlog never goes out by surprise.

   MODES — Script property AUTOPILOT
     off   does nothing
     test  (default) triages and works out ranges, but sends NOTHING to a
           customer. The CRM job log shows "Autopilot would send …" so you can
           check the wording and the prices first.
     on    sends for real

   Script Properties it reads (the relay already has the first four)
     META_TOKEN, PHONE_ID, SB_URL, SB_KEY     — as for kith-relay.gs
     AUTOPILOT          off | test | on                       (default test)
     AP_TRIAGE          on | off   inbox triage step          (default on)
     AP_RANGE           on | off   intake-form range step     (default on)
     AP_SEND            on | off   outbox sender step         (default on)
     AP_MAX_AGE_HOURS   oldest message/job it will act on     (default 24)
     INBOX_URL          link put in staff pings (default the GitHub page)

   SET UP
     1. In the relay's Apps Script project: + → Script → name it
        kith-autopilot, paste this whole file in, save.
     2. Run autopilotSetup() once from the editor (approve the permissions).
        It adds the one-minute trigger and tells you what is missing.
     3. Leave AUTOPILOT on test for a day. Check the CRM job logs and the
        inbox. Then set AUTOPILOT = on.
   ============================================================================= */

var AP_VERSION = '1.0';

/* --------------------------------------------------------------- config --- */
function apProp(k, d) {
  var v = PropertiesService.getScriptProperties().getProperty(k);
  return v == null || v === '' ? (d == null ? '' : d) : v;
}
function apMode() {
  var m = String(apProp('AUTOPILOT', 'test')).toLowerCase().trim();
  return m === 'on' || m === 'off' ? m : 'test';
}
function apOn(k) { return String(apProp(k, 'on')).toLowerCase().trim() !== 'off'; }
function apMaxAgeMs() { return (parseFloat(apProp('AP_MAX_AGE_HOURS', '24')) || 24) * 3600e3; }

// Per-run limits keep one run well inside Apps Script's 6-minute limit
var AP_LIMIT = { triage: 4, range: 3, send: 25 };

// Who gets the staff ping for each triage category — same table as the inbox
var AP_STAFF_BY_ROLE = {
  adviser:  [{ name: 'Ali', wa: '2348126024190' }, { name: 'Elvis', wa: '' }],
  parts:    [{ name: 'Sudha', wa: '447514422991' }, { name: 'Giles', wa: '447496673248' }, { name: 'Harith', wa: '' }, { name: 'Paul', wa: '' }],
  accounts: [{ name: 'Sudha', wa: '447514422991' }, { name: 'Logan', wa: '' }],
  director: [{ name: 'Logan', wa: '' }]
};

// The template to use when Meta says we are outside the 24-hour window.
// Each returns [templateName, params] or null when it cannot be templated.
var AP_TEMPLATES = {
  triage_rapid_fire: function (m, ctx) {
    var l = ctx.lead, rf = l && l.triage && l.triage.rapidFireRange;
    if (!rf || !rf.lo || !rf.hi) return null;
    return ['kith_price_range', [apFirst(l.name), String(Math.round(rf.lo)), String(Math.round(rf.hi))]];
  },
  range: function (m, ctx) {
    var j = ctx.job; if (!j || !j.rangeLow) return null;
    return ['kith_price_range', [apFirst(j.name), String(j.rangeLow), String(j.rangeHigh)]];
  },
  triage_ack: function (m, ctx) {
    return ['kith_enquiry_received', [apFirst(ctx.lead ? ctx.lead.name : '')]];
  },
  staff_ping: function (m) {
    return ['kith_staff_alert', [apOneLine(m.text, 200)]];
  },
  quote: function (m, ctx) {
    var j = ctx.job; if (!j) return null;
    var amt = parseFloat(j.quote) || parseFloat(j.finalEst) || 0;
    var doc = apEstDoc(j);
    // With the TechMan PDF: the same kith_estimate template the CRM uses
    if (doc) return ['kith_estimate', [apFirst(j.name), apVeh(j), amt ? '£' + amt.toFixed(2) + ' including VAT' : 'on the attached estimate'], doc];
    if (!amt) return null;
    return ['kith_quote_ready', [apFirst(j.name), apVeh(j), amt.toFixed(2)]];
  }
};

/* ----------------------------------------------------------- setup / run -- */
function autopilotSetup() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'autopilotRun') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('autopilotRun').timeBased().everyMinutes(1).create();
  var need = ['SB_URL', 'SB_KEY', 'META_TOKEN', 'PHONE_ID'].filter(function (k) { return !apProp(k); });
  var msg = 'Autopilot v' + AP_VERSION + ' — trigger added (every minute). Mode: ' + apMode() + '.' +
    (need.length ? ' MISSING Script properties: ' + need.join(', ') + ' — triage and ranges still run, sending waits.' : ' All properties present.');
  console.log(msg);
  return msg;
}

function autopilotRun() {
  // Its own "running" marker, NOT the script lock: kith-relay.gs takes the
  // script lock for every incoming customer message, and holding it here for
  // a minute could make Meta's webhook time out and drop a message.
  var cache = CacheService.getScriptCache();
  var mine = String(Date.now()) + Math.random();
  if (cache.get('ap-running')) return { skipped: 'another run is still going' };
  cache.put('ap-running', mine, 330);               // expires on its own after 5½ min
  var lock = { releaseLock: function () { if (cache.get('ap-running') === mine) cache.remove('ap-running'); } };
  var out ={ at: new Date().toISOString(), mode: apMode(), version: AP_VERSION,
              triaged: 0, ranges: 0, sent: 0, failed: 0, wouldSend: 0, notes: [] };
  try {
    if (out.mode === 'off') { apHeartbeat(out); return out; }
    if (out.mode === 'on' && !apWhatsAppReady()) out.notes.push('AUTOPILOT is on but META_TOKEN / PHONE_ID are missing — working in test mode until they are set');
    var now = Date.now();
    if (apOn('AP_TRIAGE')) apStepTriage(out, now);
    if (apOn('AP_RANGE'))  apStepRange(out, now);
    if (apOn('AP_SEND'))   apStepSend(out, now);
    apHeartbeat(out);
  } catch (e) {
    out.error = String(e && e.message || e);
    console.error(e);
    try { apHeartbeat(out); } catch (x) {}
  } finally {
    lock.releaseLock();
  }
  return out;
}

/* ================================================================ 1 TRIAGE */
function apStepTriage(out, now) {
  var leads = (apGetRow('__leads__').data || {}).leads || [];
  var todo = leads.filter(function (l) {
    if (!l || !l.id || l.deleted) return false;
    var last = apLastIn(l);
    if (!last || !(last.t >= now - apMaxAgeMs())) return false;      // nothing new in the last day
    return !(l.triage && l.triage.text_hash === apTriageHash(l));     // already triaged this text
  }).slice(0, AP_LIMIT.triage);
  if (!todo.length) return;

  var newMsgs = [];
  var patches = {};   // lead id → function that applies our result to the fresh server copy
  todo.forEach(function (l) {
    var hash = apTriageHash(l);
    var r = apPost(apFn('triage'), {
      text: apTriageText(l), channel: l.channel || 'unknown',
      sender_name: l.name || l.handle || '', sender_phone: l.phone || '',
      is_known_customer: !!l._knownCustomer,
      prev_messages: (l.messages || []).slice(-3).map(function (m) { return { dir: m.dir, text: m.text }; })
    });
    if (!r.ok || !r.data || r.data.error) { out.notes.push('triage failed for ' + l.id + ': ' + (r.error || (r.data && r.data.error) || r.code)); return; }
    var t = apKeepActions(l.triage, r.data);
    t.text_hash = hash;
    t.by = 'autopilot';
    var added = [];   // messages to add to the lead's thread
    apTriageActions(l, t, newMsgs, added);
    out.triaged++;
    patches[l.id] = function (fresh) {
      // keep anything a person did on the page in the meantime
      var ft = fresh.triage || {};
      if (ft.text_hash === hash) return fresh;                          // someone got there first
      fresh.triage = apKeepActions(ft, t);
      fresh.triage.text_hash = hash; fresh.triage.by = 'autopilot';
      var have = {}; (fresh.messages || []).forEach(function (m) { if (m && m.msgId) have[m.msgId] = 1; });
      fresh.messages = (fresh.messages || []).concat(added.filter(function (m) { return !have[m.msgId]; })).slice(-100);
      return fresh;
    };
  });

  // Only send for leads whose triage we actually saved — if the inbox page got
  // there first, its own messages stand and ours are dropped.
  var applied = {};
  if (Object.keys(patches).length) {
    apCasRow('__leads__', function (data) {
      applied = {};
      data = data || {}; data.leads = (data.leads || []).map(function (x) {
        if (!x || !patches[x.id]) return x;
        var before = JSON.stringify(x.triage || null);
        var y = patches[x.id](JSON.parse(JSON.stringify(x)));
        if (JSON.stringify(y.triage || null) !== before) applied[x.id] = 1;
        return y;
      });
      return data;
    });
  }
  var mine = newMsgs.filter(function (m) { return applied[m.leadId]; });
  if (mine.length) apQueue(mine);
}

// Same decisions as fireTriageActions() in kith-inbox.html
function apTriageActions(l, t, newMsgs, added) {
  if (apIsStopReply(l)) { t.optedOut = t.optedOut || new Date().toISOString(); return; }
  if (t.is_ambiguous) return;                               // Logan's queue
  if (t.is_rapid_fire && !t.rapidFireSentAt) {
    apRapidFire(l, t, newMsgs, added);
  } else if (!t.rapidFireSentAt && !t.ackSentAt && t.suggested_reply) {
    apAck(l, t, newMsgs, added);
  }
  if (!t.pingSentAt) apPings(l, t, newMsgs);
}
function apCanSend(l) { return !!apIntl(l.phone) || apIsEmail(l.email); }

function apAck(l, t, newMsgs, added) {
  if (!apCanSend(l)) { t.ackSkippedReason = 'no contact to send to'; return; }
  var m = apMsg({ kind: 'triage_ack', leadId: l.id, phone: l.phone, email: l.email, text: t.suggested_reply, idSuffix: '-ack' });
  newMsgs.push(m); added.push(apThreadMsg(m));
  t.ackSentAt = new Date().toISOString(); t.ackMsgId = m.id;
}

function apRapidFire(l, t, newMsgs, added) {
  if (!apCanSend(l)) { t.rapidFireSkippedReason = 'no contact to send to'; return; }
  var veh = [l.year, l.make, l.model].filter(Boolean).join(' ') || l.reg || '';
  var b = apBrain({ customer_type: 'retail', vehicle: veh, reg: l.reg || '', complaint: l.what || '' });
  var lo = b.ok && b.data.total_range && Math.round(b.data.total_range.lo);
  var hi = b.ok && b.data.total_range && Math.round(b.data.total_range.hi);
  if (!b.ok || !lo || !hi) {
    t.rapidFireSkippedReason = b.ok ? 'brain returned no range' : 'brain: ' + b.error;
    if (!t.ackSentAt && t.suggested_reply) apAck(l, t, newMsgs, added);   // they still hear from us
    return;
  }
  var name = l.name ? String(l.name).split(' ')[0] : 'there';
  var vehTxt = [l.year, l.make, l.model].filter(Boolean).join(' ') || ('your ' + (l.reg || 'vehicle'));
  var text = 'Hi ' + name + ' — thanks for your enquiry about the ' + vehTxt + '.\n\n' +
    'Based on what you\'ve described, our instant estimate is £' + lo + '–£' + hi + ' (inc VAT).\n\n' +
    'This is a range from our pricing system — the final quote is confirmed after an estimator checks everything properly. Happy to go ahead? Reply YES and we\'ll work out the exact figure.\n\n' +
    'KITH Cars · Hackbridge · 020 4629 9469';
  var m = apMsg({ kind: 'triage_rapid_fire', leadId: l.id, phone: l.phone, email: l.email, text: text, idSuffix: '-rf' });
  newMsgs.push(m); added.push(apThreadMsg(m));
  t.rapidFireSentAt = new Date().toISOString();
  t.rapidFireRange = { lo: lo, hi: hi };
  t.rapidFireBrainConfidence = b.data.confidence || 'low';
  t.rapidFireMsgId = m.id;
  t.rapidFireSopVersion = b.data.sop_version || null;
  t.brainResult = b.data;
  t.suggestedCustType = 'retail';
}

function apPings(l, t, newMsgs) {
  var roles = t.routed_to_roles && t.routed_to_roles.length ? t.routed_to_roles : [t.category];
  var seen = {}, targets = [];
  roles.forEach(function (r) { (AP_STAFF_BY_ROLE[r] || []).forEach(function (p) {
    if (!p.wa || seen[p.wa]) return; seen[p.wa] = 1; targets.push(p); }); });
  if (!targets.length) { t.pingSkippedReason = 'no staff WA numbers for role(s): ' + roles.join(','); return; }
  var prio = t.priority === 'urgent' ? '🚨 URGENT · ' : '';
  var text = prio + 'KITH inbox · ' + String(t.category || 'inbox').toUpperCase() + ' · ' + apChannelLabel(l.channel) + '\n' +
    (l.name || l.handle || 'unknown') + ' · ' + ([l.phone, l.reg].filter(Boolean).join(' · ') || 'no number') + '\n' +
    (l.what || '(see thread)') + '\n\nOpen: ' + apProp('INBOX_URL', 'https://llogkith-spec.github.io/kith-crm/kith-inbox.html');
  targets.forEach(function (p, i) {
    newMsgs.push(apMsg({ kind: 'staff_ping', leadId: l.id, phone: p.wa, text: text, route: ['whatsapp'], idSuffix: '-ping-' + i }));
  });
  t.pingSentAt = new Date().toISOString();
  t.pingSentTo = targets.map(function (p) { return p.name; });
}

/* ================================================================= 2 RANGE */
function apStepRange(out, now) {
  var res = apSb('jobs?select=id,data,updated_at&data-%3E%3Estage=in.(intake,range)&limit=500');
  if (res.code >= 300 || !Array.isArray(res.data)) { out.notes.push('could not read jobs: ' + res.code); return; }
  var leads = (apGetRow('__leads__').data || {}).leads || [];
  var mode = apMode() === 'on' && !apWhatsAppReady() ? 'test' : apMode();   // no Meta details yet: draft only
  var done = 0;
  res.data.forEach(function (row) {
    if (done >= AP_LIMIT.range) return;
    var j = row.data || {}; j.id = j.id || row.id;
    if (apRangeWhyNot(j, leads, now)) return;
    if (mode === 'test' && j.autopilotDraft) return;          // already drafted in test mode
    done++;
    var b = apBrain({ customer_type: 'retail', vehicle: apBrainVeh(j), reg: j.reg || '', complaint: j.work || '' });
    var d = b.data || {};
    var lo = b.ok && d.total_range && Math.round(d.total_range.lo);
    var hi = b.ok && d.total_range && Math.round(d.total_range.hi);
    var why = !b.ok ? 'brain: ' + b.error
      : (!d.jobs || !d.jobs.length) ? 'the Brain could not tell what work is needed'
      : (!lo || !hi) ? 'the Brain gave no range'
      : d.safety_concern ? 'safety concern — a person should call: ' + apOneLine(d.safety_concern, 120)
      : '';
    if (why) {
      apCasJob(j.id, function (x) {
        x.autopilotRange = { skipped: why, at: apTs(), tries: ((x.autopilotRange || {}).tries || 0) + 1 };
        x.log = (x.log || []).concat([{ t: apTs(), s: '🤖 Autopilot did not send a range — ' + why }]);
        return x;
      });
      out.notes.push(j.id + ': ' + why);
      return;
    }
    var text = apRangeMsg(j, lo, hi);
    var brainAI = { total: d.total_inc_vat || 0, lo: d.total_range.lo || 0, hi: d.total_range.hi || 0, jobs: d.jobs || [],
      vehicle: d.vehicle || null, conf: d.confidence || 'low', allFirm: !!d.all_firm, usedFallback: !!d.used_ai_fallback,
      cacheStats: d.cache_stats || {}, sopVersion: d.sop_version || null, at: apTs(), ms: Date.now(), source: 'autopilot' };

    if (mode === 'test') {
      apCasJob(j.id, function (x) {
        if (x.rangeSentAt) return x;
        x.autopilotDraft = { lo: lo, hi: hi, text: text, at: apTs() };
        if (!x.brainAI) x.brainAI = brainAI;
        x.log = (x.log || []).concat([{ t: apTs(), s: '🤖 Autopilot (test mode) would send the range £' + lo + '–£' + hi + ' on WhatsApp — nothing was sent' }]);
        return x;
      });
      out.wouldSend++;
      return;
    }

    var to = apJobNumber(j);
    var r = apSendWA(to, text, ['kith_price_range', [apFirst(j.name), String(lo), String(hi)]]);
    if (!r.ok) {
      apCasJob(j.id, function (x) {
        x.autopilotRange = { skipped: 'WhatsApp: ' + r.error, at: apTs(), tries: ((x.autopilotRange || {}).tries || 0) + 1 };
        x.log = (x.log || []).concat([{ t: apTs(), s: '⚠ Autopilot could not send the range £' + lo + '–£' + hi + ' — ' + r.error }]);
        return x;
      });
      out.failed++;
      return;
    }
    apCasJob(j.id, function (x) {
      if (x.rangeSentAt) return x;                              // a person sent one in the meantime
      var nowMs = Date.now();
      x.rangeLow = lo; x.rangeHigh = hi;
      x.rangeVia = 'whatsapp'; x.rangeSource = 'autopilot_brain';
      x.rangeSentAt = apTs(); x.rangeSentMs = nowMs; x.rangeSentBy = 'Autopilot';
      x.rangeConfidence = d.confidence || 'low';
      if (!x.brainAI) x.brainAI = brainAI;
      x.waMsgs = (x.waMsgs || []).concat([{ id: r.id || '', kind: 'range', ms: nowMs, at: apTs(), manual: false, auto: true }]).slice(-20);
      x.log = (x.log || []).concat([{ t: apTs(), s: '💷 Price range £' + lo + '–£' + hi + ' sent on WhatsApp by the Autopilot' + (r.viaTemplate ? ' (template)' : '') + ' (Brain confidence ' + (d.confidence || 'low') + ')' }]);
      if (x.stage === 'intake') {
        x.stageHistory = x.stageHistory || [];
        var last = x.stageHistory[x.stageHistory.length - 1];
        if (last && !last.left) last.left = nowMs;
        x.stageHistory.push({ stage: 'range', at: nowMs, by: 'Autopilot' });
        x.stage = 'range'; x.stageAt = nowMs;
      }
      return x;
    });
    out.ranges++;
  });
}

// Why this job should NOT get an automatic range ('' = it should)
function apRangeWhyNot(j, leads, now) {
  if (!j || j.mergedInto || j.saidNo) return 'closed';
  if (j.stage !== 'intake' && j.stage !== 'range') return 'not at intake';
  if (j.rangeSentAt || j.rangeSkipped) return 'range already dealt with';
  var ar = j.autopilotRange || {};
  if (ar.skipped && (ar.tries || 0) >= 3) return 'tried three times';
  if (ar.skipped && /safety|could not tell/.test(ar.skipped)) return 'left for a person';
  var at = parseFloat(j.stageAt) || 0;
  if (!at || now - at > apMaxAgeMs()) return 'too old';
  if (!String(j.work || '').trim()) return 'no work description';
  // Customer types that never get a rapid fire range
  var ct = String(j.custType || '');
  if (j.isInternal) return 'internal';
  if (j.isAA || /^aa/i.test(ct)) return 'AA';
  if (j.isB2B || /b2b|trade|fleet/i.test(ct)) return 'trade / B2B';
  if (/insurance/i.test(ct)) return 'insurance';
  if (j.isWarrantyCo || /warranty/i.test(ct)) return 'warranty';
  if (ct && !/retail|b2c|private/i.test(ct)) return 'not retail';
  if (j.isComeback || /^COMEBACK/i.test(String(j.work || ''))) return 'comeback';
  if (j.additionalWork) return 'additional work';
  // Jobs that are priced another way
  var work = String(j.work || ''), src = String(j.source || '');
  if (/^DIAGNOSTIC FIRST/i.test(work)) return 'diagnostic first (safety)';
  if (j.jobType === 'recovery' || j.jobType === 'sale' || /^Recovery:/i.test(work)) return 'recovery / sale prep';
  if (/^\s*(MOT only|MOT\s*[—-]\s*Class|Tyre fit)\b/i.test(work) || /^MOT only$/i.test(String(j.serviceLabel || ''))) return 'fixed price — needs Logan’s sign-off';
  if (/walk.?in/i.test(src)) return 'walk-in — the estimator gives the range';
  if (/bmg|book my garage/i.test(src + ' ' + work)) return 'Book My Garage';
  if (apIsBodywork(j) && !(j.damagePanels && j.damagePanels.length)) return 'bodywork without the damage picker';
  // A WhatsApp number to send to
  if (j.wa === false) return 'customer has no WhatsApp';
  if (!/^447\d{9}$/.test(apJobNumber(j))) return 'no UK mobile';
  // The inbox may already have sent (or be about to send) this customer a range
  var num = apJobNumber(j);
  var lead = leads.filter(function (l) {
    return l && ((j.leadId && l.id === j.leadId) || (apIntl(l.phone) === num && (l.t || 0) >= now - 7 * 864e5));
  });
  if (lead.some(function (l) { var t = l.triage || {}; return t.rapidFireSentAt || (t.is_rapid_fire && !t.rapidFireSkippedReason); }))
    return 'the inbox is handling the range';
  return '';
}

/* ================================================================== 3 SEND */
function apStepSend(out, now) {
  var box = (apGetRow('__outbox__').data || {}).msgs || [];
  var due = box.filter(function (m) {
    return m && m.status === 'queued' && (m.route || []).indexOf('whatsapp') >= 0 && m.to &&
      (m.t || 0) >= now - apMaxAgeMs();
  }).slice(0, AP_LIMIT.send);
  if (!due.length) return;
  if (apMode() !== 'on') { out.wouldSend += due.length; return; }
  if (!apWhatsAppReady()) { out.wouldSend += due.length; out.notes.push('META_TOKEN / PHONE_ID not set — nothing sent'); return; }

  var leads = null, jobsById = {};
  var results = {};   // msg id → {ok, id, via, error}
  due.forEach(function (m) {
    var ctx = {};
    if (m.leadId) { leads = leads || ((apGetRow('__leads__').data || {}).leads || []); ctx.lead = leads.filter(function (l) { return l && l.id === m.leadId; })[0]; }
    if (m.jobId) { if (!(m.jobId in jobsById)) jobsById[m.jobId] = (apGetRow(m.jobId).data || null); ctx.job = jobsById[m.jobId]; }
    var tpl = AP_TEMPLATES[m.kind] ? AP_TEMPLATES[m.kind](m, ctx) : null;
    var doc = m.kind === 'quote' && ctx.job ? apEstDoc(ctx.job) : null;   // the quote goes WITH the PDF
    var r = apSendWA(m.to, m.text, tpl, doc);
    results[m.id] = r;
    if (r.ok) out.sent++; else out.failed++;
  });

  // Write back what happened: the outbox, the lead's thread, the job
  apCasRow('__outbox__', function (data) {
    data = data || {}; data.msgs = (data.msgs || []).map(function (m) {
      var r = m && results[m.id]; if (!r || m.status !== 'queued') return m;
      var x = JSON.parse(JSON.stringify(m));
      x.tries = (x.tries || 0) + 1;
      if (r.ok) { x.status = 'sent'; x.sentVia = 'whatsapp' + (r.viaTemplate ? ' (template)' : '') + ' · autopilot'; x.sentAt = apTs(); x.waId = r.id || ''; }
      else { x.error = r.error; x.lastTry = apTs(); if (x.tries >= 5 || r.permanent) x.status = 'stuck'; }
      return x;
    });
    return data;
  });
  var byLead = {};
  due.forEach(function (m) { if (m.leadId && results[m.id] && results[m.id].ok) (byLead[m.leadId] = byLead[m.leadId] || {})[m.id] = results[m.id]; });
  if (Object.keys(byLead).length) {
    apCasRow('__leads__', function (data) {
      data = data || {}; data.leads = (data.leads || []).map(function (l) {
        var got = l && byLead[l.id]; if (!got) return l;
        var x = JSON.parse(JSON.stringify(l));
        (x.messages || []).forEach(function (mm) { if (mm && got[mm.msgId]) { mm.status = 'sent'; mm.waId = got[mm.msgId].id || ''; } });
        return x;
      });
      return data;
    });
  }
  due.forEach(function (m) {
    var r = results[m.id]; if (!m.jobId || !r) return;
    apCasJob(m.jobId, function (x) {
      x.msgOutbox = (x.msgOutbox || []).map(function (q) {
        if (!q || q.id !== m.id || q.status !== 'queued') return q;
        q.tries = (q.tries || 0) + 1;
        if (r.ok) { q.status = 'sent'; q.sentVia = 'whatsapp · autopilot'; q.sentAt = apTs(); } else q.error = r.error;
        return q;
      });
      if (r.ok) {
        if (m.kind === 'quote') {
          x.waMsgs = (x.waMsgs || []).concat([{ id: r.id || '', kind: 'estimate', ms: Date.now(), at: apTs(), manual: false, auto: true }]).slice(-20);
          x.estimateSentMs = Date.now(); x.estimateSentAt = apTs(); x.estimateSentVia = 'whatsapp · autopilot';
        }
        x.log = (x.log || []).concat([{ t: apTs(), s: '💬 ' + (m.kind === 'quote' ? 'Quote' : 'Message') + ' sent on WhatsApp by the Autopilot' + (r.viaTemplate ? ' (template)' : '') }]);
      } else if ((m.tries || 0) + 1 >= 5 || r.permanent) {
        x.log = (x.log || []).concat([{ t: apTs(), s: '⚠ Autopilot could not send the ' + (m.kind || 'message') + ' on WhatsApp — ' + r.error + '. Send it by hand from the Inbox.' }]);
      }
      return x;
    });
  });
}

// One WhatsApp message through the relay's sendMessage(), falling back to
// the template when Meta says the 24-hour window is closed.
function apSendWA(to, text, tpl, doc) {
  if (typeof sendMessage !== 'function') return { ok: false, error: 'kith-relay.gs is not in this project', permanent: true };
  var r = sendMessage(doc ? { to: to, text: text, document: doc } : { to: to, text: text });
  if (r.ok) return { ok: true, id: r.id };
  if (r.needsTemplate) {
    if (!tpl) return { ok: false, error: 'outside the 24-hour window and there is no template for this message', permanent: true };
    var params = (tpl[1] || []).map(function (p) { return apOneLine(p, 250); });
    var r2 = sendMessage({ to: to, useTemplate: true, template: tpl[0], params: params, document: tpl[2] || undefined });
    if (r2.ok) return { ok: true, id: r2.id, viaTemplate: true };
    return { ok: false, error: 'template ' + tpl[0] + ': ' + (r2.error || 'refused') };
  }
  return { ok: false, error: r.error || 'send failed', permanent: /not a valid WhatsApp|131026|recipient/i.test(r.error || '') };
}

/* ============================================================== heartbeat */
// Written to __msgcfg__.autopilot every run. The inbox page reads it and,
// while the autopilot is alive, leaves triage and replies to it — so the
// same lead is never answered twice.
function apHeartbeat(out) {
  apCasRow('__msgcfg__', function (data) {
    data = data || {};
    var prev = data.autopilot || {};
    var hist = (prev.history || []);
    if (out.triaged || out.ranges || out.sent || out.failed || out.error) {
      hist = [{ at: out.at, triaged: out.triaged, ranges: out.ranges, sent: out.sent, failed: out.failed,
                wouldSend: out.wouldSend, error: out.error || '', notes: out.notes.slice(0, 5) }].concat(hist).slice(0, 30);
    }
    // The inbox reads live.whatsapp to say whether WhatsApp goes by itself
    data.live = data.live || {};
    data.live.whatsapp = out.mode === 'on' && apWhatsAppReady();
    data.autopilot = { at: out.at, mode: out.mode, version: AP_VERSION, last: { triaged: out.triaged, ranges: out.ranges,
      sent: out.sent, failed: out.failed, wouldSend: out.wouldSend, error: out.error || '' }, history: hist };
    return data;
  });
}

/* ================================================================ helpers */
function apWhatsAppReady() { return !!(apProp('META_TOKEN') && apProp('PHONE_ID')); }
function apFn(name) { return apProp('SB_URL').replace(/\/$/, '') + '/functions/v1/' + name; }
function apHeaders() { var k = apProp('SB_KEY'); return { apikey: k, Authorization: 'Bearer ' + k }; }
function apSb(path, opt) {
  opt = opt || {};
  var h = apHeaders(); h['Content-Type'] = 'application/json';
  if (opt.prefer) h.Prefer = opt.prefer;
  var res = UrlFetchApp.fetch(apProp('SB_URL').replace(/\/$/, '') + '/rest/v1/' + path, {
    method: opt.method || 'get', headers: h, muteHttpExceptions: true,
    payload: opt.body ? JSON.stringify(opt.body) : undefined });
  var t = res.getContentText();
  try { return { code: res.getResponseCode(), data: t ? JSON.parse(t) : null }; } catch (e) { return { code: res.getResponseCode(), data: null }; }
}
function apPost(url, body) {
  try {
    var h = apHeaders(); h['x-caller'] = 'autopilot';
    var res = UrlFetchApp.fetch(url, { method: 'post', contentType: 'application/json', headers: h,
      muteHttpExceptions: true, payload: JSON.stringify(body) });
    var d = null; try { d = JSON.parse(res.getContentText()); } catch (e) {}
    var ok = res.getResponseCode() < 300 && d && !d.error;
    return { ok: ok, code: res.getResponseCode(), data: d, error: ok ? '' : ((d && d.error) || ('HTTP ' + res.getResponseCode())) };
  } catch (e) { return { ok: false, code: 0, data: null, error: String(e.message || e) }; }
}
function apBrain(body) { return apPost(apFn('brain'), body); }

function apGetRow(id) {
  var r = apSb('jobs?id=eq.' + encodeURIComponent(id) + '&select=data,updated_at');
  var row = Array.isArray(r.data) && r.data[0];
  return row ? { data: row.data, updated_at: row.updated_at } : { data: null, updated_at: null };
}
// Read → change → write only if nobody saved in between, else go round again.
// `fn` gets a fresh copy every attempt, so other people's changes survive.
function apCasRow(id, fn) {
  for (var i = 0; i < 6; i++) {
    var row = apGetRow(id);
    var next = fn(row.data ? JSON.parse(JSON.stringify(row.data)) : null);
    if (next == null) return null;
    var stamp = new Date().toISOString();
    var r;
    if (row.updated_at == null && row.data == null) {
      r = apSb('jobs', { method: 'post', prefer: 'return=representation', body: [{ id: id, data: next, updated_at: stamp }] });
      if (r.code === 409) continue;
    } else {
      var cond = row.updated_at == null ? 'updated_at=is.null' : 'updated_at=eq.' + encodeURIComponent(row.updated_at);
      r = apSb('jobs?id=eq.' + encodeURIComponent(id) + '&' + cond, { method: 'patch', prefer: 'return=representation', body: { data: next, updated_at: stamp } });
    }
    if (r.code < 300 && Array.isArray(r.data) && r.data.length) return next;
    Utilities.sleep(150 + Math.floor(Math.random() * 300));
  }
  throw new Error('could not save ' + id + ' — too many saves at once');
}
function apCasJob(id, fn) {
  return apCasRow(id, function (x) { if (!x) return null; x = fn(x); if (x) x.updatedAt = new Date().toISOString(); return x; });
}
function apQueue(msgs) {
  apCasRow('__outbox__', function (data) {
    data = data || {}; var list = data.msgs || [];
    var have = {}; list.forEach(function (m) { if (m) have[m.id] = 1; });
    data.msgs = msgs.filter(function (m) { return !have[m.id]; }).concat(list).slice(0, 3000);
    return data;
  });
}

// Message shapes — identical to KITHBot.queue() and addMessage() in kith-bot.js
var AP_SENDABLE = { whatsapp: 1, sms: 1, email: 1 };
function apMsg(o) {
  var now = new Date();
  var route = (o.route || ['whatsapp', 'sms']).filter(function (c) { return AP_SENDABLE[c]; });
  return { id: 'MSG' + now.getTime() + (o.idSuffix || ''), kind: o.kind || 'message', jobId: o.jobId || '', leadId: o.leadId || '',
    to: apIntl(o.phone), email: apIsEmail(o.email) ? String(o.email).trim() : '', route: route,
    text: String(o.text || '').trim(), smsText: String(o.smsText || o.text || '').trim(),
    status: 'queued', tries: 0, sentVia: '', error: '', by: 'Autopilot', at: apTs(now), t: now.getTime() };
}
function apThreadMsg(m) {
  return { at: m.at, t: m.t, dir: 'out', channel: m.route[0], text: m.text, status: 'queued', msgId: m.id };
}
function apKeepActions(prev, r) {
  var t = JSON.parse(JSON.stringify(r || {}));
  prev = prev || {};
  ['ackSentAt', 'ackMsgId', 'ackSkippedReason', 'pingSentAt', 'pingSentTo', 'pingSkippedReason', 'rapidFireSentAt',
   'rapidFireRange', 'rapidFireMsgId', 'rapidFireSopVersion', 'rapidFireSkippedReason', 'rapidFireBrainConfidence',
   'brainResult', 'suggestedCustType', 'optedOut', 'overridden_by'].forEach(function (k) {
    if (prev[k] != null && prev[k] !== '') t[k] = prev[k];
  });
  return t;
}

// Same as triageText()/triageHash() in kith-inbox.html — must stay identical
function apTriageText(l) {
  var parts = [];
  if (l.what) parts.push(l.what);
  var lastIn = apLastIn(l);
  if (lastIn && lastIn.text) parts.push(lastIn.text);
  return parts.join(' — ');
}
function apTriageHash(l) {
  var s = apTriageText(l);
  var n = (l.messages || []).filter(function (m) { return m && m.dir === 'in'; }).length;
  var h = 0; for (var i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return h + ':' + n;
}
function apLastIn(l) { return (l.messages || []).filter(function (m) { return m && m.dir === 'in'; }).slice(-1)[0] || null; }
function apIsStopReply(l) {
  var last = apLastIn(l);
  var t = String((last && last.text) || '').replace(/^subject:.*\n/i, '').trim().split(/\n/)[0];
  return /^\s*(stop|stop all|unsubscribe|unsub|opt ?out|remove me|take me off|end|quit)\b(\s+(please|pls|thanks|thank you|now|it))*[\s.!]*$/i.test(t);
}

function apIntl(p) {
  var d = String(p == null ? '' : p).trim().replace(/[^\d+]/g, '');
  if (!d) return '';
  if (d.charAt(0) === '+') return d.slice(1).replace(/\D/g, '');
  if (d.indexOf('00') === 0) return d.slice(2);
  if (d.charAt(0) === '0') return '44' + d.slice(1);
  return d;
}
function apIsEmail(e) { return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(e == null ? '' : e).trim()); }
function apJobNumber(j) { return apIntl(j.waNumber || j.phone); }
var AP_BODY_RE = /body ?work|bodywork|panel|bumper|wing|door skin|paint|respray|dent|scratch|arch|quarter|bonnet|tailgate|sill|accident|crash/i;
function apIsBodywork(j) { return j.area === 'bodywork' || AP_BODY_RE.test(String(j.work || '')) || AP_BODY_RE.test(String(j.notes || '')); }
function apFirst(name) {
  var p = String(name || '').trim().split(/\s+/).filter(Boolean);
  while (p.length > 1 && /^(mr|mrs|ms|miss|mx|dr|prof|sir|madam|rev)\.?$/i.test(p[0])) p.shift();
  return p[0] || 'there';
}
function apVeh(j) {
  var junk = function (v) { var t = String(v || '').trim(); return !t || /^[.…\-_/]+$/.test(t) || /^n\/?a$/i.test(t); };
  var mm = [junk(j.make) ? '' : String(j.make).trim(), junk(j.model) ? '' : String(j.model).trim()].filter(Boolean).join(' ');
  var reg = String(j.reg || '').trim();
  return mm && reg ? mm + ' (' + reg + ')' : (mm || reg || 'vehicle');
}
// The latest TechMan estimate PDF on the job, as the relay wants it
function apEstDoc(j) {
  var d = (j.estimateDocs || []).slice(-1)[0];
  if (!d || !d.url) return null;
  // Same file name the CRM gives it (estDocName)
  var m = String(d.url || d.name || '').split('?')[0].match(/\.([a-z0-9]{2,5})$/i);
  var ext = m && /^(pdf|jpe?g|png|webp|heic)$/i.test(m[1]) ? m[1].toLowerCase() : 'pdf';
  return { link: d.url, filename: 'KITH Cars estimate' + (j.reg ? ' ' + String(j.reg).replace(/\s+/g, '').toUpperCase() : '') + '.' + ext };
}
function apBrainVeh(j) { return [j.year, j.make, j.model].filter(Boolean).join(' ') || j.reg || ''; }
// Same wording as rangeMsg() in the CRM
function apRangeMsg(j, lo, hi) {
  return 'Hi ' + apFirst(j.name) + ', thanks for getting in touch with KITH Cars about your ' + apVeh(j) + '.\n\n' +
    'For ' + String(j.work || 'this work').replace(/\s+/g, ' ').slice(0, 140) + ', jobs like this usually come to between £' + lo + ' and £' + hi + ' including VAT.\n\n' +
    'If that works for you, just reply YES and we’ll put together your exact quote.\n\n— KITH Cars';
}
var AP_CHANNEL_LABEL = { whatsapp: 'WhatsApp', sms: 'Text', instagram: 'Instagram', facebook: 'Facebook', tiktok: 'TikTok',
  email: 'Email', website: 'Website', phone: 'Phone call', walkin: 'Walk-in' };
function apChannelLabel(c) { return AP_CHANNEL_LABEL[c] || c || 'Other'; }
// Meta refuses template parameters with new lines, tabs or 4+ spaces
function apOneLine(s, max) { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > max ? s.slice(0, max - 1) + '…' : s; }
// Same format as the CRM's ts(): "13 Nov 2026, 15:40", London time
function apTs(d) { return Utilities.formatDate(d || new Date(), 'Europe/London', 'dd MMM yyyy, HH:mm'); }
