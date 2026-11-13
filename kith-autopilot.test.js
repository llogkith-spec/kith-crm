/* Tests for kith-autopilot.gs — runs the real script (plus kith-relay.gs for
   sendMessage) inside Node with fake Apps Script services, a fake Supabase,
   a fake triage/Brain and a fake WhatsApp Cloud API.
   Run: node kith-autopilot.test.js */
'use strict';
const fs = require('fs'), vm = require('vm'), path = require('path');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  ✗ ' + m); } };

function world(opts) {
  opts = opts || {};
  const rows = {};               // id → {data, updated_at}
  let clock = 0;
  const stamp = () => new Date(Date.UTC(2026, 10, 13, 12, 0, 0) + (++clock)).toISOString();
  const put = (id, data) => { rows[id] = { data: JSON.parse(JSON.stringify(data)), updated_at: stamp() }; };
  const props = Object.assign({ SB_URL: 'https://sb.test', SB_KEY: 'anon', META_TOKEN: 'tok', PHONE_ID: '123',
    AUTOPILOT: 'test' }, opts.props || {});
  const calls = { meta: [], brain: [], triage: [], patches: 0 };
  let conflictOnce = opts.conflictOnce || null;   // row id to bump once between read and write
  const W = {
    open: new Set(opts.window || []),          // numbers inside the 24-hour window
    triage: opts.triage || (() => ({ category: 'adviser', routed_to_roles: ['adviser'], is_rapid_fire: true, is_ambiguous: false,
      suggested_reply: '', priority: 'normal', confidence: 'high' })),
    brain: opts.brain || (() => ({ jobs: [{ job_label: 'Front pads' }], total_inc_vat: 200, total_range: { lo: 180.4, hi: 250.2 },
      confidence: 'medium', sop_version: 7 }))
  };
  const resp = (code, obj) => ({ getResponseCode: () => code, getContentText: () => obj == null ? '' : JSON.stringify(obj) });
  const UrlFetchApp = { fetch(url, o) {
    o = o || {}; const method = (o.method || 'get').toLowerCase();
    const body = o.payload ? JSON.parse(o.payload) : null;
    if (url.startsWith('https://graph.facebook.com')) {
      calls.meta.push(body);
      if (body.type === 'template') return resp(200, { messages: [{ id: 'wamid.T' + calls.meta.length }] });
      if (!W.open.has(body.to)) return resp(400, { error: { code: 131047, message: 'Re-engagement message' } });
      return resp(200, { messages: [{ id: 'wamid.' + calls.meta.length }] });
    }
    if (url === 'https://sb.test/functions/v1/triage') { calls.triage.push(body); return resp(200, W.triage(body)); }
    if (url === 'https://sb.test/functions/v1/brain') { calls.brain.push(body); return resp(200, W.brain(body)); }
    if (url === 'https://sb.test/functions/v1/inbox-ingest') return resp(200, { ok: true });
    const u = new URL(url); const q = u.searchParams;
    if (!u.pathname.endsWith('/rest/v1/jobs')) return resp(404, null);
    if (method === 'get') {
      if (q.get('id')) { const id = q.get('id').replace(/^eq\./, ''); const r = rows[id];
        return resp(200, r ? [{ data: r.data, updated_at: r.updated_at }] : []); }
      const st = (q.get('data->>stage') || '').replace(/^in\.\(|\)$/g, '').split(',');
      return resp(200, Object.keys(rows).filter(id => rows[id].data && st.includes(rows[id].data.stage))
        .map(id => ({ id, data: rows[id].data, updated_at: rows[id].updated_at })));
    }
    if (method === 'post') { body.forEach(r => put(r.id, r.data)); return resp(201, body); }
    if (method === 'patch') {
      calls.patches++;
      const id = q.get('id').replace(/^eq\./, ''); const want = (q.get('updated_at') || '').replace(/^eq\./, '');
      if (conflictOnce === id) { conflictOnce = null; rows[id].updated_at = stamp(); rows[id].data.touchedByOther = true; }
      const r = rows[id]; if (!r || r.updated_at !== want) return resp(200, []);
      r.data = body.data; r.updated_at = stamp(); return resp(200, [{ id, data: r.data }]);
    }
    return resp(405, null);
  } };
  const store = {}; const cache = { get: k => (k in store ? store[k] : null), put: (k, v) => { store[k] = v; }, remove: k => { delete store[k]; } };
  const ctx = {
    console: { log() {}, warn() {}, error() {} }, JSON, Date, Math, String, Number, Array, Object, RegExp, parseFloat, parseInt, encodeURIComponent, isNaN,
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => (k in props ? props[k] : null) }) },
    UrlFetchApp,
    LockService: { getScriptLock: () => ({ tryLock: () => true, waitLock() {}, releaseLock() {} }) },
    Utilities: { sleep() {}, formatDate: (d) => d.toLocaleString('en-GB', { timeZone: 'Europe/London', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) },
    CacheService: { getScriptCache: () => cache },
    ScriptApp: { getProjectTriggers: () => [], deleteTrigger() {}, newTrigger: () => ({ timeBased: () => ({ everyMinutes: () => ({ create() {} }) }) }) },
    ContentService: { createTextOutput: t => ({ setMimeType: () => t }), MimeType: { JSON: 'json' } }
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'kith-relay.gs'), 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'kith-autopilot.gs'), 'utf8'), ctx);
  return { ctx, cache, rows, put, calls, props, W, run: () => ctx.autopilotRun(), get: id => rows[id] && rows[id].data };
}

