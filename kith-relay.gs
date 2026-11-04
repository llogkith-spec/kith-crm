/* =============================================================================
   KITH WHATSAPP RELAY  ·  kith-relay.gs  ·  v2 (Nov 2026)
   =============================================================================
   Paste this whole file into a Google Apps Script project, set the Script
   Properties below, and Deploy → New deployment → Web app:
       Execute as: Me      Who has access: Anyone
   Paste the /exec address into the CRM:  ⚙ Settings → Channels.

   What it does
     1. SEND      the CRM posts {action:'send', ...}; this sends it through the
                  WhatsApp Cloud API and hands back the message id.
     2. STATUS    Meta tells this script when each message is sent, delivered
                  and read. Kept in the CRM database (jobs row '__wa_status__')
                  so the Awaiting Decision screen can show ✓ / ✓✓ / blue ✓✓.
     3. REPLIES   customer messages land in the CRM Inbox (table kith_leads),
                  so a "YES" shows up against the job it answers.

   Script Properties (Project Settings → Script properties)
     META_TOKEN      permanent access token from Meta (System User token)
     PHONE_ID        WhatsApp phone number ID (not the number itself)
     VERIFY_TOKEN    any word you choose — typed again in Meta's webhook setup
     SHARED_SECRET   any long random phrase — typed again in the CRM Settings
     SB_URL          https://mxyrxyhvjndgjqupgstu.supabase.co
     SB_KEY          the Supabase anon key (same one the CRM uses)

   Meta webhook (developers.facebook.com → your app → WhatsApp → Configuration)
     Callback URL:   this script's /exec address
     Verify token:   the VERIFY_TOKEN above
     Subscribe to:   messages
   ============================================================================= */

var GRAPH = 'https://graph.facebook.com/v20.0/';

function P(k) { return PropertiesService.getScriptProperties().getProperty(k) || ''; }
function json(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

/* ---------------------------------------------------------------- GET ----- */
// Meta checks the webhook with a GET before it will send anything.
function doGet(e) {
  var p = (e && e.parameter) || {};
  if (p['hub.mode'] === 'subscribe') {
    if (p['hub.verify_token'] === P('VERIFY_TOKEN')) return ContentService.createTextOutput(p['hub.challenge'] || '');
    return ContentService.createTextOutput('wrong verify token');
  }
  return json({ ok: true, relay: 'kith', version: 2 });
}

/* --------------------------------------------------------------- POST ----- */
function doPost(e) {
  var body = {};
  try { body = JSON.parse((e && e.postData && e.postData.contents) || '{}'); } catch (err) { return json({ ok: false, error: 'bad json' }); }

  // Meta webhook — statuses and incoming messages
  if (body.object === 'whatsapp_business_account') {
    try { handleWebhook(body); } catch (err) { console.error(err); }
    return json({ ok: true });
  }

  // Everything else comes from the CRM and must carry the secret
  if (!P('SHARED_SECRET') || body.secret !== P('SHARED_SECRET')) return json({ ok: false, error: 'wrong secret' });

  if (body.action === 'ping') {
    return json({ ok: true, version: 2,
      ready: { token: !!P('META_TOKEN'), phoneId: !!P('PHONE_ID'), key: !!(P('SB_URL') && P('SB_KEY')), webhook: !!P('VERIFY_TOKEN') },
      sentThisHour: countThisHour(false) });
  }
  if (body.action === 'send') return json(sendMessage(body));
  return json({ ok: false, error: 'unknown action' });
}

/* --------------------------------------------------------------- SEND ----- */
function toIntl(n) {
  n = String(n || '').replace(/\D/g, '');
  if (n.indexOf('0') === 0) n = '44' + n.slice(1);
  return n;
}
function sendMessage(b) {
  if (!P('META_TOKEN') || !P('PHONE_ID')) return { ok: false, error: 'Relay not set up — META_TOKEN / PHONE_ID missing' };
  var to = toIntl(b.to);
  if (!to) return { ok: false, error: 'No number' };
  var payload;
  if (b.useTemplate && b.template) {
    var comps = [];
    // a template with a PDF header (kith_estimate) carries the document here
    if (b.document && b.document.link) comps.push({ type: 'header', parameters: [{ type: 'document', document: { link: b.document.link, filename: b.document.filename || 'estimate.pdf' } }] });
    if (b.params && b.params.length) comps.push({ type: 'body', parameters: b.params.map(function (x) { return { type: 'text', text: String(x) }; }) });
    payload = { messaging_product: 'whatsapp', to: to, type: 'template',
      template: { name: b.template, language: { code: 'en_GB' }, components: comps } };
  } else if (b.document && b.document.link) {
    payload = { messaging_product: 'whatsapp', to: to, type: 'document',
      document: { link: b.document.link, filename: b.document.filename || 'estimate.pdf', caption: String(b.text || '').slice(0, 1000) } };
  } else {
    payload = { messaging_product: 'whatsapp', to: to, type: 'text', text: { body: String(b.text || ''), preview_url: true } };
  }
  var res = UrlFetchApp.fetch(GRAPH + P('PHONE_ID') + '/messages', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + P('META_TOKEN') }, payload: JSON.stringify(payload) });
  var out = {};
  try { out = JSON.parse(res.getContentText()); } catch (err) {}
  if (res.getResponseCode() < 300 && out.messages && out.messages[0]) {
    var id = out.messages[0].id;
    countThisHour(true);
    saveStatus(id, 'accepted', Date.now(), to);
    return { ok: true, id: id };
  }
  var e = out.error || {};
  // 131047 = more than 24 hours since the customer last messaged: needs a template
  if (e.code === 131047 || /re-engagement|24 hour/i.test(e.message || '')) return { ok: false, needsTemplate: true, error: 'Outside the 24-hour window — needs an approved template' };
  return { ok: false, error: (e.message || ('Meta said ' + res.getResponseCode())) };
}
function countThisHour(add) {
  var c = CacheService.getScriptCache(), k = 'sent-' + Math.floor(Date.now() / 3600000);
  var n = parseInt(c.get(k) || '0', 10);
  if (add) { n++; c.put(k, String(n), 4000); }
  return n;
}

