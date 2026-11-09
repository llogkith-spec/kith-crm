/* =============================================================================
   KITH FEEDS v2.0 — every channel in, and every campaign out
   =============================================================================
   Google Apps Script. Every enquiry it hears about goes in through the
   inbox's single front door — the inbox-ingest Edge Function — so it lands
   in the live inbox (the jobs row __leads__) and gets triaged like every
   other lead. It also sends campaigns from the Sales page.

     Website form   → POST {action:'webform', name, phone, email, reg, message}
     Instagram / FB → Meta webhook (Messenger Platform) to this script's /exec
     Email          → pollGmail() every 5 minutes reads the Gmail inbox
     Texts          → Twilio webhook to /exec?k=FEEDS_SECRET
     Replies out    → POST {action:'send_meta' | 'send_email' | 'send_sms', secret, ...}
     Campaigns out  → runSales() every 10 minutes: sends what's due (email,
                      text, WhatsApp), queues follow-ups, spots replies and
                      STOPs, and once a day queues the automatic reminders.
                      Needs kith-range.gs and kith-sales.gs in this project too
                      (copies of kith-range.js and kith-sales.js), listed ABOVE
                      this file.

   ⚠ THIS FILE NEVER GOES TO GITHUB WITH KEYS IN IT. Every key lives in
   Project Settings → Script properties:
     SUPABASE_URL       https://mxyrxyhvjndgjqupgstu.supabase.co
     SUPABASE_KEY       the service_role key (Supabase → Settings → API)
     FEEDS_SECRET       any long pass phrase; the same one goes in the inbox's Settings
     META_VERIFY_TOKEN  any word; the same one goes in the Meta webhook setup
     META_PAGE_TOKEN    the Facebook Page access token (covers the linked Instagram)
     META_IDS           the Facebook Page id and Instagram account id, comma separated
     OWN_EMAILS         addresses that are us, comma separated (never become leads)
     TWILIO_SID         Twilio account SID (texts) — optional
     TWILIO_TOKEN       Twilio auth token
     TWILIO_FROM        the Twilio number texts come from, e.g. +447…

   Run setup() once from the editor: it checks the properties and adds the
   5-minute Gmail trigger and the 10-minute campaign trigger. Deploy → New deployment → Web app → Execute as Me,
   Who has access: Anyone. The /exec address goes in the inbox Settings, the
   website form, and the Meta webhook.
   ============================================================================= */

const GRAPH = 'https://graph.facebook.com/v19.0';
const P = () => PropertiesService.getScriptProperties();
const prop = k => P().getProperty(k) || '';
const SHOP_EMAIL = 'kithcarsinfo@gmail.com';

/* ---------------------------------------------------------------- web ---- */
function doGet(e) {
  const q = (e && e.parameter) || {};
  // Meta checks the webhook once when you add it
  if (q['hub.mode'] === 'subscribe') {
    if (q['hub.verify_token'] && q['hub.verify_token'] === prop('META_VERIFY_TOKEN')) return text(q['hub.challenge'] || '');
    return text('wrong verify token');
  }
  return json({ ok: true, service: 'kith-feeds', version: '1.0' });
}

function doPost(e) {
  const q = (e && e.parameter) || {};
  // Twilio posts a form, not JSON. The pass phrase rides in the webhook address.
  if (q.From && q.Body != null && q.MessageSid) {
    if (!prop('FEEDS_SECRET') || q.k !== prop('FEEDS_SECRET')) return text('');
    try { addToLead({ source: 'sms', phone: q.From, text: String(q.Body || '') + mediaNote(q), msgId: 'tw_' + q.MessageSid }); } catch (err) { console.error(err); }
    return ContentService.createTextOutput('<Response/>').setMimeType(ContentService.MimeType.XML);
  }
  let body = {};
  try { body = JSON.parse((e && e.postData && e.postData.contents) || '{}'); } catch (err) { return json({ ok: false, error: 'Not JSON' }); }
  try {
    if (body.object === 'page' || body.object === 'instagram') return metaIn(body);
    if (body.action === 'webform') return json(webform(body));
    // everything below sends on KITH's behalf, so it needs the pass phrase
    if (!prop('FEEDS_SECRET') || body.secret !== prop('FEEDS_SECRET')) return json({ ok: false, error: 'Wrong pass phrase' });
    if (body.action === 'send_meta') return json(sendMeta(body));
    if (body.action === 'send_email') return json(sendEmail(body));
    if (body.action === 'send_sms') return json(sendSms(body.to, body.text));
    if (body.action === 'run_sales') return json(runSales(true));
    if (body.action === 'ping') return json({ ok: true, meta: !!prop('META_PAGE_TOKEN'), gmail: true, sms: !!prop('TWILIO_SID'), sales: !!KS(), version: '2.0' });
    return json({ ok: false, error: 'Unknown action' });
  } catch (err) {
    console.error(err);
    return json({ ok: false, error: String(err && err.message || err) });
  }
}
const json = o => ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
const text = s => ContentService.createTextOutput(String(s));