const NOW = Date.now(), H = 3600e3;
const lead = (o) => Object.assign({ id: 'L1', name: 'Sam Jones', phone: '07700 900123', reg: 'AB12CDE', make: 'Ford', model: 'Focus',
  channel: 'website', what: 'front brakes grinding', t: NOW - 60e3,
  messages: [{ dir: 'in', channel: 'website', text: 'front brakes grinding', t: NOW - 60e3, at: 'now' }] }, o || {});
const job = (o) => Object.assign({ id: 'J100001', name: 'Mr Alex Brown', phone: '07700 900456', reg: 'XY34ZZZ', make: 'BMW', model: '320d',
  work: 'Front brake pads and discs', stage: 'intake', stageAt: NOW - 5 * 60e3, custType: 'Retail', source: 'Phone Call',
  fromIntakeApp: true, wa: true, log: [] }, o || {});

/* ------------------------------------------------------------------------ */
console.log('1. Test mode: a website lead is triaged and the range queued, nothing sent');
{
  const w = world();
  w.put('__leads__', { leads: [lead()] }); w.put('__outbox__', { msgs: [] }); w.put('__msgcfg__', { live: { whatsapp: true } });
  const out = w.run();
  const l = w.get('__leads__').leads[0], box = w.get('__outbox__').msgs;
  ok(out.mode === 'test', 'mode is test by default');
  ok(out.triaged === 1, 'one lead triaged');
  ok(l.triage && l.triage.rapidFireSentAt && l.triage.rapidFireRange.lo === 180 && l.triage.rapidFireRange.hi === 250, 'range recorded on the lead (rounded)');
  ok(l.triage.text_hash && l.triage.by === 'autopilot', 'triage hash + who');
  ok(box.some(m => m.kind === 'triage_rapid_fire' && m.status === 'queued' && m.to === '447700900123'), 'range queued to the customer');
  ok(box.some(m => m.kind === 'staff_ping' && m.to === '2348126024190'), 'adviser pinged (queued)');
  ok(l.messages.some(m => m.dir === 'out' && m.status === 'queued' && /£180–£250/.test(m.text)), 'range in the lead thread');
  ok(w.calls.meta.length === 0, 'nothing sent to WhatsApp in test mode');
  ok(out.wouldSend >= 2, 'reports what would be sent');
  const hb = w.get('__msgcfg__');
  ok(hb.autopilot && hb.autopilot.mode === 'test' && hb.live.whatsapp === false, 'heartbeat written (test mode: WhatsApp not live)');
  const out2 = w.run();
  ok(out2.triaged === 0 && w.calls.triage.length === 1 && w.get('__outbox__').msgs.length === box.length, 'second run does nothing new');
}