/* ------------------------------------------------------------ WEBHOOK ----- */
function handleWebhook(body) {
  (body.entry || []).forEach(function (en) {
    (en.changes || []).forEach(function (ch) {
      var v = ch.value || {};
      (v.statuses || []).forEach(function (s) {
        saveStatus(s.id, s.status, parseInt(s.timestamp, 10) * 1000, s.recipient_id,
          s.errors && s.errors[0] ? (s.errors[0].title || s.errors[0].message || '') : '');
      });
      var names = {};
      (v.contacts || []).forEach(function (c) { names[c.wa_id] = (c.profile && c.profile.name) || ''; });
      (v.messages || []).forEach(function (m) { saveIncoming(m, names[m.from] || ''); });
    });
  });
}

function ukPhone(n) {
  n = String(n || '').replace(/\D/g, '');
  if (n.indexOf('44') === 0) n = '0' + n.slice(2);
  else if (n && n.charAt(0) !== '0') n = '0' + n;
  return n;
}

/* -------------------------------------------------------- SUPABASE ------- */
function sb(path, opt) {
  opt = opt || {};
  var h = { apikey: P('SB_KEY'), Authorization: 'Bearer ' + P('SB_KEY'), 'Content-Type': 'application/json' };
  if (opt.prefer) h.Prefer = opt.prefer;
  var res = UrlFetchApp.fetch(P('SB_URL') + '/rest/v1/' + path, {
    method: opt.method || 'get', headers: h, muteHttpExceptions: true,
    payload: opt.body ? JSON.stringify(opt.body) : undefined });
  var t = res.getContentText();
  try { return { code: res.getResponseCode(), data: t ? JSON.parse(t) : null }; } catch (err) { return { code: res.getResponseCode(), data: null }; }
}

// One row holds every message's latest status. Order matters: a late
// "delivered" never overwrites "read".
var RANK = { accepted: 0, sent: 1, delivered: 2, read: 3, failed: 4 };
function saveStatus(id, status, at, to, err) {
  if (!id || !P('SB_URL')) return;
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var r = sb('jobs?id=eq.__wa_status__&select=data');
    var data = (r.data && r.data[0] && r.data[0].data) || { msgs: {} };
    data.msgs = data.msgs || {};
    var cur = data.msgs[id];
    if (!cur || (RANK[status] || 0) >= (RANK[cur.s] || 0)) {
      data.msgs[id] = { s: status, at: at || Date.now(), to: to || (cur && cur.to) || '', err: err || '' };
    }
    // keep the newest 3000
    var ids = Object.keys(data.msgs);
    if (ids.length > 3000) {
      ids.sort(function (a, b) { return (data.msgs[a].at || 0) - (data.msgs[b].at || 0); });
      ids.slice(0, ids.length - 3000).forEach(function (k) { delete data.msgs[k]; });
    }
    data.updatedAt = Date.now();
    sb('jobs', { method: 'post', prefer: 'resolution=merge-duplicates,return=minimal',
      body: [{ id: '__wa_status__', data: data, updated_at: new Date().toISOString() }] });
  } finally { lock.releaseLock(); }
}

// A customer message → the CRM Inbox, added to their open conversation
function saveIncoming(m, name) {
  if (!P('SB_URL')) return;
  var text = '';
  if (m.type === 'text') text = (m.text && m.text.body) || '';
  else if (m.type === 'button') text = (m.button && m.button.text) || '';
  else if (m.type === 'interactive') text = ((m.interactive && (m.interactive.button_reply || m.interactive.list_reply)) || {}).title || '';
  else text = '[' + m.type + ']';
  var phone = ukPhone(m.from);
  var ms = parseInt(m.timestamp, 10) * 1000 || Date.now();
  var msg = { dir: 'in', text: text, at: Utilities.formatDate(new Date(ms), 'Europe/London', 'dd MMM yyyy, HH:mm'), ts: ms, channel: 'whatsapp', waId: m.id };

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var r = sb('kith_leads?select=id,data&order=updated_at.desc&limit=200');
    var rows = (r.data || []).filter(function (x) {
      var d = x.data || {};
      return d.source === 'whatsapp' && d.status !== 'converted' && d.status !== 'junk' &&
        ukPhone((d.from || {}).phone) === phone;
    });
    var lead;
    if (rows.length) {
      lead = rows[0].data;
      lead.msgs = lead.msgs || [];
      if (lead.msgs.some(function (x) { return x.waId === m.id; })) return;   // Meta sends twice sometimes
      lead.msgs.push(msg);
      lead.ts = ms; lead.at = msg.at; lead.unread = true;
      if (lead.status === 'closed') lead.status = 'open';
    } else {
      lead = { id: 'WA' + ms + Math.floor(Math.random() * 997), source: 'whatsapp',
        from: { name: name, phone: phone, email: '', handle: '' }, subject: '', reg: '', work: '',
        status: 'new', unread: true, at: msg.at, ts: ms, msgs: [msg], assignedTo: '', meta: { via: 'relay' } };
    }
    lead.updatedAt = new Date().toISOString();
    sb('kith_leads', { method: 'post', prefer: 'resolution=merge-duplicates,return=minimal',
      body: [{ id: lead.id, data: lead, updated_at: lead.updatedAt }] });
  } finally { lock.releaseLock(); }
}