/* ------------------------------------------------------------ website ---- */
// The website form posts here (Content-Type text/plain, so no CORS preflight).
// A hidden field called "website" must be left empty — bots fill it in.
function webform(b) {
  if (b.website) return { ok: true };                       // honeypot: say thanks, keep nothing
  const clip = (s, n) => String(s == null ? '' : s).trim().slice(0, n);
  const name = clip(b.name, 80), phone = clip(b.phone, 30), email = clip(b.email, 120), reg = clip(b.reg, 12);
  const msg = clip(b.message || b.work || b.what, 1500);
  if (!phone && !email) return { ok: false, error: 'Please leave a number or an email so we can reply' };
  // one enquiry a minute from the same number or email
  const c = CacheService.getScriptCache(), key = 'wf_' + (phone || email).replace(/\W/g, '');
  if (c.get(key)) return { ok: true, duplicate: true };
  c.put(key, '1', 60);
  const lines = [msg, b.service && ('Service: ' + clip(b.service, 80)), b.page && ('From page: ' + clip(b.page, 200)),
    b.rangeShown && ('Shown on the website: ' + clip(b.rangeShown, 80))].filter(Boolean).join('\n');
  const id = addToLead({ source: 'webform', name, phone, email, reg, text: lines || '(website form, no message)',
    meta: { page: clip(b.page, 200), utm: clip(b.utm, 200) } });
  return { ok: true, id };
}

/* --------------------------------------------------- Instagram / Facebook */
function metaIn(body) {
  const allowed = prop('META_IDS').split(',').map(s => s.trim()).filter(Boolean);
  const platform = body.object === 'instagram' ? 'instagram' : 'facebook';
  (body.entry || []).forEach(en => {
    // Apps Script can't read Meta's signature header, so only events for OUR page / account are accepted
    if (allowed.length && allowed.indexOf(String(en.id)) < 0) return;
    (en.messaging || []).forEach(ev => {
      const m = ev.message;
      if (!m || m.is_echo) return;                          // our own replies come back as echoes
      const who = String(ev.sender && ev.sender.id || '');
      if (!who || allowed.indexOf(who) > -1) return;
      let t = m.text || '';
      (m.attachments || []).forEach(a => { t += (t ? '\n' : '') + '[' + (a.type || 'file') + '] ' + ((a.payload && a.payload.url) || ''); });
      if (!t) return;
      addToLead({ source: platform, handle: who, name: metaName(who, platform), text: t, msgId: m.mid, ts: ev.timestamp });
    });
  });
  return text('EVENT_RECEIVED');
}
function metaName(id, platform) {
  const tok = prop('META_PAGE_TOKEN'); if (!tok) return '';
  const c = CacheService.getScriptCache(), k = 'mn_' + id, hit = c.get(k);
  if (hit != null) return hit;
  let name = '';
  try {
    const f = platform === 'instagram' ? 'name,username' : 'first_name,last_name,name';
    const r = UrlFetchApp.fetch(GRAPH + '/' + encodeURIComponent(id) + '?fields=' + f + '&access_token=' + encodeURIComponent(tok), { muteHttpExceptions: true });
    const d = JSON.parse(r.getContentText() || '{}');
    name = d.name || [d.first_name, d.last_name].filter(Boolean).join(' ') || (d.username ? '@' + d.username : '');
  } catch (err) {}
  c.put(k, name, 21600);
  return name;
}
function sendMeta(b) {
  const tok = prop('META_PAGE_TOKEN');
  if (!tok) return { ok: false, error: 'META_PAGE_TOKEN is not set on the feeds script' };
  if (!b.to || !b.text) return { ok: false, error: 'Nothing to send' };
  const r = UrlFetchApp.fetch(GRAPH + '/me/messages?access_token=' + encodeURIComponent(tok), {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    payload: JSON.stringify({ recipient: { id: String(b.to) }, messaging_type: 'RESPONSE', message: { text: String(b.text).slice(0, 1900) } })
  });
  const d = JSON.parse(r.getContentText() || '{}');
  if (r.getResponseCode() >= 300 || d.error) {
    const why = (d.error && d.error.message) || ('HTTP ' + r.getResponseCode());
    // Meta only lets a page reply within 24 hours of the customer's last message
    return { ok: false, error: /window|24/.test(why) ? 'More than 24 hours since they last messaged — reply from the Instagram / Facebook app' : why };
  }
  return { ok: true, id: d.message_id || '' };
}