console.log('2. Ambiguous, STOP and ack routes');
{
  const w = world({ triage: b => /cheap/.test(b.text) ? { category: 'unsure', is_ambiguous: true, suggested_reply: '' }
    : { category: 'parts', routed_to_roles: ['parts'], is_rapid_fire: false, suggested_reply: 'Thanks — Giles will come back to you on parts.' } });
  w.put('__leads__', { leads: [
    lead({ id: 'A', what: 'cheap?', messages: [{ dir: 'in', text: 'cheap?', t: NOW - 1000 }] }),
    lead({ id: 'B', what: 'need a part', phone: '07700 900777', messages: [{ dir: 'in', text: 'do you sell wishbones', t: NOW - 1000 }] }),
    lead({ id: 'C', what: '', messages: [{ dir: 'in', text: 'STOP', t: NOW - 1000 }] }),
    lead({ id: 'OLD', messages: [{ dir: 'in', text: 'old one', t: NOW - 3 * 864e5 }] })
  ] });
  w.put('__outbox__', { msgs: [] });
  w.run();
  const L = id => w.get('__leads__').leads.find(x => x.id === id);
  const box = w.get('__outbox__').msgs;
  ok(L('A').triage && !box.some(m => m.leadId === 'A'), 'ambiguous: triaged, nothing queued');
  ok(box.some(m => m.leadId === 'B' && m.kind === 'triage_ack'), 'parts enquiry gets the ack');
  ok(box.filter(m => m.leadId === 'B' && m.kind === 'staff_ping').length === 2, 'parts staff with numbers pinged');
  ok(L('C').triage && L('C').triage.optedOut && !box.some(m => m.leadId === 'C'), 'STOP: opted out, nothing queued');
  ok(!L('OLD').triage, 'leads with nothing new in 24h are left alone');
}

console.log('3. Intake jobs: who gets a range');
{
  const w = world();
  w.put('__leads__', { leads: [lead({ id: 'LX', phone: '07700 900999', triage: { rapidFireSentAt: 'x' } })] });
  w.put('__outbox__', { msgs: [] });
  const cases = {
    J1: {}, J2: { custType: 'Trade', isB2B: true }, J3: { source: 'Walk In' }, J4: { work: 'MOT only' },
    J5: { stageAt: NOW - 30 * H }, J6: { phone: '020 8123 4567' }, J7: { phone: '07700 900999' },
    J8: { work: 'DIAGNOSTIC FIRST — brakes' }, J9: { custType: 'AA Smart', isAA: true }, J10: { work: 'Rear bumper scuff' },
    J11: { work: 'Rear bumper scuff', damagePanels: ['Rear bumper'] }, J12: { jobType: 'recovery', work: 'Recovery: A → B' },
    J13: { rangeSentAt: 'earlier' }, J14: { stage: 'labour' }, J15: { custType: 'Warranty', isWarrantyCo: true }, J16: { wa: false }
  };
  Object.keys(cases).forEach(id => w.put(id, job(Object.assign({ id }, cases[id]))));
  const out = w.run();
  const drafted = Object.keys(cases).filter(id => w.get(id).autopilotDraft);
  ok(JSON.stringify(drafted) === JSON.stringify(['J1', 'J11']), 'eligible: retail phone-in + bodywork with damage picker; got ' + drafted);
  ok(w.calls.meta.length === 0, 'test mode sends nothing');
  ok(/would send the range £180–£250/.test(w.get('J1').log.slice(-1)[0].s), 'job log says what would be sent');
  ok(!w.get('J1').rangeSentAt && w.get('J1').stage === 'intake', 'test mode leaves the job where it is');
  ok(w.get('J1').brainAI && w.get('J1').brainAI.source === 'autopilot', 'Brain result cached on the job');
  w.run();
  ok(w.calls.brain.length === 2, 'drafts are not repeated');
  const why = w.ctx.apRangeWhyNot;
  const L = w.get('__leads__').leads;
  ok(/trade/.test(why(w.get('J2'), L, NOW)) && /walk-in/.test(why(w.get('J3'), L, NOW)) && /fixed price/.test(why(w.get('J4'), L, NOW)), 'reasons: trade, walk-in, fixed price');
  ok(/too old/.test(why(w.get('J5'), L, NOW)) && /UK mobile/.test(why(w.get('J6'), L, NOW)) && /inbox/.test(why(w.get('J7'), L, NOW)), 'reasons: old, landline, inbox handled');
  ok(/safety/.test(why(w.get('J8'), L, NOW)) && /bodywork/.test(why(w.get('J10'), L, NOW)) && /recovery/.test(why(w.get('J12'), L, NOW)), 'reasons: safety, bodywork, recovery');
}

console.log('4. On: the intake range goes out, template outside the window');
{
  const w = world({ props: { AUTOPILOT: 'on' } });
  w.put('__leads__', { leads: [] }); w.put('__outbox__', { msgs: [] }); w.put('__msgcfg__', { live: { whatsapp: true } });
  w.put('J1', job({ id: 'J1' }));
  const out = w.run();
  const j = w.get('J1');
  ok(out.ranges === 1, 'one range sent');
  ok(w.calls.meta.length === 2 && w.calls.meta[0].type === 'text' && w.calls.meta[1].type === 'template', 'free text refused, template used');
  const t = w.calls.meta[1].template;
  ok(t.name === 'kith_price_range' && JSON.stringify(t.components[0].parameters.map(p => p.text)) === '["Alex","180","250"]', 'template params: first name (title dropped), lo, hi');
  ok(j.rangeSentAt && j.rangeLow === 180 && j.rangeHigh === 250 && j.rangeSentBy === 'Autopilot', 'range recorded like the CRM button');
  ok(j.stage === 'range' && j.stageHistory.slice(-1)[0].stage === 'range', 'moved to Price Range');
  ok(j.waMsgs[0].kind === 'range' && /^wamid/.test(j.waMsgs[0].id), 'message id kept for the ticks');
  w.run();
  ok(w.calls.meta.length === 2, 'never sent twice');
}

console.log('5. On: the outbox empties — inbox replies and your approved quote');
{
  const w = world({ props: { AUTOPILOT: 'on' }, window: ['447700900123'] });
  w.put('__msgcfg__', { live: { whatsapp: true } });
  w.put('J7', job({ id: 'J7', stage: 'contacted', quote: 412.5, msgOutbox: [{ id: 'MSGQ', status: 'queued' }] }));
  w.put('__leads__', { leads: [lead({ id: 'L9', triage: { text_hash: 'x', rapidFireRange: { lo: 90, hi: 120 } },
    messages: [{ dir: 'in', text: 'hi', t: NOW - 3 * 864e5 }, { dir: 'out', msgId: 'MSGR', status: 'queued', text: 'range' }] })] });
  w.put('__outbox__', { msgs: [
    { id: 'MSGR', kind: 'triage_rapid_fire', leadId: 'L9', to: '447700900123', route: ['whatsapp', 'sms'], text: 'range', status: 'queued', t: NOW - 60e3 },
    { id: 'MSGQ', kind: 'quote', jobId: 'J7', to: '447700900456', route: ['whatsapp', 'sms'], text: 'quote text', status: 'queued', t: NOW - 60e3 },
    { id: 'MSGOLD', kind: 'triage_ack', leadId: 'L9', to: '447700900123', route: ['whatsapp'], text: 'old', status: 'queued', t: NOW - 3 * 864e5 },
    { id: 'MSGMAIL', kind: 'triage_ack', to: '', email: 'a@b.co', route: ['email'], text: 'x', status: 'queued', t: NOW - 60e3 }
  ] });
  const out = w.run();
  const box = w.get('__outbox__').msgs, M = id => box.find(m => m.id === id);
  ok(out.sent === 2, 'two sent');
  ok(M('MSGR').status === 'sent' && /autopilot/.test(M('MSGR').sentVia), 'range sent as free text inside the window');
  ok(M('MSGQ').status === 'sent' && /template/.test(M('MSGQ').sentVia), 'quote sent with the template outside the window');
  const qt = w.calls.meta.find(b => b.type === 'template');
  ok(qt.template.name === 'kith_quote_ready' && qt.template.components[0].parameters[2].text === '412.50', 'quote template carries the amount');
  ok(M('MSGOLD').status === 'queued', 'a 3-day-old message is NOT sent');
  ok(M('MSGMAIL').status === 'queued', 'email-only messages are left alone');
  ok(w.get('__leads__').leads[0].messages.find(m => m.msgId === 'MSGR').status === 'sent', 'lead thread shows sent');
  const j = w.get('J7');
  ok(j.msgOutbox[0].status === 'sent' && j.waMsgs.slice(-1)[0].kind === 'estimate' && /Quote sent/.test(j.log.slice(-1)[0].s), 'job shows the quote went');
  ok(j.estimateSentMs > 0, 'estimate marked sent so the chase clock starts');
}