/* ---------------------------------------------------------------- email -- */
// Every 5 minutes: anything new in the inbox from the last two days.
// Newsletters, receipts and our own mail are skipped. Each Gmail message is
// recorded once, by its id, so nothing comes in twice.
function pollGmail() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;
  try {
    const own = [SHOP_EMAIL, Session.getEffectiveUser().getEmail()].concat(prop('OWN_EMAILS').split(',')).map(s => s.trim().toLowerCase()).filter(Boolean);
    const seen = JSON.parse(prop('GMAIL_SEEN') || '[]');
    const threads = GmailApp.search('in:inbox newer_than:2d -category:promotions -category:social -category:updates', 0, 40);
    threads.forEach(th => th.getMessages().forEach(m => {
      const id = m.getId();
      if (seen.indexOf(id) > -1) return;
      seen.push(id);
      const from = parseFrom(m.getFrom());
      if (!from.email || own.indexOf(from.email) > -1) return;
      if (/no-?reply|mailer-daemon|notifications?@|newsletter|unsubscribe@/i.test(from.email)) return;
      const bmg = /bookmygarage/i.test(from.email + ' ' + m.getSubject());
      const body = cleanBody(m.getPlainBody());
      if (!bmg && /unsubscribe/i.test(body.slice(-600)) && !/car|van|mot|service|brake|clutch|repair|quote|price/i.test(body)) return;   // marketing
      const t = (m.getSubject() ? 'Subject: ' + m.getSubject() + '\n' : '') + body;
      addToLead({ source: bmg ? 'bmg' : 'email', name: bmg ? '' : from.name, email: bmg ? '' : from.email, text: t.slice(0, 3000),
        msgId: 'gm_' + id, ts: m.getDate().getTime(), subject: m.getSubject(), meta: { threadId: th.getId() },
        reg: bmg ? bmgField(body, /reg(istration)?/i) : '', phone: bmg ? bmgField(body, /phone|mobile|tel/i) : '' });
    }));
    P().setProperty('GMAIL_SEEN', JSON.stringify(seen.slice(-800)));
  } finally { lock.releaseLock(); }
}
function parseFrom(f) {
  const m = String(f || '').match(/^\s*"?([^"<]*)"?\s*<([^>]+)>/);
  return m ? { name: m[1].trim(), email: m[2].trim().toLowerCase() } : { name: '', email: String(f || '').trim().toLowerCase() };
}
// Keep what they wrote, not the quoted thread under it
function cleanBody(b) {
  const lines = String(b || '').replace(/\r/g, '').split('\n');
  const out = [];
  for (const l of lines) {
    if (/^On .+wrote:\s*$/.test(l) || /^-{2,}\s*Original Message/i.test(l) || /^From: .+/.test(l) && out.length) break;
    if (/^>/.test(l)) continue;
    out.push(l);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
function bmgField(body, re) {
  const l = String(body).split('\n').find(x => re.test(x.split(':')[0] || ''));
  return l && l.indexOf(':') > -1 ? l.split(':').slice(1).join(':').trim().slice(0, 30) : '';
}
function sendEmail(b) {
  if (!b.to || !b.text) return { ok: false, error: 'Nothing to send' };
  const sig = '\n\n—\nKITH Cars · 020 4629 9469 · kithcars.com\nUnit 1, Soho Mills, London Road, Hackbridge, SM6 7HN';
  if (b.threadId) {
    try { GmailApp.getThreadById(b.threadId).reply(b.text + sig, { name: 'KITH Cars' }); return { ok: true }; } catch (err) {}
  }
  GmailApp.sendEmail(b.to, b.subject || 'Your enquiry — KITH Cars', b.text + sig, { name: 'KITH Cars', replyTo: SHOP_EMAIL });
  return { ok: true };
}

/* ------------------------------------------------- into the live inbox ---- */
// Supabase REST, with the service key from Script Properties
function sb(path, opt) {
  opt = opt || {};
  const url = prop('SUPABASE_URL').replace(/\/$/, '') + '/rest/v1/' + path;
  const key = prop('SUPABASE_KEY');
  if (!key) throw new Error('SUPABASE_KEY is not set on the feeds script');
  const r = UrlFetchApp.fetch(url, { method: opt.method || 'get', contentType: 'application/json', muteHttpExceptions: true,
    headers: Object.assign({ apikey: key, Authorization: 'Bearer ' + key }, opt.headers || {}), payload: opt.body ? JSON.stringify(opt.body) : undefined });
  const code = r.getResponseCode(), t = r.getContentText();
  if (code >= 300) throw new Error('Supabase ' + code + ': ' + t.slice(0, 200));
  return t ? JSON.parse(t) : null;
}
const intl = p => { let d = String(p || '').replace(/[^\d+]/g, ''); if (!d) return ''; if (d[0] === '+') d = d.slice(1); else if (d.slice(0, 2) === '00') d = d.slice(2); else if (d[0] === '0') d = '44' + d.slice(1); if (d.slice(0, 3) === '440') d = '44' + d.slice(3); return d; };
const INGEST_CH = { webform: 'website', website: 'website', whatsapp: 'whatsapp', instagram: 'instagram', facebook: 'facebook', email: 'email', sms: 'sms', bmg: 'bmg', phone: 'phone', gbp: 'gbp', tiktok: 'tiktok' };
// Hand one incoming message to inbox-ingest. It finds the person's open lead
// (or starts one) and the live inbox triages it within seconds.
// A message seen before (Meta and Twilio sometimes deliver twice) is skipped.
function addToLead(o) {
  const cache = CacheService.getScriptCache();
  if (o.msgId) { if (cache.get('in_' + o.msgId)) return ''; }
  const key = prop('SUPABASE_KEY');
  const r = UrlFetchApp.fetch(prop('SUPABASE_URL').replace(/\/$/, '') + '/functions/v1/inbox-ingest', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { apikey: key, Authorization: 'Bearer ' + key, 'x-caller': 'kith-feeds' },
    payload: JSON.stringify({
      channel: INGEST_CH[o.source] || 'other',
      sender_name: o.name || '', sender_phone: o.phone || '', sender_email: o.email || '', sender_handle: o.handle || '',
      reg: o.reg || '', message_text: String(o.text || '').trim(),
      received_at: new Date(o.ts || Date.now()).toISOString()
    })
  });
  let d = {}; try { d = JSON.parse(r.getContentText() || '{}'); } catch (err) {}
  if (r.getResponseCode() >= 300 || !d.ok) throw new Error('inbox-ingest: ' + (d.error || r.getResponseCode()));
  if (o.msgId) cache.put('in_' + o.msgId, '1', 21600);
  return d.lead_id || '';
}
// The live inbox's leads, read only — this script never writes them
function liveLeads() {
  const row = (sb('jobs?select=data&id=eq.__leads__') || [])[0];
  return ((row && row.data && row.data.leads) || []);
}

/* --------------------------------------------------------------- setup --- */
function setup() {
  const need = ['SUPABASE_URL', 'SUPABASE_KEY', 'FEEDS_SECRET'];
  const missing = need.filter(k => !prop(k));
  if (missing.length) throw new Error('Set these in Project Settings → Script properties first: ' + missing.join(', '));
  ScriptApp.getProjectTriggers().filter(t => ['pollGmail', 'runSales'].indexOf(t.getHandlerFunction()) > -1).forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('pollGmail').timeBased().everyMinutes(5).create();
  if (KS()) ScriptApp.newTrigger('runSales').timeBased().everyMinutes(10).create();
  else console.log('⚠ kith-sales.gs / kith-range.gs not found — campaigns will not send until they are added above this file and setup() is run again');
  sb('kith_sales?select=id&limit=1');   // proves the key and the table work
  console.log('✓ Ready. Gmail is checked every 5 minutes. Meta webhook verify token set: ' + (prop('META_VERIFY_TOKEN') ? 'yes' : 'NO'));
}
// Run from the editor to see a lead arrive end to end
function testLead() {
  console.log(addToLead({ source: 'webform', name: 'Test Customer', phone: '07700900123', reg: 'LV16XKT', text: 'TEST — how much for front brakes? (delete me)' }));
}

/* =============================================================================
   CAMPAIGNS — the sender
   =============================================================================
   Every 10 minutes:
     1. replies — anything a customer said since last time: a STOP opts them
        out everywhere and cancels what's queued; any other reply stops that
        campaign's follow-ups and tags the lead with the campaign.
     2. once a day after 8am — the automatic reminders (MOT, service, review,
        win-back, lapsed) that are switched on, for whoever is due.
     3. sends — whatever is due, inside sending hours, under the daily caps,
        one marketing message per person per week.
   Every message is marked "sending" BEFORE it goes, so a crash can never send
   it twice — it shows on the Campaigns screen as "check" instead.
   ============================================================================= */
const KS = () => (typeof KITHSales !== 'undefined' ? KITHSales : null);
function salesCfg() {
  const rows = sb('jobs?select=id,data&id=in.(__salescfg__,__channels__)') || [];
  const row = id => (rows.find(r => r.id === id) || {}).data || {};
  return { cfg: row('__salescfg__'), channels: row('__channels__').channels || {} };
}

function runSales(fromWeb) {
  const S = KS();
  if (!S) return { ok: false, error: 'kith-sales.gs is not in this project' };
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return { ok: false, error: 'Already running' };
  const out = { replies: 0, optOuts: 0, queued: 0, sent: 0, skipped: 0, waiting: 0, failed: 0 };
  try {
    const conf = salesCfg();
    if (conf.cfg.paused) return Object.assign(out, { ok: true, paused: true });
    scanReplies(S, out);
    const now = Date.now();
    const today = S.dayKey(now);
    let world = null;
    const getWorld = () => world || (world = loadWorld(S, now));
    if (P().getProperty('LAST_AUTO') !== today && S.ukParts(now).hour >= 8) {
      const w = getWorld();
      const have = new Set();
      pageAll('kith_sales?select=id,c:data->>campaign,o:data->>occasion,t:data->>to&data->>type=eq.send&data->>campaign=like.auto_*')
        .forEach(r => { have.add(r.id); have.add(r.c + r.o + r.t); });
      const fresh = S.runAutomations(w.contacts, conf.cfg.automations || {}, conf.cfg.settings || {}, now, have);
      insertSends(fresh); out.queued += fresh.length;
      P().setProperty('LAST_AUTO', today);
    }
    sendDue(S, conf, out, getWorld, now);
    out.ok = true;
    P().setProperty('LAST_RUN', JSON.stringify({ at: now, out }));
    heartbeat(out);
    return out;
  } catch (err) {
    console.error(err);
    P().setProperty('LAST_RUN', JSON.stringify({ at: Date.now(), error: String(err && err.message || err) }));
    try { heartbeat(Object.assign({}, out, { error: String(err && err.message || err) })); } catch (e2) {}
    return Object.assign(out, { ok: false, error: String(err && err.message || err) });
  } finally { lock.releaseLock(); }
}

// So the Campaigns screen can show the sender is alive and what it did
function heartbeat(out) {
  const S = KS();
  const sentToday = (sb('kith_sales?select=ch:data->>channel&data->>type=eq.send&data->>sentDay=eq.' + S.dayKey(Date.now()) + '&limit=5000') || [])
    .reduce((m, x) => { m[x.ch] = (m[x.ch] || 0) + 1; return m; }, {});
  sb('kith_sales', { method: 'post', headers: { Prefer: 'resolution=merge-duplicates' }, body: [{ id: 'run', updated_at: new Date().toISOString(),
    data: { type: 'run', at: Date.now(), last: out, sentToday, gmailLeft: MailApp.getRemainingDailyQuota(), sms: !!prop('TWILIO_SID') } }] });
}

// Everything the rules need to know about customers
function loadWorld(S, now) {
  const F = 'id,name:data->>name,phone:data->>phone,email:data->>email,reg:data->>reg,make:data->>make,model:data->>model,work:data->>work,' +
    'quote:data->>quote,stage:data->>stage,custType:data->>custType,fleetAccount:data->>fleetAccount,createdAt:data->>createdAt,stageAt:data->>stageAt,' +
    'completedAt:data->>completedAt,bookedFor:data->>bookedFor,marketingOptIn:data->>marketingOptIn,marketingOptInAt:data->>marketingOptInAt,' +
    'referralCode:data->>referralCode,reviewSentAt:data->>reviewSentAt,mergedInto:data->>mergedInto,isTest:data->>isTest,estApproved:data->>estApproved';
  const jobs = pageAll('jobs?select=' + F + '&id=not.like.__*').map(j => Object.assign(j, {
    stageAt: +j.stageAt || j.stageAt, completedAt: +j.completedAt || j.completedAt }));
  const leads = liveLeads().map(S.fromLive).filter(Boolean);
  const sales = pageAll('kith_sales?select=id,data&data->>type=in.(account,optout,optin)').map(r => Object.assign({ id: r.id }, r.data));
  const sends = pageAll('kith_sales?select=id,data&data->>type=eq.send&data->>status=in.(sent,sending)').map(r => Object.assign({ id: r.id }, r.data));
  const contacts = S.buildContacts({ jobs, leads, accounts: sales.filter(x => x.type === 'account'), prefs: sales.filter(x => x.type !== 'account'), sends }, now);
  return { contacts, find: (s) => contacts.find(c => c.key === s.contact) || contacts.find(c => c.phones.indexOf(s.to) > -1 || c.emails.indexOf(s.to) > -1) };
}
function pageAll(path) {
  if (path.indexOf('order=') < 0) path += '&order=id.asc';
  const all = [];
  for (let from = 0; from < 50000; from += 1000) {
    const rows = sb(path, { headers: { Range: from + '-' + (from + 999), 'Range-Unit': 'items' } }) || [];
    rows.forEach(r => all.push(r));
    if (rows.length < 1000) break;
  }
  return all;
}
function insertSends(list) {
  for (let i = 0; i < list.length; i += 200) {
    const chunk = list.slice(i, i + 200).map(x => ({ id: x.id, data: x, updated_at: new Date().toISOString() }));
    if (chunk.length) sb('kith_sales', { method: 'post', headers: { Prefer: 'resolution=ignore-duplicates' }, body: chunk });
  }
}
// Change one kith_sales row only if nobody else did in between
function casSales(id, fn) {
  for (let i = 0; i < 5; i++) {
    const row = (sb('kith_sales?id=eq.' + encodeURIComponent(id) + '&select=id,data,updated_at') || [])[0];
    if (!row) return null;
    const data = fn(row.data);
    if (data === undefined) return row.data;
    const res = sb('kith_sales?id=eq.' + encodeURIComponent(id) + '&updated_at=eq.' + encodeURIComponent(row.updated_at),
      { method: 'patch', headers: { Prefer: 'return=representation' }, body: { data, updated_at: new Date().toISOString() } });
    if (res && res.length) return data;
    Utilities.sleep(100 + Math.floor(Math.random() * 200));
  }
  throw new Error('Could not update ' + id);
}

/* --- 1. replies and STOPs ---- */
// Every customer message in the live inbox since the last look. Each one is
// handled once — remembered by lead and time in Script Properties — and the
// inbox's own leads are never written to.
//   STOP / UNSUBSCRIBE → opted out everywhere, everything queued cancelled
//   any other reply     → that campaign's follow-ups stop, the send is marked replied
function scanReplies(S, out) {
  const since = +(P().getProperty('LAST_SCAN') || (Date.now() - 15 * 60e3));
  const started = Date.now();
  let seen = []; try { seen = JSON.parse(P().getProperty('SCANNED') || '[]'); } catch (e) { seen = []; }
  const seenSet = new Set(seen);
  liveLeads().forEach(raw => {
    try {
      const l = S.fromLive(raw); if (!l) return;
      const fresh = l.msgs.filter(m => m.dir === 'in' && (m.ts || 0) > since - 30 * 60e3 && !seenSet.has(l.id + '|' + m.ts));
      if (!fresh.length) return;
      scanOne(S, l, fresh, out);
      fresh.forEach(m => { seenSet.add(l.id + '|' + m.ts); seen.push(l.id + '|' + m.ts); });
    } catch (err) { console.error('scan ' + (raw && raw.id), err); }   // one odd lead never stops the rest
  });
  P().setProperty('SCANNED', JSON.stringify(seen.slice(-400)));
  P().setProperty('LAST_SCAN', String(started));
}
function scanOne(S, l, fresh, out) {
  const addrs = [intl(l.from.phone), String(l.from.email || '').toLowerCase()].filter(Boolean);
  const stop = fresh.some(m => S.isStopMsg(m.text, m.channel || l.source));
  if (stop) {
    out.optOuts++;
    addrs.forEach(a => optOut(a, 'Replied: ' + String(fresh[fresh.length - 1].text || '').replace(/^Subject:.*\n/i, '').slice(0, 40)));
    addrs.forEach(a => cancelQueued(a, null, 'Opted out'));
  }
  const firstIn = Math.min.apply(null, fresh.map(m => m.ts || Date.now()));
  addrs.forEach(a => {
    const sent = (sb('kith_sales?select=id,data&data->>type=eq.send&data->>to=eq.' + encodeURIComponent(a) + '&data->>status=eq.sent&limit=50') || [])
      .filter(x => (x.data.sentAt || 0) > Date.now() - 30 * 864e5 && (x.data.sentAt || 0) < firstIn)
      .sort((x, y) => (y.data.sentAt || 0) - (x.data.sentAt || 0));
    if (!sent.length) return;
    const last = sent[0];
    if (!last.data.replyAt) { casSales(last.id, d => d.replyAt ? undefined : Object.assign(d, { replyAt: firstIn, replyText: String(fresh[0].text || '').slice(0, 200), replyLead: l.id })); out.replies++; }
    cancelQueued(a, last.data.campaign, 'They replied');
  });
}
function optOut(addr, why) {
  const isEmail = addr.indexOf('@') > -1;
  const id = 'O' + KS().hash(addr);
  sb('kith_sales', { method: 'post', headers: { Prefer: 'resolution=merge-duplicates' }, body: [{ id, updated_at: new Date().toISOString(),
    data: { type: 'optout', phone: isEmail ? '' : addr, email: isEmail ? addr : '', channels: ['email', 'sms', 'whatsapp'], at: Date.now(), why: why || '', by: 'Customer' } }] });
}
function cancelQueued(addr, campaign, why) {
  const q = sb('kith_sales?select=id,data&data->>type=eq.send&data->>to=eq.' + encodeURIComponent(addr) + '&data->>status=eq.queued' +
    (campaign ? '&data->>campaign=eq.' + encodeURIComponent(campaign) : '')) || [];
  q.forEach(x => casSales(x.id, d => d.status === 'queued' ? Object.assign(d, { status: 'cancelled', why }) : undefined));
}

/* --- 3. sending ---- */
function sendDue(S, conf, out, getWorld, now) {
  const settings = conf.cfg.settings || {};
  if (!S.inHours(now, settings)) return;
  const due = sb('kith_sales?select=id,data&data->>type=eq.send&data->>status=eq.queued&data->>sendAt=lte.' + now + '&order=data->>sendAt.asc&limit=80') || [];
  if (!due.length) return;
  const w = getWorld();
  const today = S.dayKey(now);
  const sentToday = { email: 0, sms: 0, whatsapp: 0 };
  (sb('kith_sales?select=ch:data->>channel&data->>type=eq.send&data->>sentDay=eq.' + today + '&limit=5000') || []).forEach(x => { sentToday[x.ch] = (sentToday[x.ch] || 0) + 1; });
  const camps = {};
  const campOf = id => {
    if (camps[id] !== undefined) return camps[id];
    if (/^auto_/.test(id)) return (camps[id] = S.autoCampaign(id.slice(5), (conf.cfg.automations || {})[id.slice(5)]));
    const row = (sb('kith_sales?select=data&id=eq.' + encodeURIComponent(id)) || [])[0];
    return (camps[id] = row ? row.data : null);
  };
  const t0 = Date.now();
  for (const row of due) {
    if (Date.now() - t0 > 4 * 60e3) break;                      // Apps Script stops at 6 minutes
    const send = row.data;
    const camp = campOf(send.campaign);
    if (!camp || camp.status === 'cancelled') { casSales(row.id, d => d.status === 'queued' ? Object.assign(d, { status: 'cancelled', why: camp ? 'Campaign cancelled' : 'Campaign deleted' }) : undefined); out.skipped++; continue; }
    // paused (or an automation switched off): look again in 6 hours, so it never blocks the queue
    if (camp.status === 'paused' || (camp.auto && !camp.on)) { casSales(row.id, d => d.status === 'queued' ? Object.assign(d, { sendAt: Date.now() + 6 * 3600e3 }) : undefined); out.waiting++; continue; }
    const c = w.find(send);
    const v = S.check(send, c, settings, Date.now(), sentToday);
    if (v.do === 'skip') { casSales(row.id, d => d.status === 'queued' ? Object.assign(d, { status: 'skipped', why: v.why }) : undefined); out.skipped++; continue; }
    if (v.do === 'wait') { casSales(row.id, d => d.status === 'queued' ? Object.assign(d, { sendAt: Math.round(v.until) }) : undefined); out.waiting++; continue; }
    // Gmail's daily allowance is shared with inbox replies: keep 10 back for those
    if (send.channel === 'email' && MailApp.getRemainingDailyQuota() < 10) {
      casSales(row.id, d => d.status === 'queued' ? Object.assign(d, { sendAt: Math.round(S.nextSlot(Date.now() + 12 * 3600e3, settings)) }) : undefined); out.waiting++; continue;
    }
    // claim it — after this line it can never be sent twice
    let claimed = false;
    casSales(row.id, d => { claimed = false; if (d.status !== 'queued') return undefined; claimed = true; return Object.assign(d, { status: 'sending', claimedAt: Date.now() }); });
    if (!claimed) continue;
    let res;
    try { res = deliver(send, conf); } catch (err) { res = { ok: false, error: String(err && err.message || err) }; }
    const at = Date.now();
    casSales(row.id, d => Object.assign(d, res.ok ? { status: 'sent', sentAt: at, sentDay: S.dayKey(at), via: res.via || send.channel } : { status: 'failed', error: res.error || 'refused', failedAt: at }));
    if (res.ok) {
      out.sent++; sentToday[send.channel] = (sentToday[send.channel] || 0) + 1;
      const done = Object.assign({}, send, { status: 'sent', sentAt: at });
      if (c) { c.sends.push(done); c.lastMarketing = at; }
      const nxt = c && S.followUp(camp, done, c, settings);
      if (nxt) { insertSends([nxt]); out.queued++; }
    } else out.failed++;
  }
}
function deliver(send, conf) {
  if (send.channel === 'email') {
    if (MailApp.getRemainingDailyQuota() < 1) return { ok: false, error: 'Gmail\'s daily limit is used up' };
    GmailApp.sendEmail(send.to, send.subject || 'KITH Cars', send.text, { name: 'KITH Cars', replyTo: SHOP_EMAIL });
    return { ok: true, via: 'Gmail' };
  }
  if (send.channel === 'sms') return sendSms(send.to, send.text);
  if (send.channel === 'whatsapp') {
    const ch = conf.channels || {};
    if (!ch.relay || !ch.secret) return { ok: false, error: 'WhatsApp relay not set up' };
    if (!send.template) return { ok: false, error: 'No WhatsApp template on this campaign' };
    const r = UrlFetchApp.fetch(ch.relay, { method: 'post', contentType: 'text/plain', muteHttpExceptions: true,
      payload: JSON.stringify({ action: 'send', secret: ch.secret, to: send.to, useTemplate: true, template: send.template, params: send.params || [] }) });
    let d = {}; try { d = JSON.parse(r.getContentText() || '{}'); } catch (err) {}
    return d.ok ? { ok: true, via: 'WhatsApp' } : { ok: false, error: d.error || ('relay ' + r.getResponseCode()) };
  }
  return { ok: false, error: 'Unknown channel' };
}

/* --- texts (Twilio) ---- */
function sendSms(to, body) {
  const sid = prop('TWILIO_SID'), tok = prop('TWILIO_TOKEN'), from = prop('TWILIO_FROM');
  if (!sid || !tok || !from) return { ok: false, error: 'Texts aren\'t set up — add the Twilio details to the feeds script' };
  const num = '+' + intl(to);
  if (!/^\+447\d{9}$/.test(num)) return { ok: false, error: 'Not a UK mobile: ' + to };
  const r = UrlFetchApp.fetch('https://api.twilio.com/2010-04-01/Accounts/' + sid + '/Messages.json', {
    method: 'post', muteHttpExceptions: true, payload: { To: num, From: from, Body: String(body || '').slice(0, 1500) },
    headers: { Authorization: 'Basic ' + Utilities.base64Encode(sid + ':' + tok) } });
  let d = {}; try { d = JSON.parse(r.getContentText() || '{}'); } catch (err) {}
  if (r.getResponseCode() >= 300) return { ok: false, error: d.message || ('Twilio ' + r.getResponseCode()) };
  return { ok: true, via: 'Text', id: d.sid };
}
function mediaNote(q) {
  const n = +(q.NumMedia || 0); let t = '';
  for (let i = 0; i < n; i++) t += '\n[photo] ' + (q['MediaUrl' + i] || '');
  return t;
}