console.log('5b. The quote goes with the TechMan PDF');
{
  const w = world({ props: { AUTOPILOT: 'on' }, window: ['447700900456'] });
  w.put('__msgcfg__', { live: { whatsapp: true } }); w.put('__leads__', { leads: [] });
  w.put('J8', job({ id: 'J8', stage: 'contacted', quote: 300, estimateDocs: [{ url: 'https://files.test/est.pdf', name: 'Estimate XY34ZZZ' }] }));
  w.put('__outbox__', { msgs: [{ id: 'MQ', kind: 'quote', jobId: 'J8', to: '447700900456', route: ['whatsapp'], text: 'Your quote', status: 'queued', t: NOW }] });
  w.run();
  const b = w.calls.meta[0];
  ok(b.type === 'document' && b.document.link === 'https://files.test/est.pdf' && b.document.filename === 'KITH Cars estimate XY34ZZZ.pdf' && b.document.caption === 'Your quote', 'inside the window: the PDF with the quote as its caption');
  const w2 = world({ props: { AUTOPILOT: 'on' } });
  w2.put('__msgcfg__', { live: { whatsapp: true } }); w2.put('__leads__', { leads: [] });
  w2.put('J8', job({ id: 'J8', stage: 'contacted', quote: 300, estimateDocs: [{ url: 'https://files.test/est.pdf' }] }));
  w2.put('__outbox__', { msgs: [{ id: 'MQ', kind: 'quote', jobId: 'J8', to: '447700900456', route: ['whatsapp'], text: 'Your quote', status: 'queued', t: NOW }] });
  w2.run();
  const t2 = w2.calls.meta[1];
  ok(t2 && t2.template.name === 'kith_estimate' && t2.template.components[0].type === 'header' &&
     t2.template.components[0].parameters[0].document.link === 'https://files.test/est.pdf' &&
     t2.template.components[1].parameters[2].text === '£300.00 including VAT', 'outside the window: kith_estimate template with the PDF header');
}

console.log('6. Safety stops');
{
  const w = world({ props: { AUTOPILOT: 'on' } });
  w.put('__msgcfg__', { live: { email: true } }); w.put('__leads__', { leads: [] }); w.put('__outbox__', { msgs: [] });
  w.run();
  ok(w.get('__msgcfg__').live.whatsapp === true && w.get('__msgcfg__').live.email === true, 'on + Meta details: inbox told WhatsApp is live, other switches kept');
  const wt = world();
  wt.put('__msgcfg__', { live: { whatsapp: true } });
  wt.run();
  ok(wt.get('__msgcfg__').live.whatsapp === false, 'test mode: inbox told WhatsApp is not sending');

  const w2 = world({ props: { AUTOPILOT: 'on' }, brain: () => ({ jobs: [{}], total_range: { lo: 100, hi: 130 }, safety_concern: 'brakes may fail' }) });
  w2.put('__leads__', { leads: [] }); w2.put('__outbox__', { msgs: [] }); w2.put('__msgcfg__', { live: { whatsapp: true } });
  w2.put('J1', job({ id: 'J1' }));
  w2.run(); w2.run();
  ok(w2.calls.meta.length === 0 && /safety/.test(w2.get('J1').autopilotRange.skipped), 'Brain safety concern: no range, left for a person');
  ok(w2.calls.brain.length === 1, '…and not retried every minute');

  const w3 = world({ props: { AUTOPILOT: 'off' } });
  w3.put('__msgcfg__', {}); w3.put('__leads__', { leads: [lead()] });
  w3.run();
  ok(w3.calls.triage.length === 0 && w3.get('__msgcfg__').autopilot.mode === 'off', 'off: does nothing but say so');

  const w4 = world({ props: { AUTOPILOT: 'on', META_TOKEN: '' } });
  w4.put('__msgcfg__', { live: { whatsapp: true } }); w4.put('__leads__', { leads: [] });
  w4.put('__outbox__', { msgs: [{ id: 'M1', kind: 'triage_ack', to: '447700900123', route: ['whatsapp'], text: 'x', status: 'queued', t: NOW }] });
  w4.put('J1', job({ id: 'J1' }));
  const o4 = w4.run();
  ok(w4.calls.meta.length === 0 && o4.notes.some(n => /META_TOKEN/.test(n)), 'no Meta token: nothing sent, says why');
  ok(w4.get('J1').autopilotDraft && !w4.get('J1').rangeSentAt, 'no Meta token: intake range is drafted, not marked sent');
}

console.log('7. Someone else saving at the same moment');
{
  const w = world({ props: { AUTOPILOT: 'on' }, conflictOnce: 'J1' });
  w.put('__leads__', { leads: [] }); w.put('__outbox__', { msgs: [] }); w.put('__msgcfg__', { live: { whatsapp: true } });
  w.put('J1', job({ id: 'J1' }));
  w.run();
  const j = w.get('J1');
  ok(j.rangeSentAt && j.touchedByOther === true, 'retries and keeps the other person’s change');
}

console.log('7b. Two runs at once');
{
  const w = world();
  w.put('__msgcfg__', {});
  w.cache.put('ap-running', 'other');
  ok(/still going/.test(w.run().skipped || ''), 'a second run backs off');
  w.cache.remove('ap-running');
  ok(!w.run().skipped && w.cache.get('ap-running') === null, 'runs and clears its marker');
}

console.log('8. Wording matches the CRM and inbox');
{
  const w = world();
  const t = w.ctx.apRangeMsg(job(), 180, 250);
  ok(/^Hi Alex, thanks for getting in touch with KITH Cars about your BMW 320d \(XY34ZZZ\)\./.test(t) && /reply YES/.test(t), 'range message wording');
  const html = fs.readFileSync(path.join(__dirname, 'kith-inbox.html'), 'utf8');
  const fn = html.match(/function triageHash\(l\) \{[\s\S]*?\n\}/)[0] + html.match(/function triageText\(l\) \{[\s\S]*?\n\}/)[0];
  const c = { }; vm.createContext(c); vm.runInContext(fn, c);
  const L = lead({ messages: [{ dir: 'in', text: 'a' }, { dir: 'out', text: 'b' }, { dir: 'in', text: 'grinding noise' }] });
  ok(c.triageHash(L) === w.ctx.apTriageHash(L), 'triage hash identical to the inbox page');
  ok(/autopilotAlive\(\)\) return;/.test(html), 'inbox page stands down while the autopilot runs');
}

console.log('\n' + (fail ? '✗ ' : '✓ ') + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
