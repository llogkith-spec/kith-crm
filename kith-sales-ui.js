/* =============================================================================
   KITH SALES — the Customers, Campaigns and B2B screens
   =============================================================================
   Loaded by kith-inbox.html after its own script, and uses its helpers
   (get, cas, sheet, toast, esc, ME, LEADS, JOBS_ALL…). The rules about who may
   be messaged and what goes out are all in kith-sales.js; this file only shows
   them and saves what people change.

   Stored in Supabase table kith_sales {id, data, updated_at}, data.type =
     campaign · send · account · optout · optin · run (the sender's heartbeat)
   Settings in the jobs row __salescfg__.
   ============================================================================= */
(function () {
'use strict';
const S = window.KITHSales;
const V = { view: 'inbox', loadedAt: 0, loading: false, seg: 'customers', q: '', shown: 150, open: null, b2bQ: '', b2bOwner: '' };
let D = { contacts: [], campaigns: [], accounts: [], prefs: [], sends: [], run: null, cfg: {}, b2bRaw: [], b2bMissing: false };
const isBoss = () => MY && (MY.role === 'director' || MY.filter === 'director' || (MY.roles || []).includes('director'));
const DAY = 864e5;
const money = n => '£' + Math.round(n || 0).toLocaleString('en-GB');
const dshort = t => t ? new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' }) : '—';
const ago = t => F.ago(t, Date.now());
const REVIEW_LINK = 'https://www.google.com/maps/place/KITH+Cars+Garage+%26+Bodyshop/@51.3793389,-0.1572743,17z/data=!4m8!3m7!1s0x487607eaf5ef8273:0x62f758e7463a651d!8m2!3d51.3793389!4d-0.1546994!9m1!1b1!16s%2Fg%2F11xlrxbz7j';
const ACTIVE = ['intake', 'labour', 'parts', 'financial', 'signoff', 'disapproved', 'contact', 'contacted', 'waiting', 'waiting2', 'ready'];
const leadForJob = j => LEADS.find(l => l.id === j.fromLead || l.id === j.leadId || l.jobId === j.id) || null;
const actFor = j => S.jobActivity(j, { outbox: D.outbox, lead: leadForJob(j) }, Date.now());
const until = t => { const d = t - Date.now(), a = Math.abs(d), h = Math.round(a / 3600e3); const w = a < 3600e3 ? Math.round(a / 60e3) + ' min' : h < 24 ? h + 'h' : Math.round(a / 864e5) + 'd'; return d >= 0 ? 'in ' + w : w + ' overdue'; };
const settings = () => Object.assign({ reviewLink: REVIEW_LINK, smsPence: 4 }, D.cfg.settings || {});

/* ------------------------------------------------------------ styles ---- */
const css = document.createElement('style');
css.textContent = `
.sv{padding:1rem 1rem 4rem;overflow-y:auto;flex:1;min-height:0}
.sv h2{font-size:1.5rem;margin:0 0 .2rem}
.sv .lede{color:var(--ink-2);margin:0 0 1rem;max-width:70ch}
.row2{display:flex;gap:.6rem;flex-wrap:wrap;align-items:center;margin-bottom:.8rem}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(270px,1fr));gap:.7rem;margin-bottom:1.2rem}
.card{background:var(--card);border:1px solid var(--line-soft);border-radius:8px;padding:.75rem .85rem;min-width:0}
.card h3{font-size:1.1rem;margin:0}
.card .hint{margin:.2rem 0}
.card.off{opacity:.7}
.kv{display:flex;gap:1rem;flex-wrap:wrap;margin-top:.5rem}
.kv span{font-size:.75rem;color:var(--ink-3)}
.kv b{display:block;font-family:"Barlow Condensed",sans-serif;font-size:1.25rem;color:var(--ink)}
.sw{position:relative;display:inline-flex;align-items:center;gap:.45rem;font-size:.85rem;cursor:pointer}
.sw input{width:2.3rem;height:1.25rem;appearance:none;-webkit-appearance:none;background:var(--line);border-radius:99px;position:relative;cursor:pointer;margin:0;flex:none}
.sw input::after{content:"";position:absolute;top:2px;left:2px;width:calc(1.25rem - 4px);height:calc(1.25rem - 4px);border-radius:50%;background:var(--ink);transition:left .15s}
.sw input:checked{background:var(--go)}
.sw input:checked::after{left:calc(100% - 1.25rem + 2px)}
.sw input:disabled{opacity:.5;cursor:not-allowed}
table.t{width:100%;border-collapse:collapse;font-size:.85rem}
table.t th,table.t td{text-align:left;padding:.45rem .5rem;border-bottom:1px solid var(--line-soft);vertical-align:top}
table.t th{font-size:.68rem;text-transform:uppercase;letter-spacing:.08em;color:var(--ink-3);font-weight:600}
table.t tr.click{cursor:pointer}table.t tr.click:hover td{background:var(--bg-2)}
.tw{overflow-x:auto;border:1px solid var(--line-soft);border-radius:8px}
.cons{display:inline-flex;gap:.2rem}
.cons i{font-style:normal;font-size:.68rem;font-family:"IBM Plex Mono",monospace;border:1px solid var(--line);border-radius:3px;padding:0 .25rem;color:var(--ink-3)}
.cons i.y{border-color:var(--go);color:var(--go)}.cons i.n{border-color:var(--stop);color:var(--stop);text-decoration:line-through}
.board{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(230px,1fr);gap:.6rem;overflow-x:auto;padding-bottom:.6rem}
.col{background:var(--bg-2);border:1px solid var(--line-soft);border-radius:8px;padding:.5rem;min-height:120px}
.col h3{font-size:.95rem;display:flex;justify-content:space-between;margin:0 .1rem .5rem}
.col h3 span{font-family:"IBM Plex Mono",monospace;font-size:.75rem;color:var(--ink-3)}
.acc{display:block;width:100%;text-align:left;background:var(--card);border:1px solid var(--line-soft);border-radius:6px;padding:.5rem .6rem;margin-bottom:.4rem}
.acc:hover{border-color:var(--gold)}
.acc b{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.acc small{display:block;color:var(--ink-3);font-size:.75rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.acc .late{color:var(--stop)}
.sum{border:1px solid var(--gold);background:var(--gold-bg);border-radius:8px;padding:.7rem .85rem;margin:.6rem 0}
.sum .big{font-family:"Barlow Condensed",sans-serif;font-size:1.6rem;font-weight:700;line-height:1}
.chips2{display:flex;gap:.3rem;flex-wrap:wrap;margin:.3rem 0}
.chips2 button{font-size:.72rem;font-family:"IBM Plex Mono",monospace;border:1px solid var(--line);background:none;border-radius:3px;padding:.05rem .35rem;color:var(--ink-2)}
.prev{white-space:pre-wrap;background:var(--bg);border:1px solid var(--line-soft);border-radius:6px;padding:.5rem .65rem;font-size:.85rem;margin:.3rem 0;overflow-wrap:anywhere}
.secb{border-top:1px solid var(--line-soft);margin-top:1rem;padding-top:.8rem}
.secb > h3{font-size:1.05rem;margin:0 0 .5rem}
.cnt{font-family:"IBM Plex Mono",monospace;font-size:.72rem;color:var(--ink-3)}
.cnt.over{color:var(--warn)}
`;
document.head.appendChild(css);

/* ------------------------------------------------------------- data ----- */
async function pageAll(path) {
  const out = [];
  for (let from = 0; from < 60000; from += 1000) {
    const rows = await get(path, { Range: from + '-' + (from + 999), 'Range-Unit': 'items' });
    (rows || []).forEach(r => out.push(r));
    if (!rows || rows.length < 1000) break;
  }
  return out;
}
async function loadSales(force) {
  if (V.loading) return;
  if (!force && Date.now() - V.loadedAt < 60e3) return;
  V.loading = true;
  try {
    if (!JOBS_ALL.length || Date.now() - BOOK_AT > 30 * 60e3) await loadHistory();
    if (typeof refreshLeads === 'function') await refreshLeads();
    let rows = [];
    try { rows = await pageAll('kith_sales?select=id,data,updated_at'); }
    catch (e) { if (e.status === 404) { D.missing = true; rows = []; } else throw e; }
    D.missing = D.missing && !rows.length;
    let b2b = [];
    try { b2b = await get('kith_b2b?select=id,data&limit=5000'); D.b2bMissing = false; } catch (e) { D.b2bMissing = true; }
    const cfg = await get('jobs?select=id,data&id=eq.__salescfg__');
    // every job a customer is waiting on, in full — for the chase and the message history
    const act = await get('jobs?select=id,data&data->>stage=in.(' + ACTIVE.join(',') + ')&limit=3000');
    D.active = {}; (act || []).forEach(r => { if (r.data) D.active[r.id] = Object.assign({ id: r.id }, r.data); });
    try { D.outbox = (((await get('jobs?select=data&id=eq.__outbox__')) || [])[0] || {}).data; D.outbox = (D.outbox && D.outbox.msgs) || []; } catch (e) { D.outbox = []; }
    D.cfg = ((cfg || [])[0] || {}).data || {};
    const by = t => rows.filter(r => r.data && r.data.type === t).map(r => Object.assign({ id: r.id, _at: r.updated_at }, r.data));
    D.campaigns = by('campaign').sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    D.sends = by('send');
    D.prefs = by('optout').concat(by('optin'));
    D.run = by('run')[0] || null;
    const saved = by('account');
    const linked = new Set(saved.map(a => a.b2bId).filter(Boolean));
    D.b2bRaw = b2b || [];
    D.accounts = saved.concat((b2b || []).filter(r => r.data && !linked.has(r.id)).map(r => S.accountFromB2B(Object.assign({ id: r.id }, r.data))));
    D.contacts = S.buildContacts({ jobs: JOBS_ALL, leads: LEADS, accounts: D.accounts, prefs: D.prefs, sends: D.sends }, Date.now());
    V.loadedAt = Date.now();
    badges();
  } catch (e) { toast('⚠ Could not load sales data: ' + e.message, 6000); }
  finally { V.loading = false; }
}
async function saveRow(id, fn) {
  return cas('kith_sales', id, cur => { const out = fn(cur ? clone(cur) : null); if (out) out.updatedAt = Date.now(); return out; });
}
async function insertSends(list) {
  for (let i = 0; i < list.length; i += 200) {
    const chunk = list.slice(i, i + 200).map(x => ({ id: x.id, data: x, updated_at: new Date().toISOString() }));
    const r = await fetch(REST() + 'kith_sales', { method: 'POST', headers: HDR({ Prefer: 'resolution=ignore-duplicates' }), body: JSON.stringify(chunk) });
    if (!r.ok) throw new Error('Could not queue the messages (' + r.status + ')');
  }
}
async function saveCfg(fn) {
  const out = await cas('jobs', '__salescfg__', cur => fn(Object.assign({}, cur || {})));
  D.cfg = out || D.cfg;
}

/* ---------------------------------------------------------- switching --- */
// The Inbox: the tab beside these screens if this page has one, otherwise
// the live inbox page (kith-inbox.html) in a new tab
const HAS_INBOX = () => !!document.getElementById('view-inbox');
function openInbox(leadId) {
  if (HAS_INBOX() && typeof openLead === 'function') { show('inbox'); TAB = 'all'; render(); if (leadId) openLead(leadId); return; }
  window.open('kith-inbox.html', '_blank');
}
function show(v) {
  if (v === 'inbox' && !HAS_INBOX()) { openInbox(); return; }
  V.view = v;
  document.querySelectorAll('#views [data-v]').forEach(b => b.classList.toggle('on', b.dataset.v === v));
  if (HAS_INBOX()) $('view-inbox').hidden = v !== 'inbox';
  $('view-sales').hidden = v === 'inbox';
  try { localStorage.setItem('kith_sales_view', v); } catch (e) {}
  if (v === 'inbox') { render(); return; }
  paint();
  loadSales().then(paint);
}
function paint() {
  if (V.view === 'inbox' || EDITING) return;
  const el = $('view-sales');
  if (D.missing) { el.innerHTML = '<div class="sv"><div class="note stop"><b>The kith_sales table isn\'t set up yet</b>Run the SQL in the setup notes (README-inbox.md, step 2) in Supabase, then refresh.</div></div>'; return; }
  if (!V.loadedAt) { el.innerHTML = '<div class="sv"><div class="empty"><span class="spin"></span> Loading customers…</div></div>'; return; }
  ({ pipeline: paintPipeline, customers: paintCustomers, campaigns: paintCampaigns, b2b: paintB2B })[V.view]();
}
document.querySelectorAll('#views [data-v]').forEach(b => b.onclick = () => show(b.dataset.v));
// keep the badges on the section tabs current
if (HAS_INBOX() && typeof render === 'function') { const _render = render; render = function () { _render.apply(this, arguments); badges(); }; }
function badges() {
  try { if ($('vcInbox') && typeof TABS !== 'undefined') $('vcInbox').textContent = LEADS.filter(TABS[0].f).length || ''; } catch (e) {}
  try { if ($('vcB2b')) $('vcB2b').textContent = S.b2bDue(D.accounts, Date.now()).length || ''; } catch (e) {}
}
setInterval(() => { if (ME && V.view !== 'inbox' && document.visibilityState !== 'hidden' && !EDITING) loadSales().then(paint); }, 90e3);

/* =========================================================== PIPELINE === */
// Every lead on one ladder: cold B2B → enquiry → range sent → wants the
// exact price → quote sent → booked. The rules are S.pipeline().
V.pipeWho = 'all'; V.pipeCooled = false;
function paintPipeline() {
  const now = Date.now();
  const leadStage = l => l.live ? S.liveStage(l, jobOf(l)) : F.stage(l, jobOf(l));
  const P = S.pipeline({ jobs: JOBS_ALL, leads: LEADS, accounts: D.accounts }, leadStage, now);
  const keep = c => V.pipeWho === 'all' || (V.pipeWho === 'b2b' ? c.b2b : !c.b2b);
  const fn = S.funnel({ leads: LEADS, jobs: JOBS_ALL }, 30, now);
  const pc = (a, b) => b ? Math.round(a / b * 100) + '%' : '—';
  const step = (label, n, of) => '<span>' + esc(label) + '<b>' + n + (of !== undefined ? ' <small style="font-size:.8rem;color:var(--ink-3)">' + pc(n, of) + '</small>' : '') + '</b></span>';
  const card = c => {
    const src = c.kind === 'lead' ? ((F.SOURCES[c.source] || {}).label || 'Inbox') : c.kind === 'account' ? 'B2B' : (c.b2b ? 'Trade · CRM' : 'CRM');
    return '<button class="acc" data-pk="' + esc(c.kind) + '" data-pid="' + esc(c.id) + '"' + (c.stale ? ' style="border-left:3px solid var(--stop)"' : '') + '>' +
      '<b>' + esc(c.name) + (c.value ? ' <span style="float:right;color:var(--gold);font-weight:600">' + money(c.value) + '</span>' : '') + '</b>' +
      '<small>' + (c.reg ? '<span class="plate" style="font-size:.7rem;padding:0 .25rem">' + esc(c.reg) + '</span> ' : '') + esc(c.what || '—') + '</small>' +
      '<small' + (c.stale ? ' class="late"' : '') + '>' + esc(src) + ' · ' + (c.age ? c.age + ' day' + (c.age === 1 ? '' : 's') : 'today') + (c.stale ? ' — going cold' : '') +
        (c.crmStage ? ' · ' + esc((F.CRM_STAGES[c.crmStage] || c.crmStage).replace(/^\d+b?\s·\s/, '')) : '') + '</small>' + jobLine(c) + '</button>';
  };
  const cols = S.PIPE.map(st => {
    const list = P.byStage[st.k].list.filter(keep).sort((a, b) => (b.stale - a.stale) || ((a.since || 0) - (b.since || 0)));
    const val = Math.round(list.reduce((s2, c) => s2 + (c.value || 0), 0)), stale = list.filter(c => c.stale).length;
    return '<div class="col"><h3>' + esc(st.label) + '<span>' + list.length + '</span></h3>' +
      '<p class="hint" style="margin:-.3rem .1rem .5rem">' + esc(st.sub) + (val ? ' · ' + money(val) : '') + (stale ? ' · <b style="color:var(--stop)">' + stale + ' going cold</b>' : '') + '</p>' +
      list.slice(0, 60).map(card).join('') + (list.length > 60 ? '<p class="hint">+' + (list.length - 60) + ' more</p>' : '') + '</div>';
  }).join('');
  const cooled = P.cooled.filter(keep);
  $('view-sales').innerHTML = '<div class="sv"><div class="row2" style="justify-content:space-between"><div><h2>Pipeline</h2>' +
    '<p class="lede">Every lead from cold to booked, warmest on the right. Anything sitting too long on its step is marked going cold.</p></div>' +
    '<nav class="tabs" style="flex:none">' + [['all', 'Everyone'], ['retail', 'Retail'], ['b2b', 'B2B']].map(x => '<button data-pw="' + x[0] + '" class="' + (V.pipeWho === x[0] ? 'on' : '') + '">' + x[1] + '</button>').join('') + '</nav></div>' +
    '<div class="card" style="margin-bottom:1rem"><h3 class="sec" style="margin:0">Last 30 days — of the people who got in touch</h3><div class="kv">' +
      step('Enquiries', fn.enquiries) + step('Got a range', fn.ranged, fn.enquiries) + step('Said YES', fn.yes, fn.ranged || fn.enquiries) + step('Exact quote sent', fn.quoted, fn.yes) + step('Booked', fn.booked, fn.quoted) + '</div></div>' +
    '<div class="board">' + cols + '</div>' +
    '<div class="secb"><h3>Cooled off · ' + cooled.length + ' <span class="hint" style="font-weight:400;text-transform:none">said no, went quiet or lost in the last 60 days</span></h3>' +
      (cooled.length ? '<button class="btn sm ghost" id="pCool">' + (V.pipeCooled ? 'Hide' : 'Show') + '</button> <span class="hint">The win-back reminder on Campaigns messages these automatically once it\'s switched on.</span>' : '') +
      (V.pipeCooled ? '<div class="cards" style="margin-top:.6rem">' + cooled.slice(0, 60).map(c => '<button class="acc" data-pk="' + esc(c.kind) + '" data-pid="' + esc(c.id) + '"><b>' + esc(c.name) + '</b><small>' + esc(c.what || '—') + '</small><small>' + esc(c.why + ' · ' + dshort(c.since)) + '</small></button>').join('') + '</div>' : '') +
    '</div></div>';
  document.querySelectorAll('[data-pw]').forEach(b => b.onclick = () => { V.pipeWho = b.dataset.pw; paint(); });
  if ($('pCool')) $('pCool').onclick = () => { V.pipeCooled = !V.pipeCooled; paint(); };
  document.querySelectorAll('[data-pk]').forEach(b => b.onclick = () => openCard(b.dataset.pk, b.dataset.pid, P));
}
// What the CRM is doing with a job right now, in one line
function jobLine(c) {
  if (c.kind !== 'job') return '';
  const j = D.active && D.active[c.id];
  if (!j) return '';
  if (c.stage === 'exact') return j.assignedEstimator ? '<small>Being priced by ' + esc(j.assignedEstimator) + '</small>' : '<small style="color:var(--warn)">Waiting for an estimator</small>';
  const a = actFor(j), ch = a.chase;
  const bits = [];
  if (a.quoteSentAt) bits.push('quote sent ' + ago(a.quoteSentAt) + ' ago');
  if (a.queued) bits.push('<b style="color:var(--warn)">' + a.queued + ' not sent</b>');
  if (ch.replied) bits.push('<b style="color:var(--go)">replied</b>');
  else if (ch.active) {
    bits.push('chase ' + ch.done + '/' + ch.total);
    if (ch.next) bits.push((ch.next.overdue ? '<b style="color:var(--stop)">' : '') + 'next: ' + esc(ch.next.label.replace('Day ', 'D')) + ' ' + esc(until(ch.next.dueAt)) + (ch.next.overdue ? '</b>' : ''));
    else bits.push('closes ' + esc(until(ch.closesAt)));
  }
  return bits.length ? '<small>' + bits.join(' · ') + '</small>' : '';
}
// A card opens where the work on it happens
function openCard(kind, id, P) {
  if (kind === 'account') return accSheet(id);
  if (kind === 'lead') { return openInbox(id); }
  if (kind === 'job') return jobSheet(id);
  const c = P.cards.concat(P.cooled).find(x => x.id === id) || {};
  const ct = D.contacts.find(x => (c.phone && x.phones.includes(S.intlPhone(c.phone))) || (c.email && x.emails.includes(S.normEmail(c.email))));
  if (c.lead && LEADS.some(l => l.id === c.lead)) return openInbox(c.lead);
  if (ct) return window.KSalesUI.openCustomer(ct.key);
  window.open('index.html', '_blank');
}

// Everything the CRM knows about one job, every message about it, and the chase
async function jobSheet(id) {
  let j = D.active && D.active[id];
  if (!j) {
    try { const r = await get('jobs?select=id,data&id=eq.' + encodeURIComponent(id)); j = r && r[0] ? Object.assign({ id }, r[0].data) : null; } catch (e) { j = null; }
  }
  if (!j) return window.open('index.html', '_blank');
  const a = actFor(j), ch = a.chase, lead = leadForJob(j);
  const val = parseFloat(j.quote) || parseFloat(j.finalEst) || 0;
  const ph = S.intlPhone(j.phone);
  const ct = D.contacts.find(x => (ph && x.phones.includes(ph)) || (j.email && x.emails.includes(S.normEmail(j.email))));
  const fact = (k, v) => v ? '<dt>' + esc(k) + '</dt><dd>' + v + '</dd>' : '';
  const chaseH = ch.active ? '<div class="box"><h3 class="sec">Chasing them</h3>' +
      '<div class="kv" style="margin:0 0 .6rem">' + [['Quote sent', a.quoteSentAt ? ago(a.quoteSentAt) + ' ago' : '—'], ['Chases done', ch.done + ' of ' + ch.total],
        ['Next', ch.replied ? 'they replied' : ch.next ? until(ch.next.dueAt) : 'all done'], ['Closes off', ch.closesAt ? until(ch.closesAt) : '—']].map(x => '<span>' + esc(x[0]) + '<b>' + esc(x[1]) + '</b></span>').join('') + '</div>' +
      S.CHASE.map((st, i) => {
        const done = i < ch.done, nxt = i === ch.done && !ch.replied;
        const due = ch.since + st.hrs * 3600e3;
        return '<div style="display:flex;gap:.5rem;align-items:baseline;padding:.15rem 0;' + (done ? 'color:var(--ink-3)' : '') + '">' +
          '<span style="width:1.2rem">' + (done ? '✓' : nxt ? (due < Date.now() ? '⚠' : '→') : '·') + '</span>' +
          '<span style="flex:1">' + esc(st.label) + (st.call ? ' <span class="tag">call</span>' : '') + '</span>' +
          '<span class="hint" style="margin:0' + (nxt && due < Date.now() ? ';color:var(--stop)' : '') + '">' + esc(done ? 'done' : until(due)) + '</span></div>';
      }).join('') +
      (ch.next && ch.next.overdue ? '<p class="hint" style="color:var(--stop)">' + esc(ch.next.label) + ' is due — ' + (ch.next.call ? 'someone needs to ring them' : 'send it from the CRM\'s chase list') + '.</p>' : '') + '</div>' : '';
  const bubble = m => '<div class="msg ' + (m.dir === 'in' ? 'in' : 'out') + (m.auto ? ' bot' : '') + (m.status === 'queued' || m.status === 'stuck' ? ' held' : '') + '"' + (m.dir === 'call' ? ' style="align-self:flex-end;background:var(--card-2)"' : '') + '>' +
    '<span class="w"><b>' + esc(m.dir === 'in' ? 'Customer' : m.dir === 'call' ? '📞 Call' : (m.who || 'CRM')) + '</b>' + (m.auto ? ' · automatic' : '') + ' · ' + esc(m.t ? F.fmt(m.t) : '') +
      (m.via ? ' · ' + esc(m.via) : '') + (m.status === 'queued' ? ' · <b style="color:var(--warn)">not sent yet</b>' : m.status === 'stuck' ? ' · <b style="color:var(--stop)">would not send</b>' : '') + '</span><pre>' + esc(m.text) + '</pre></div>';
  sheet('<button class="btn sm x" data-close>Close</button><h2>' + esc(j.name || 'No name') + '</h2>' +
    '<p class="hint">' + (j.reg ? '<span class="plate">' + esc(j.reg) + '</span> ' : '') + esc([j.make, j.model].filter(Boolean).join(' ')) + ' · ' + esc(F.CRM_STAGES[j.stage] || j.stage || '') + '</p>' +
    '<div class="btns" style="margin:.4rem 0 .8rem"><a class="btn sm" href="index.html" target="_blank" rel="noopener">Open in the CRM</a>' +
      (lead ? '<button class="btn sm" id="jLead">Conversation</button>' : '') + (ph ? '<a class="btn sm go" target="_blank" rel="noopener" href="https://wa.me/' + esc(ph) + '">WhatsApp</a>' : '') +
      (ct ? '<button class="btn sm ghost" id="jCust">Customer record</button>' : '') + '</div>' +
    '<div class="box"><dl class="facts">' + fact('Work', esc(j.work || '—')) + fact('Quote', val ? '<b>' + money(val) + '</b> inc VAT' : '') +
      fact('Range they accepted', j.rangeLow ? esc(R.say({ ok: true, low: +j.rangeLow, high: +(j.rangeHigh || j.rangeLow) })) : '') +
      fact('Estimator', esc(j.assignedEstimator || '')) + fact('Signed off', j.signedOffBy ? esc(j.signedOffBy + (j.signedOffAt ? ' · ' + j.signedOffAt : '')) : '') +
      fact('Customer', esc(j.custType || 'Retail')) + fact('Mobile', esc(j.phone || '')) + fact('Email', esc(j.email || '')) + fact('Came from', esc(j.source || '')) +
      fact('In this stage', j.stageAt ? esc(ago(+j.stageAt || S.toTime(j.stageAt))) : '') + '</dl></div>' +
    chaseH +
    '<h3 class="sec" style="margin-top:1rem">Messages · ' + a.messages.length + '</h3><div class="thread">' + (a.messages.length ? a.messages.map(bubble).join('') : '<p class="hint">No messages recorded yet.</p>') + '</div>' +
    '<h3 class="sec" style="margin-top:1rem">CRM history</h3>' + (a.history.length ? a.history.slice(0, 40).map(h => '<div class="hint" style="margin:.15rem 0"><span class="mono">' + esc(h.t ? F.fmt(h.t) : '') + '</span> · ' + esc(h.text) + (h.who ? ' <b>' + esc(h.who) + '</b>' : '') + '</div>').join('') : '<p class="hint">Nothing logged.</p>'));
  if ($('jLead')) $('jLead').onclick = () => { closeSheet(); openInbox(lead.id); };
  if ($('jCust')) $('jCust').onclick = () => { closeSheet(); window.KSalesUI.openCustomer(ct.key); };
}

/* ========================================================== CUSTOMERS === */
function consentDots(c) {
  return '<span class="cons" title="Email · Text · WhatsApp">' + ['email', 'sms', 'whatsapp'].map(ch => {
    const a = S.allowed(c, ch, settings());
    const cls = c.optOut[ch] ? 'n' : a.ok ? 'y' : '';
    return '<i class="' + cls + '" title="' + esc(S.chName(ch) + ': ' + a.why) + '">' + ({ email: 'E', sms: 'T', whatsapp: 'W' })[ch] + '</i>';
  }).join('') + '</span>';
}
function paintCustomers() {
  const now = Date.now();
  const segs = ['customers', 'notBooked', 'motSoon', 'serviceSoon', 'lapsed', 'b2b', 'optedOut', 'all'];
  const cnt = k => D.contacts.filter(c => S.SEGMENTS[k].f(c, now)).length;
  const list = D.contacts.filter(c => S.matches(c, { segment: V.seg, q: V.q }, now))
    .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
  const el = $('view-sales');
  el.innerHTML = '<div class="bar"><nav class="tabs">' + segs.map(k => '<button data-seg="' + k + '" class="' + (V.seg === k ? 'on' : '') + '">' + esc(S.SEGMENTS[k].label) +
      '<span class="c">' + cnt(k) + '</span></button>').join('') + '</nav>' +
    '<div class="filters"><input type="search" id="cq" placeholder="Name, reg, number, company…" value="' + esc(V.q) + '"></div></div>' +
    '<div class="panes' + (V.open ? ' show' : '') + '" id="cpanes"><section class="list" id="clist"></section><section class="detail" id="cdetail"></section></div>';
  el.querySelectorAll('[data-seg]').forEach(b => b.onclick = () => { V.seg = b.dataset.seg; V.shown = 150; paint(); });
  $('cq').oninput = e => { V.q = e.target.value; V.shown = 150; paintCustList(); };
  paintCustList(list);
  paintCustomer();
}
function paintCustList(list) {
  const now = Date.now();
  list = list || D.contacts.filter(c => S.matches(c, { segment: V.seg, q: V.q }, now)).sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
  const el = $('clist'); if (!el) return;
  if (!list.length) { el.innerHTML = '<div class="empty">Nobody here.</div>'; return; }
  el.innerHTML = list.slice(0, V.shown).map(c => {
    const due = c.motDue && c.motDue < now + 45 * DAY && c.motDue > now - 30 * DAY ? '<span class="tag youlite">MOT ' + esc(dshort(c.motDue)) + '</span>' :
      c.serviceDue && c.serviceDue < now + 45 * DAY && c.serviceDue > now - 30 * DAY ? '<span class="tag youlite">Service ' + esc(dshort(c.serviceDue)) + '</span>' : '';
    return '<button class="row' + (V.open === c.key ? ' on' : '') + '" data-ck="' + esc(c.key) + '" style="--c:var(' + (c.isCustomer ? '--go' : c.b2b ? '--blue' : '--muted') + ')">' +
      '<span class="dot"></span><span class="nm">' + esc(c.name || c.company || c.phone || c.email) + (c.company && c.name ? ' <span style="font-weight:400;color:var(--ink-3);font-size:.78rem">' + esc(c.company) + '</span>' : '') + '</span>' +
      '<span class="t">' + (c.isCustomer ? money(c.spent) : c.b2b ? 'B2B' : 'lead') + '</span>' +
      '<span class="snip">' + esc([c.phone && '0' + c.phone.slice(2), c.email].filter(Boolean).join(' · ') || '—') + '</span>' +
      '<span class="meta">' + (c.car ? '<span class="plate">' + esc(c.car.reg) + '</span>' : '') +
        (c.lastVisit ? '<span class="tag">last in ' + esc(dshort(c.lastVisit)) + '</span>' : c.lastSeen ? '<span class="tag">enquired ' + esc(dshort(c.lastSeen)) + '</span>' : '') +
        due + consentDots(c) + '</span></button>';
  }).join('') + (list.length > V.shown ? '<div class="empty"><button class="btn" id="cmore">Show more (' + (list.length - V.shown) + ' left)</button></div>' : '');
  el.querySelectorAll('[data-ck]').forEach(b => b.onclick = () => { V.open = b.dataset.ck; $('cpanes').classList.add('show'); paintCustList(); paintCustomer(); });
  if ($('cmore')) $('cmore').onclick = () => { V.shown += 300; paintCustList(); };
}
function paintCustomer() {
  const el = $('cdetail'); if (!el) return;
  const c = D.contacts.find(x => x.key === V.open);
  if (!c) { el.innerHTML = '<div class="empty">Pick a customer on the left.</div>'; return; }
  const st = settings();
  const cons = ['sms', 'email', 'whatsapp'].map(ch => {
    const a = S.allowed(c, ch, st);
    const addr = ch === 'email' ? c.email : c.phone;
    const btn = !addr ? '' : c.optOut[ch] ? '<button class="btn sm" data-optback="' + ch + '">They asked to opt back in</button>' :
      '<button class="btn sm ghost" data-optout="' + ch + '">Opt out</button>' + (c.optIn[ch] ? '' : ' <button class="btn sm" data-optin="' + ch + '">They said yes</button>');
    return '<tr><td>' + esc(({ sms: 'Text', email: 'Email', whatsapp: 'WhatsApp' })[ch]) + '</td><td>' + (a.ok ? '<span style="color:var(--go)">✓ ' : '<span style="color:var(--ink-3)">✗ ') + esc(a.why) + '</span></td><td>' + btn + '</td></tr>';
  }).join('');
  const jobs = c.jobs.map(j => '<tr><td>' + esc(dshort(j.at)) + '</td><td>' + esc(j.work || '—') + (j.reg ? ' <span class="plate">' + esc(j.reg) + '</span>' : '') + '</td><td>' + (j.quote ? money(j.quote) : '') + '</td><td>' + esc(F.CRM_STAGES[j.stage] || j.stage || '') + '</td></tr>').join('');
  const leads = c.leads.map(l => '<tr class="click" data-lead="' + esc(l.id) + '"><td>' + esc(dshort(l.at)) + '</td><td>' + esc((F.SOURCES[l.source] || {}).label || l.source) + '</td><td>' + esc(l.jobId ? 'became a job' : l.closed ? (l.closedWhy || 'closed') : 'open') + '</td></tr>').join('');
  const sends = c.sends.slice().sort((a, b) => (b.sentAt || b.sendAt || 0) - (a.sentAt || a.sendAt || 0)).map(s => '<tr><td>' + esc(dshort(s.sentAt || s.sendAt)) + '</td><td>' + esc(s.campaignName || s.campaign) + (s.step ? ' (follow-up)' : '') + '</td><td>' + esc(S.chName(s.channel)) + '</td><td>' + esc(s.status + (s.replyAt ? ' · replied' : '') + (s.why ? ' · ' + s.why : '')) + '</td></tr>').join('');
  el.innerHTML = '<button class="back" id="cback">← All customers</button>' +
    '<div class="dh"><div><h2>' + esc(c.name || c.company || 'No name') + '</h2><div class="sub">' + esc([c.company, c.phone && '0' + c.phone.slice(2), c.email].filter(Boolean).join(' · ')) +
      ' · ' + esc(c.sources.join(', ')) + '</div></div><div class="acts">' +
      (c.phone ? '<a class="btn sm go" target="_blank" rel="noopener" href="https://wa.me/' + esc(c.phone) + '">WhatsApp</a>' : '') +
      (c.email ? '<a class="btn sm" href="mailto:' + esc(c.email) + '">Email</a>' : '') + '</div></div>' +
    '<div class="kv" style="margin:.8rem 0 1rem">' + [['Visits', c.visits], ['Spent', money(c.spent)], ['Last in', dshort(c.lastVisit)], ['MOT due', c.motDue ? dshort(c.motDue) : '—'], ['Service due', c.serviceDue ? dshort(c.serviceDue) : '—']]
      .map(x => '<span>' + esc(x[0]) + '<b>' + esc(x[1]) + '</b></span>').join('') + '</div>' +
    '<div class="grid2"><div>' +
      '<h3 class="sec">Jobs</h3>' + (jobs ? '<div class="tw"><table class="t"><tr><th>When</th><th>Work</th><th>£</th><th>Stage</th></tr>' + jobs + '</table></div>' : '<p class="hint">No CRM jobs.</p>') +
      '<h3 class="sec" style="margin-top:1rem">Enquiries</h3>' + (leads ? '<div class="tw"><table class="t"><tr><th>When</th><th>From</th><th>What happened</th></tr>' + leads + '</table></div>' : '<p class="hint">None in the inbox.</p>') +
      '<h3 class="sec" style="margin-top:1rem">Messages we\'ve sent</h3>' + (sends ? '<div class="tw"><table class="t"><tr><th>When</th><th>Campaign</th><th>On</th><th>What happened</th></tr>' + sends + '</table></div>' : '<p class="hint">No campaign messages yet.</p>') +
    '</div><div>' +
      '<div class="box"><h3 class="sec">May we market to them?</h3><table class="t">' + cons + '</table>' +
      '<p class="hint">"They said yes" is recorded with your name and the date. Only press it if they did.</p></div>' +
      (c.cars.length ? '<div class="box"><h3 class="sec">Cars</h3>' + c.cars.map(x => '<div style="margin:.2rem 0"><span class="plate">' + esc(x.reg) + '</span> ' + esc([x.make, x.model].filter(Boolean).join(' ')) + '</div>').join('') + '</div>' : '') +
    '</div></div>';
  $('cback').onclick = () => { V.open = null; $('cpanes').classList.remove('show'); paintCustList(); };
  el.querySelectorAll('[data-lead]').forEach(r => r.onclick = () => openInbox(r.dataset.lead));
  el.querySelectorAll('[data-optin]').forEach(b => b.onclick = () => pref(c, b.dataset.optin, 'optin'));
  el.querySelectorAll('[data-optout]').forEach(b => b.onclick = () => pref(c, b.dataset.optout, 'optout'));
  el.querySelectorAll('[data-optback]').forEach(b => b.onclick = () => pref(c, b.dataset.optback, 'optback'));
}
// Record a yes, an opt-out, or an opt back in — against the address, so it
// follows the person whichever job or enquiry they turn up through
async function pref(c, ch, what) {
  const addr = ch === 'email' ? c.email : c.phone;
  const q = { optin: 'Record that ' + (c.firstName || 'they') + ' said YES to marketing by ' + S.chName(ch) + '?\n\nOnly if they actually said so — it\'s saved with your name and today\'s date.',
    optout: 'Opt ' + (c.firstName || 'them') + ' out of marketing by ' + S.chName(ch) + '?', optback: 'Did ' + (c.firstName || 'they') + ' ask to get ' + S.chName(ch) + ' again? It\'s saved with your name.' }[what];
  if (!confirm(q)) return;
  const isE = ch === 'email';
  try {
    if (what === 'optin') {
      await saveRow('I' + S.hash(addr), cur => { const d = cur || { type: 'optin', phone: isE ? '' : addr, email: isE ? addr : '', channels: [] };
        if (d.channels.indexOf(ch) < 0) d.channels.push(ch); return Object.assign(d, { at: Date.now(), by: ME }); });
    } else {
      await saveRow('O' + S.hash(addr), cur => { const d = cur || { type: 'optout', phone: isE ? '' : addr, email: isE ? addr : '', channels: [] };
        d.channels = (d.channels || []).filter(x => x !== ch); if (what === 'optout') d.channels.push(ch);
        return Object.assign(d, { at: Date.now(), by: ME, why: what === 'optout' ? 'Set by ' + ME : 'Opted back in, told ' + ME }); });
    }
    await loadSales(true); paint(); toast('✓ Saved');
  } catch (e) { toast('⚠ ' + e.message, 6000); }
}

/* ========================================================== CAMPAIGNS === */
function senderCard() {
  const r = D.run, st = settings(), caps = Object.assign({}, S.DEFAULTS.caps, st.caps || {});
  const alive = r && Date.now() - r.at < 25 * 60e3;
  const sent = (r && r.sentToday) || {};
  return '<div class="card" style="border-color:' + (alive ? 'var(--go)' : 'var(--stop)') + '"><h3>' + (alive ? 'Sender is running' : r ? 'Sender has stopped' : 'Sender not set up yet') + '</h3>' +
    '<p class="hint">' + (r ? 'Last ran ' + esc(ago(r.at)) + ' ago' + (r.last && r.last.error ? ' — error: ' + esc(r.last.error) : '') : 'Add kith-sales.gs to the feeds script and run setup() — see the setup notes.') + '</p>' +
    '<div class="kv">' + ['sms', 'email', 'whatsapp'].map(ch => '<span>' + esc(({ sms: 'Texts', email: 'Emails', whatsapp: 'WhatsApps' })[ch]) + ' today<b>' + (sent[ch] || 0) + ' / ' + caps[ch] + '</b></span>').join('') + '</div>' +
    '<div class="row2" style="margin:.6rem 0 0"><label class="sw"><input type="checkbox" id="pauseAll"' + (D.cfg.paused ? ' checked' : '') + (isBoss() ? '' : ' disabled') + '> Pause everything</label>' +
    (isBoss() ? '<button class="btn sm ghost" id="salesSettings">Rules &amp; limits</button>' : '') + '</div></div>';
}
function paintCampaigns() {
  const now = Date.now(), st = settings(), autos = D.cfg.automations || {};
  const autoCards = Object.keys(S.AUTOMATIONS).map(k => {
    const camp = S.autoCampaign(k, autos[k]);
    const due = D.contacts.filter(c => S.AUTOMATIONS[k].due(c, now) && S.pickChannel(c, camp.channels, st, camp).channel).length;
    const r = S.results(camp.id, D.sends, D.contacts);
    return '<div class="card' + (camp.on ? '' : ' off') + '"><div class="row2" style="justify-content:space-between;margin:0"><h3>' + esc(camp.name) + '</h3>' +
      '<label class="sw"><input type="checkbox" data-auto="' + k + '"' + (camp.on ? ' checked' : '') + (isBoss() ? '' : ' disabled') + '>' + (camp.on ? 'On' : 'Off') + '</label></div>' +
      '<p class="hint">' + esc(S.AUTOMATIONS[k].when) + '</p>' +
      '<div class="kv"><span>Due now<b>' + due + '</b></span><span>Sent<b>' + r.sent + '</b></span><span>Replied<b>' + r.replied + '</b></span><span>Booked<b>' + r.booked + '</b></span>' + (r.revenue ? '<span>Won<b>' + money(r.revenue) + '</b></span>' : '') + '</div>' +
      '<div class="btns"><button class="btn sm" data-editauto="' + k + '">Messages</button></div></div>';
  }).join('');
  const rows = D.campaigns.map(c => {
    const r = S.results(c.id, D.sends, D.contacts);
    const stuck = D.sends.filter(s => s.campaign === c.id && s.status === 'sending' && now - (s.claimedAt || 0) > 30 * 60e3).length;
    return '<tr class="click" data-camp="' + esc(c.id) + '"><td><b>' + esc(c.name) + '</b><div class="hint">' + esc((c.createdBy || '') + ' · ' + dshort(c.createdAt)) + '</div></td>' +
      '<td>' + esc(c.status === 'live' && !r.queued && r.sent ? 'Done' : ({ draft: 'Draft', live: 'Sending', paused: 'Paused', cancelled: 'Cancelled', done: 'Done' })[c.status] || c.status) + (stuck ? ' <span style="color:var(--stop)">· ' + stuck + ' to check</span>' : '') + '</td>' +
      '<td class="mono">' + (c.audienceCount || '—') + '</td><td class="mono">' + r.sent + (r.queued ? ' <span class="hint">+' + r.queued + ' to go</span>' : '') + '</td><td class="mono">' + r.replied + '</td><td class="mono">' + r.booked + '</td><td class="mono">' + (r.revenue ? money(r.revenue) : '') + '</td><td class="mono">' + (r.optedOut || '') + '</td></tr>';
  }).join('');
  $('view-sales').innerHTML = '<div class="sv"><div class="row2" style="justify-content:space-between"><div><h2>Campaigns</h2><p class="lede">Reminders that run themselves, and one-off campaigns to past customers, people who didn\'t book, and B2B lists. Replies land in the Inbox.</p></div>' +
    '<button class="btn primary" id="newCamp">+ New campaign</button></div>' +
    '<div class="cards">' + senderCard() + '</div>' +
    '<h3 class="sec">Automatic — checked every morning</h3><div class="cards">' + autoCards + '</div>' +
    '<h3 class="sec">Campaigns</h3>' + (rows ? '<div class="tw"><table class="t"><tr><th>Campaign</th><th>Status</th><th>Audience</th><th>Sent</th><th>Replied</th><th>Booked</th><th>Won</th><th>Opted out</th></tr>' + rows + '</table></div>' :
      '<div class="empty">No campaigns yet. Start one — a winter check to past customers is a good first.</div>') + '</div>';
  $('newCamp').onclick = () => builder();
  if ($('pauseAll')) $('pauseAll').onchange = async e => { try { await saveCfg(c => Object.assign(c, { paused: e.target.checked, pausedBy: ME, pausedAt: Date.now() })); toast(e.target.checked ? 'Everything paused' : 'Sending again'); paint(); } catch (x) { toast('⚠ ' + x.message, 6000); } };
  if ($('salesSettings')) $('salesSettings').onclick = rulesSheet;
  document.querySelectorAll('[data-auto]').forEach(b => b.onchange = () => toggleAuto(b.dataset.auto, b.checked));
  document.querySelectorAll('[data-editauto]').forEach(b => b.onclick = () => autoSheet(b.dataset.editauto));
  document.querySelectorAll('[data-camp]').forEach(r => r.onclick = () => campSheet(r.dataset.camp));
}
async function toggleAuto(k, on) {
  const camp = S.autoCampaign(k, (D.cfg.automations || {})[k]);
  if (on) {
    const due = D.contacts.filter(c => S.AUTOMATIONS[k].due(c, Date.now()) && S.pickChannel(c, camp.channels, settings(), camp).channel).length;
    if (!confirm('Switch on "' + camp.name + '"?\n\n' + due + ' customer' + (due === 1 ? ' is' : 's are') + ' due right now and will get it from tomorrow morning (one message per person per week at most). Check the messages first.')) { paint(); return; }
  }
  try { await saveCfg(c => { c.automations = c.automations || {}; c.automations[k] = Object.assign({}, c.automations[k] || {}, { on, by: ME, at: Date.now() }); return c; }); toast(on ? '✓ On' : 'Off'); paint(); }
  catch (e) { toast('⚠ ' + e.message, 6000); paint(); }
}
// Message editors (the same for automations and the campaign builder)
function msgEditor(prefix, msg, opts) {
  msg = msg || {}; opts = opts || {};
  const sms = (msg.sms || {}).body || '', em = msg.email || {}, wa = msg.whatsapp || {};
  return '<div class="f" style="margin-bottom:.5rem"><label for="' + prefix + 'Sms">Text message <span class="cnt" id="' + prefix + 'SmsN"></span></label><textarea id="' + prefix + 'Sms" data-fld>' + esc(sms) + '</textarea></div>' +
    '<div class="f" style="margin-bottom:.3rem"><label for="' + prefix + 'Subj">Email subject</label><input id="' + prefix + 'Subj" data-fld value="' + esc(em.subject || '') + '"></div>' +
    '<div class="f" style="margin-bottom:.5rem"><label for="' + prefix + 'Em">Email</label><textarea id="' + prefix + 'Em" data-fld style="min-height:7rem">' + esc(em.body || '') + '</textarea></div>' +
    '<div class="frow"><div class="f"><label for="' + prefix + 'Wa">WhatsApp template (approved by Meta)</label><input id="' + prefix + 'Wa" value="' + esc(wa.template || '') + '" placeholder="e.g. kith_mot_reminder"></div>' +
    '<div class="f"><label for="' + prefix + 'WaP">Its {{1}}, {{2}}… in order</label><input id="' + prefix + 'WaP" value="' + esc((wa.params || []).join(', ')) + '" placeholder="first_name, reg"></div></div>' +
    '<div class="hint">Insert: <span class="chips2">' + S.FIELD_LIST.map(f => '<button type="button" data-ins="' + f + '">{' + f + '}</button>').join('') + '</span></div>' +
    '<p class="hint">Texts get "' + esc(S.footer('sms').trim()) + '" added. Emails get our company details and an unsubscribe line. Leave a channel blank to not use it.</p>';
}
function readMsg(prefix) {
  const v = id => ($(prefix + id) || {}).value || '';
  return { sms: { body: v('Sms').trim() }, email: { subject: v('Subj').trim(), body: v('Em').trim() },
    whatsapp: { template: v('Wa').trim(), params: v('WaP').split(',').map(x => x.trim()).filter(Boolean) } };
}
let LASTFLD = null;
function wireEditor(onChange) {
  document.querySelectorAll('[data-fld]').forEach(x => { x.addEventListener('focus', () => { LASTFLD = x; }); x.addEventListener('input', onChange); });
  document.querySelectorAll('[data-ins]').forEach(b => b.onclick = () => {
    const x = LASTFLD || document.querySelector('[data-fld]'); if (!x) return;
    const t = '{' + b.dataset.ins + '}', p = x.selectionStart == null ? x.value.length : x.selectionStart;
    x.value = x.value.slice(0, p) + t + x.value.slice(x.selectionEnd == null ? p : x.selectionEnd); x.focus(); x.selectionStart = x.selectionEnd = p + t.length; onChange();
  });
  document.querySelectorAll('[id$="Wa"],[id$="WaP"]').forEach(x => x.addEventListener('input', onChange));
}
function smsCount(prefix) {
  const el = $(prefix + 'SmsN'); if (!el) return;
  const t = ($(prefix + 'Sms').value || '') + S.footer('sms');
  const parts = S.smsParts(t.replace(/\{\w+\}/g, 'xxxxxxxxx'));
  const odd = [...new Set((t.match(/[^\x0A\x0D\x20-\x7E£€]/g) || []))];
  el.textContent = '≈' + t.length + ' characters · ' + parts + ' text' + (parts === 1 ? '' : 's') + ' each' +
    (odd.length ? ' · ' + odd.join(' ') + ' makes each text shorter (70 not 160) — swap ' + (odd.length === 1 ? 'it' : 'them') + ' for plain characters' : '');
  el.className = 'cnt' + (parts > 1 ? ' over' : '');
}
function autoSheet(k) {
  const camp = S.autoCampaign(k, (D.cfg.automations || {})[k]);
  const sample = D.contacts.find(c => S.AUTOMATIONS[k].due(c, Date.now())) || D.contacts.find(c => c.isCustomer) || D.contacts[0];
  sheet('<button class="btn sm x" data-close>Close</button><h2>' + esc(camp.name) + '</h2><p class="hint">' + esc(S.AUTOMATIONS[k].when) + '</p>' +
    '<div class="f" style="margin:.6rem 0"><label for="aCh">Try in this order</label>' + chanSelect('aCh', camp.channels) + '</div>' +
    msgEditor('a', camp.msg) + '<div id="aPrev"></div>' +
    (isBoss() ? '<button class="btn primary" id="aGo">Save</button>' : '<p class="hint">Only the director can change these.</p>'));
  const prev = () => { smsCount('a'); $('aPrev').innerHTML = previewH(Object.assign({}, camp, { msg: readMsg('a') }), sample); };
  wireEditor(prev); prev();
  if ($('aGo')) $('aGo').onclick = async () => {
    const msg = readMsg('a');
    const bad = [msg.sms.body, msg.email.subject, msg.email.body].map(S.badFields).reduce((a, b) => a.concat(b), []).concat(msg.whatsapp.params.filter(p => !S.FIELDS[p]));
    if (bad.length) return toast('Unknown field: {' + bad[0] + '}', 6000);
    try { await saveCfg(c => { c.automations = c.automations || {}; c.automations[k] = Object.assign({}, c.automations[k] || {}, { msg, channels: chanRead('aCh'), by: ME, at: Date.now() }); return c; }); closeSheet(); show('campaigns'); toast('✓ Saved'); }
    catch (e) { toast('⚠ ' + e.message, 6000); }
  };
}
const ORDERS = { 'whatsapp,sms,email': 'WhatsApp → text → email', 'sms,email': 'Text → email', 'email,sms': 'Email → text', 'email': 'Email only', 'sms': 'Text only', 'whatsapp': 'WhatsApp only', 'whatsapp,email': 'WhatsApp → email' };
function chanSelect(id, cur) {
  const k = (cur || ['whatsapp', 'sms', 'email']).join(',');
  return '<select id="' + id + '">' + Object.keys(ORDERS).map(o => '<option value="' + o + '"' + (o === k ? ' selected' : '') + '>' + ORDERS[o] + '</option>').join('') + '</select>';
}
const chanRead = id => ($(id).value || 'sms,email').split(',');
function previewH(camp, c) {
  if (!c) return '';
  const st = settings();
  return '<h3 class="sec" style="margin-top:.8rem">Preview — ' + esc(c.name || c.email || c.phone) + '</h3>' + ['sms', 'email', 'whatsapp'].filter(ch => S.hasMessage(camp, ch)).map(ch => {
    const r = S.render(camp, 0, c, ch, st);
    return '<div class="hint">' + esc(S.chName(ch)) + (r.subject ? ' · ' + esc(r.subject) : '') + '</div><div class="prev">' + esc(r.text) + '</div>';
  }).join('');
}

/* ---- the campaign builder ---- */
function builder(existing) {
  const c0 = existing || { id: 'C' + Date.now().toString(36), type: 'campaign', name: '', status: 'draft', channels: ['sms', 'email'], audience: { segment: 'customers', noB2B: true },
    msg: { sms: { body: '' }, email: { subject: '', body: '' }, whatsapp: { template: '', params: ['first_name'] } }, followUps: [] };
  const a = c0.audience || {};
  const fu = (c0.followUps || [])[0];
  const kinds = R.KINDS.filter(k => k.source !== 'person' || k.k === 'tyres' || k.k === 'bodywork');
  const segOpts = ['customers', 'notBooked', 'motSoon', 'serviceSoon', 'lapsed', 'b2b', 'all'];
  sheet('<button class="btn sm x" data-close>Close</button><h2>' + (existing ? 'Edit campaign' : 'New campaign') + '</h2>' +
    '<div class="f" style="margin-bottom:.6rem"><label for="bName">Name (only you see it)</label><input id="bName" value="' + esc(c0.name) + '" placeholder="e.g. Winter check October"></div>' +
    '<div class="secb"><h3>Who</h3><div class="frow">' +
      '<div class="f"><label for="bSeg">Group</label><select id="bSeg">' + segOpts.map(k => '<option value="' + k + '"' + (a.segment === k ? ' selected' : '') + '>' + esc(S.SEGMENTS[k].label) + '</option>').join('') + '</select></div>' +
      '<div class="f"><label for="bKind">Who\'ve had this work</label><select id="bKind"><option value="">Any work</option>' + kinds.map(k => '<option value="' + k.k + '"' + (a.kind === k.k ? ' selected' : '') + '>' + esc(k.label) + '</option>').join('') + '</select></div>' +
      '<div class="f"><label for="bMake">Make</label><input id="bMake" value="' + esc(a.make || '') + '" placeholder="any"></div></div>' +
    '<div class="frow"><div class="f"><label for="bFrom">Last in after</label><input type="date" id="bFrom" value="' + esc(a.visitedFrom || '') + '"></div>' +
      '<div class="f"><label for="bTo">Last in before</label><input type="date" id="bTo" value="' + esc(a.visitedTo || '') + '"></div>' +
      '<div class="f"><label for="bStage">B2B stage</label><select id="bStage"><option value="">Any</option>' + S.B2B_STAGES.map(s => '<option value="' + s.k + '"' + (a.b2bStage === s.k ? ' selected' : '') + '>' + esc(s.label) + '</option>').join('') + '</select></div></div>' +
    '<label class="ck"><input type="checkbox" id="bNoB2b"' + (a.noB2B ? ' checked' : '') + '> Leave out B2B / fleet customers</label>' +
    (a.accounts && a.accounts.length ? '<p class="hint">Only ' + a.accounts.length + ' chosen compan' + (a.accounts.length === 1 ? 'y' : 'ies') + ' from the B2B board.</p>' : '') +
    '</div><div class="secb"><h3>How</h3><div class="f" style="margin-bottom:.6rem"><label for="bCh">Each person gets ONE message, on the first of these they can get</label>' + chanSelect('bCh', c0.channels) + '</div>' +
      msgEditor('b', c0.msg) + '</div>' +
    '<div class="secb"><h3>Follow-up</h3><label class="ck"><input type="checkbox" id="bFu"' + (fu ? ' checked' : '') + '> If they don\'t reply, send one more after <input id="bFuDays" type="number" min="1" max="30" value="' + esc(fu ? fu.afterDays : 3) + '" style="width:3.5rem;background:var(--bg);border:1px solid var(--line);border-radius:4px;padding:.1rem .3rem"> days</label>' +
      '<div id="bFuBox"' + (fu ? '' : ' hidden') + '>' + msgEditor('f', fu ? fu.msg : { sms: { body: 'Hi {first_name}, just checking you saw our message about {reg} — reply here if you\'d like it booked in.' }, email: { subject: 'Re: ' + (c0.msg.email.subject || ''), body: '' } }) + '</div></div>' +
    '<div class="secb"><h3>When</h3><label class="ck"><input type="radio" name="bWhen" value="now"' + (c0.sendAt ? '' : ' checked') + '> As soon as possible (inside sending hours)</label>' +
      '<label class="ck"><input type="radio" name="bWhen" value="at"' + (c0.sendAt ? ' checked' : '') + '> From <input type="datetime-local" id="bAt" value="' + esc(c0.sendAt ? new Date(c0.sendAt - new Date().getTimezoneOffset() * 60e3).toISOString().slice(0, 16) : '') + '" style="background:var(--bg);border:1px solid var(--line);border-radius:4px;padding:.15rem .3rem"></label></div>' +
    '<div id="bSum"></div><div id="bPrev"></div>' +
    '<div class="btns" style="position:sticky;bottom:0;background:var(--bg-2);padding:.6rem 0;margin-top:1rem;border-top:1px solid var(--line)">' +
      (isBoss() ? '<button class="btn primary" id="bLaunch">Launch</button>' : '') + '<button class="btn" id="bSave">Save draft</button>' +
      (isBoss() ? '' : '<span class="hint">Only the director can launch — save it and ask Logan.</span>') + '</div>');
  const read = () => {
    const camp = clone(c0);
    camp.name = $('bName').value.trim();
    camp.audience = { segment: $('bSeg').value, kind: $('bKind').value, make: $('bMake').value.trim(), visitedFrom: $('bFrom').value, visitedTo: $('bTo').value,
      b2bStage: $('bStage').value, noB2B: $('bNoB2b').checked, accounts: a.accounts || null };
    camp.channels = chanRead('bCh');
    camp.msg = readMsg('b');
    camp.followUps = $('bFu').checked ? [{ afterDays: Math.max(1, +$('bFuDays').value || 3), msg: readMsg('f') }] : [];
    const when = document.querySelector('[name="bWhen"]:checked').value;
    camp.sendAt = when === 'at' && $('bAt').value ? new Date($('bAt').value).getTime() : 0;
    return camp;
  };
  let tmr = null;
  const update = () => { clearTimeout(tmr); tmr = setTimeout(() => {
    smsCount('b'); smsCount('f');
    const camp = read(), au = S.audience(D.contacts, camp, settings(), Date.now());
    const st = settings(), caps = Object.assign({}, S.DEFAULTS.caps, st.caps || {});
    const days = ch => Math.ceil(au.byChannel[ch] / Math.max(1, caps[ch] || 1));
    const smsCost = au.byChannel.sms ? au.reach.filter(x => x.channel === 'sms').reduce((s, x) => s + S.smsParts(S.render(camp, 0, x.c, 'sms', st).text), 0) * (+st.smsPence || 4) / 100 : 0;
    const bad = [camp.msg.sms.body, camp.msg.email.subject, camp.msg.email.body].concat(camp.followUps.length ? [camp.followUps[0].msg.sms.body, camp.followUps[0].msg.email.body] : [])
      .map(S.badFields).reduce((x, y) => x.concat(y), []).concat(camp.msg.whatsapp.params.filter(p => !S.FIELDS[p]));
    const warn = [];
    if (bad.length) warn.push('Unknown field {' + bad[0] + '} — fix it before launching');
    if (camp.channels.includes('whatsapp') && !camp.msg.whatsapp.template) warn.push('No WhatsApp template, so nobody gets WhatsApp — they get the next channel instead');
    if (camp.channels.includes('sms') && camp.msg.sms.body && !(D.run && D.run.sms)) warn.push('Texts aren\'t set up on the sender yet (Twilio) — texts will fail');
    $('bSum').innerHTML = '<div class="sum"><div class="big">' + au.reach.length + ' people</div>' +
      '<div class="hint" style="color:var(--ink)">' + ['whatsapp', 'sms', 'email'].filter(ch => au.byChannel[ch]).map(ch => au.byChannel[ch] + ' by ' + S.chName(ch) + (days(ch) > 1 ? ' (over ' + days(ch) + ' days at ' + caps[ch] + '/day)' : '')).join(' · ') + '</div>' +
      (smsCost ? '<div class="hint">Texts cost about £' + smsCost.toFixed(2) + '</div>' : '') +
      (au.skipped.length ? '<div class="hint">' + au.skipped.length + ' left out: ' + Object.keys(au.reasons).map(k => au.reasons[k] + ' ' + k.toLowerCase()).join(', ') + '</div>' : '') +
      warn.map(w => '<div class="hint" style="color:var(--warn)">⚠ ' + esc(w) + '</div>').join('') + '</div>';
    $('bPrev').innerHTML = previewH(camp, (au.reach[0] || {}).c);
    $('bSum').dataset.n = au.reach.length; $('bSum').dataset.bad = bad.length;
  }, 150); };
  wireEditor(update);
  ['bName', 'bSeg', 'bKind', 'bMake', 'bFrom', 'bTo', 'bStage', 'bNoB2b', 'bCh', 'bFu', 'bFuDays', 'bAt'].forEach(id => { $(id).addEventListener('input', update); $(id).addEventListener('change', update); });
  document.querySelectorAll('[name="bWhen"]').forEach(x => x.onchange = update);
  $('bFu').addEventListener('change', () => { $('bFuBox').hidden = !$('bFu').checked; });
  update();
  $('bSave').onclick = async () => {
    const camp = read(); if (!camp.name) return toast('Give it a name');
    try { await saveRow(camp.id, cur => Object.assign(cur || {}, camp, { status: cur && cur.status !== 'draft' ? cur.status : 'draft', createdBy: (cur && cur.createdBy) || ME, createdAt: (cur && cur.createdAt) || Date.now() }));
      closeSheet(); await loadSales(true); show('campaigns'); toast('✓ Draft saved'); }
    catch (e) { toast('⚠ ' + e.message, 6000); }
  };
  if ($('bLaunch')) $('bLaunch').onclick = () => launch(read());
}
async function launch(camp) {
  if (!camp.name) return toast('Give it a name');
  const st = settings();
  const fm = (camp.followUps[0] || {}).msg || {};
  const bad = [camp.msg.sms.body, camp.msg.email.subject, camp.msg.email.body, (fm.sms || {}).body, (fm.email || {}).subject, (fm.email || {}).body]
    .map(S.badFields).reduce((x, y) => x.concat(y), []).concat((camp.msg.whatsapp.params || []).filter(p => !S.FIELDS[p]));
  if (bad.length) return toast('Unknown field {' + bad[0] + '}', 6000);
  if (!['sms', 'email', 'whatsapp'].some(ch => S.hasMessage(camp, ch))) return toast('Write at least one message');
  const p = S.plan(D.contacts, camp, st, Date.now());
  if (!p.sends.length) return toast('Nobody to send to');
  const by = ['whatsapp', 'sms', 'email'].filter(ch => p.audience.byChannel[ch]).map(ch => p.audience.byChannel[ch] + ' by ' + S.chName(ch)).join(', ');
  if (!confirm('Launch "' + camp.name + '"?\n\n' + p.sends.length + ' people: ' + by + '.\n' + (camp.followUps.length ? 'Anyone who doesn\'t reply gets one follow-up after ' + camp.followUps[0].afterDays + ' days.\n' : '') +
    '\nIt goes out from ' + new Date(p.sends[0].sendAt).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) + ', inside sending hours, a few at a time.')) return;
  try {
    await saveRow(camp.id, cur => Object.assign(cur || {}, camp, { status: 'live', launchedBy: ME, launchedAt: Date.now(), audienceCount: p.sends.length,
      createdBy: (cur && cur.createdBy) || ME, createdAt: (cur && cur.createdAt) || Date.now() }));
    await insertSends(p.sends);
    closeSheet(); await loadSales(true); show('campaigns'); toast('✓ Launched — ' + p.sends.length + ' queued', 5000);
  } catch (e) { toast('⚠ ' + e.message, 6000); }
}
function campSheet(id) {
  const c = D.campaigns.find(x => x.id === id); if (!c) return;
  if (c.status === 'draft') return builder(c);
  const r = S.results(id, D.sends, D.contacts);
  const mine = D.sends.filter(s => s.campaign === id).sort((a, b) => (b.sentAt || b.sendAt || 0) - (a.sentAt || a.sendAt || 0));
  const stuck = mine.filter(s => s.status === 'sending' && Date.now() - (s.claimedAt || 0) > 30 * 60e3);
  sheet('<button class="btn sm x" data-close>Close</button><h2>' + esc(c.name) + '</h2><p class="hint">Launched by ' + esc(c.launchedBy || c.createdBy || '') + ' · ' + esc(dshort(c.launchedAt || c.createdAt)) + '</p>' +
    '<div class="kv">' + [['Sent', r.sent], ['To go', r.queued], ['Replied', r.replied], ['Booked', r.booked], ['Won', money(r.revenue)], ['Opted out', r.optedOut], ['Skipped', r.skipped], ['Failed', r.failed]].map(x => '<span>' + x[0] + '<b>' + x[1] + '</b></span>').join('') + '</div>' +
    (stuck.length ? '<div class="note stop"><b>' + stuck.length + ' message' + (stuck.length === 1 ? '' : 's') + ' to check</b>The sender stopped part-way through these, so it won\'t send them again. Check on the customer\'s phone/email whether they arrived.</div>' : '') +
    (isBoss() && (c.status === 'live' || c.status === 'paused') ? '<div class="btns">' + (c.status === 'live' ? '<button class="btn" id="cPause">Pause</button>' : '<button class="btn primary" id="cResume">Resume</button>') + '<button class="btn stop" id="cCancel">Cancel what\'s left</button></div>' : '') +
    '<h3 class="sec" style="margin-top:1rem">Who</h3><div class="tw"><table class="t"><tr><th>Who</th><th>On</th><th>When</th><th>What happened</th></tr>' +
    mine.slice(0, 400).map(s => '<tr><td>' + esc(s.name || s.to) + (s.step ? ' <span class="hint">follow-up</span>' : '') + '</td><td>' + esc(S.chName(s.channel)) + '</td><td>' + esc(dshort(s.sentAt || s.sendAt)) + '</td><td>' +
      esc(s.status === 'queued' ? 'to go' : s.status) + (s.replyAt ? ' · <b style="color:var(--go)">replied</b>' : '') + (s.why ? ' · ' + esc(s.why) : '') + (s.error ? ' · ' + esc(s.error) : '') + '</td></tr>').join('') + '</table></div>');
  const setStatus = async (status, msg) => { try { await saveRow(id, cur => Object.assign(cur, { status, [status + 'By']: ME, [status + 'At']: Date.now() })); closeSheet(); await loadSales(true); show('campaigns'); toast(msg); } catch (e) { toast('⚠ ' + e.message, 6000); } };
  if ($('cPause')) $('cPause').onclick = () => setStatus('paused', 'Paused — nothing more goes until you resume');
  if ($('cResume')) $('cResume').onclick = () => setStatus('live', 'Sending again');
  if ($('cCancel')) $('cCancel').onclick = () => { if (confirm('Cancel everything this campaign hasn\'t sent yet? Can\'t be undone.')) setStatus('cancelled', 'Cancelled'); };
}
function rulesSheet() {
  const st = settings(), caps = Object.assign({}, S.DEFAULTS.caps, st.caps || {});
  sheet('<button class="btn sm x" data-close>Close</button><h2>Rules &amp; limits</h2>' +
    '<label class="ck"><input type="checkbox" id="rSoft"' + (st.softOptIn !== false ? ' checked' : '') + '> Past customers and people who asked us for a price can get emails and texts (UK "soft opt-in") — every one carries an opt-out</label>' +
    '<label class="ck" style="margin-top:.4rem"><input type="checkbox" id="rWa"' + (st.waCountsMessaged ? ' checked' : '') + '> Past customers who have messaged us on WhatsApp count as a yes to WhatsApp marketing</label>' +
    '<p class="hint">Meta\'s rule is that WhatsApp marketing needs a clear yes. Leaving the second box off is the safe choice — a WhatsApp number can be restricted if too many people block it.</p>' +
    '<div class="frow"><div class="f"><label for="rGap">Days between marketing messages to one person</label><input id="rGap" type="number" min="1" value="' + esc(st.perPersonDays || S.DEFAULTS.perPersonDays) + '"></div>' +
      '<div class="f"><label for="rPence">Pence per text (for the cost estimate)</label><input id="rPence" type="number" step="0.1" value="' + esc(st.smsPence || 4) + '"></div></div>' +
    '<div class="frow"><div class="f"><label for="rEm">Emails a day</label><input id="rEm" type="number" value="' + caps.email + '"></div><div class="f"><label for="rSms">Texts a day</label><input id="rSms" type="number" value="' + caps.sms + '"></div><div class="f"><label for="rWaC">WhatsApps a day</label><input id="rWaC" type="number" value="' + caps.whatsapp + '"></div></div>' +
    '<p class="hint">A normal Gmail account can send 100 emails a day from a script; Google Workspace allows 1,500. A new WhatsApp business number starts at 250 conversations a day.</p>' +
    '<div class="f" style="margin-bottom:.6rem"><label for="rRev">Google review link</label><input id="rRev" value="' + esc(st.reviewLink) + '"></div>' +
    '<button class="btn primary" id="rGo">Save</button>');
  $('rGo').onclick = async () => {
    const n = (id, d) => { const v = parseFloat($(id).value); return v > 0 ? v : d; };
    try { await saveCfg(c => { c.settings = Object.assign({}, c.settings || {}, { softOptIn: $('rSoft').checked, waCountsMessaged: $('rWa').checked, perPersonDays: n('rGap', 7), smsPence: n('rPence', 4),
      caps: { email: n('rEm', 100), sms: n('rSms', 200), whatsapp: n('rWaC', 200) }, reviewLink: $('rRev').value.trim() || REVIEW_LINK }); c.settingsBy = ME; c.settingsAt = Date.now(); return c; });
      closeSheet(); await loadSales(true); show('campaigns'); toast('✓ Saved'); } catch (e) { toast('⚠ ' + e.message, 6000); }
  };
}

/* ================================================================ B2B === */
function paintB2B() {
  const now = Date.now();
  const q = V.b2bQ.toLowerCase();
  const list = D.accounts.filter(a => (!q || [a.company, a.area, a.sector, ...(a.contacts || []).map(p => p.name + ' ' + p.email + ' ' + p.phone)].join(' ').toLowerCase().indexOf(q) > -1) &&
    (!V.b2bOwner || a.owner === V.b2bOwner));
  const due = S.b2bDue(list, now);
  const owners = [...new Set(D.accounts.map(a => a.owner).filter(Boolean))];
  const sent = id => D.sends.filter(s => D.contacts.some(c => c.accountId === id && c.key === s.contact));
  const card = a => {
    const late = a.nextAt && a.nextAt < now;
    const ss = sent(a.id), last = ss.filter(s => s.status === 'sent').sort((x, y) => y.sentAt - x.sentAt)[0];
    const p = (a.contacts || [])[0] || {};
    return '<button class="acc" data-acc="' + esc(a.id) + '"><b>' + esc(a.company) + '</b><small>' + esc([p.name, a.fleet && a.fleet + ' vehicles', a.area].filter(Boolean).join(' · ') || '—') + '</small>' +
      (a.nextAt ? '<small class="' + (late ? 'late' : '') + '">' + (late ? 'Overdue: ' : 'Next: ') + esc(dshort(a.nextAt) + (a.nextWhat ? ' — ' + a.nextWhat : '')) + '</small>' : '') +
      (last ? '<small>✉ ' + esc(last.campaignName || '') + ' ' + esc(ago(last.sentAt)) + ' ago' + (ss.some(s => s.replyAt) ? ' · replied' : '') + '</small>' : '') +
      (a.owner ? '<small style="color:var(--gold)">' + esc(a.owner) + '</small>' : '') + '</button>';
  };
  $('view-sales').innerHTML = '<div class="sv"><div class="row2" style="justify-content:space-between"><div><h2>B2B</h2><p class="lede">Fleets, trade and businesses — paper-pad leads, imported lists and anyone from the CRM\'s B2B board, in one pipeline.</p></div>' +
    '<div class="btns" style="margin:0"><button class="btn" id="bImp">Import a list</button><button class="btn primary" id="bAdd">+ Company</button></div></div>' +
    (D.b2bMissing ? '<div class="note warn"><b>Couldn\'t read the CRM\'s B2B board (kith_b2b)</b>Paper-pad leads won\'t show here until it can be read.</div>' : '') +
    '<div class="row2"><input type="search" id="bq" placeholder="Company, contact, area…" value="' + esc(V.b2bQ) + '" style="background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:.35rem .6rem">' +
      '<select id="bOwn" style="background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:.35rem .6rem"><option value="">Everyone\'s</option>' + owners.map(o => '<option' + (V.b2bOwner === o ? ' selected' : '') + '>' + esc(o) + '</option>').join('') + '</select>' +
      '<button class="btn sm ghost" id="bSeq">Email sequence to a stage…</button></div>' +
    (due.length ? '<h3 class="sec">Due today · ' + due.length + '</h3><div class="cards">' + due.slice(0, 12).map(card).join('') + '</div>' : '') +
    '<div class="board">' + S.B2B_STAGES.map(st => {
      const inCol = list.filter(a => (a.stage || 'prospect') === st.k).sort((x, y) => (x.nextAt || 9e15) - (y.nextAt || 9e15));
      return '<div class="col"><h3>' + esc(st.label) + '<span>' + inCol.length + '</span></h3>' + inCol.slice(0, 80).map(card).join('') + (inCol.length > 80 ? '<p class="hint">+' + (inCol.length - 80) + ' more — search to find them</p>' : '') + '</div>';
    }).join('') + '</div></div>';
  $('bq').oninput = e => { V.b2bQ = e.target.value; clearTimeout(V.bt); V.bt = setTimeout(paint, 200); };
  $('bOwn').onchange = e => { V.b2bOwner = e.target.value; paint(); };
  $('bAdd').onclick = () => accSheet(null);
  $('bImp').onclick = importSheet;
  $('bSeq').onclick = () => builder({ id: 'C' + Date.now().toString(36), type: 'campaign', name: 'B2B intro', status: 'draft', channels: ['email'], audience: { segment: 'b2b', b2bStage: 'prospect' },
    msg: { sms: { body: '' }, email: { subject: 'Fleet servicing for {company}', body: 'Hi {first_name},\n\nI run KITH Cars in Hackbridge — mechanical repairs, servicing, MOTs, bodywork and recovery under one roof. We look after vans and cars for local businesses on account, with priority slots so vehicles aren\'t off the road for long.\n\nWould it be worth a quick call to see if we can help {company}?\n\nThanks,\nLogan\nKITH Cars · {shop_phone}' }, whatsapp: { template: '', params: [] } },
    followUps: [{ afterDays: 4, msg: { email: { subject: 'Re: Fleet servicing for {company}', body: 'Hi {first_name},\n\nJust bumping this up in case it got buried. Happy to price up your next service or MOT so you can see what we\'re like.\n\nThanks,\nLogan' }, sms: { body: '' } } }] });
  document.querySelectorAll('[data-acc]').forEach(b => b.onclick = () => accSheet(b.dataset.acc));
}
function accSheet(id) {
  const a0 = id ? D.accounts.find(x => x.id === id) : { id: 'A' + Date.now().toString(36), type: 'account', company: '', companyType: '', contacts: [{ name: '', role: '', email: '', phone: '' }], stage: 'prospect', owner: ME, log: [], source: 'Added by ' + ME, createdAt: Date.now() };
  if (!a0) return;
  const a = clone(a0);
  const people = [...new Set(STAFF.map(p => p.name).concat([ME, a.owner]).filter(Boolean))];
  const contactRows = () => (a.contacts || []).map((p, i) => '<div class="frow" data-ci="' + i + '">' + ['name', 'role', 'email', 'phone'].map(k => '<div class="f"><label>' + ({ name: 'Name', role: 'Role', email: 'Email', phone: 'Phone' })[k] + '</label><input data-cf="' + k + '" value="' + esc(p[k] || '') + '"></div>').join('') + '</div>').join('');
  const sends = D.sends.filter(s => D.contacts.some(c => c.accountId === a.id && c.key === s.contact)).sort((x, y) => (y.sentAt || y.sendAt) - (x.sentAt || x.sendAt));
  sheet('<button class="btn sm x" data-close>Close</button><h2>' + esc(a.company || 'New company') + '</h2>' +
    '<div class="frow"><div class="f"><label for="aCo">Company</label><input id="aCo" value="' + esc(a.company) + '"></div>' +
      '<div class="f"><label for="aTy">Type</label><select id="aTy">' + [['ltd', 'Limited company / LLP / PLC'], ['sole', 'Sole trader / partnership'], ['unknown', 'Not sure']].map(o => '<option value="' + o[0] + '"' + (S.companyType(a.company, a.companyType) === o[0] ? ' selected' : '') + '>' + o[1] + '</option>').join('') + '</select></div></div>' +
    '<p class="hint">Cold emails can only go to limited companies. Sole traders and partnerships count as people and need to say yes first.</p>' +
    '<div class="frow"><div class="f"><label for="aSt">Stage</label><select id="aSt">' + S.B2B_STAGES.map(s => '<option value="' + s.k + '"' + (a.stage === s.k ? ' selected' : '') + '>' + esc(s.label) + '</option>').join('') + '</select></div>' +
      '<div class="f"><label for="aOw">Who has it</label><select id="aOw"><option value="">— nobody —</option>' + people.map(n => '<option' + (a.owner === n ? ' selected' : '') + '>' + esc(n) + '</option>').join('') + '</select></div>' +
      '<div class="f"><label for="aFl">Vehicles</label><input id="aFl" value="' + esc(a.fleet || '') + '"></div></div>' +
    '<div class="frow"><div class="f"><label for="aAr">Area</label><input id="aAr" value="' + esc(a.area || '') + '"></div><div class="f"><label for="aSe">Sector</label><input id="aSe" value="' + esc(a.sector || '') + '"></div></div>' +
    '<div class="frow"><div class="f"><label for="aNx">Next step on</label><input type="date" id="aNx" value="' + esc(a.nextAt ? S.ymd(a.nextAt) : '') + '"></div><div class="f"><label for="aNw">Next step</label><input id="aNw" value="' + esc(a.nextWhat || '') + '" placeholder="e.g. call back about prices"></div></div>' +
    '<div class="secb"><h3>People</h3><div id="aPeople">' + contactRows() + '</div><button class="btn sm ghost" id="aAddP">+ Person</button></div>' +
    '<div class="secb"><h3>Notes &amp; calls</h3><textarea class="reply" id="aNote" placeholder="Called — spoke to Pat, 12 vans, contract up in March"></textarea>' +
      '<div class="btns"><button class="btn sm" data-q="Called — no answer" data-d="2">No answer (try again in 2 days)</button><button class="btn sm" data-q="Left a voicemail" data-d="3">Voicemail</button><button class="btn sm" data-q="Sent prices" data-d="4">Sent prices</button></div>' +
      (a.log || []).slice().reverse().slice(0, 40).map(x => '<div class="msg" style="max-width:100%;margin-top:.4rem"><span class="w"><b>' + esc(x.by || '') + '</b> · ' + esc(dshort(x.t)) + '</span><pre>' + esc(x.what) + '</pre></div>').join('') + '</div>' +
    (sends.length ? '<div class="secb"><h3>Emails</h3>' + sends.slice(0, 20).map(s => '<div class="hint">' + esc(dshort(s.sentAt || s.sendAt) + ' · ' + (s.campaignName || '') + ' · ' + s.status + (s.replyAt ? ' · replied' : '')) + '</div>').join('') + '</div>' : '') +
    '<div class="btns" style="position:sticky;bottom:0;background:var(--bg-2);padding:.6rem 0;margin-top:1rem;border-top:1px solid var(--line)"><button class="btn primary" id="aGo">Save</button>' +
      (id ? '<button class="btn" id="aSeq">Add to an email sequence</button>' : '') + ((a.contacts || []).some(p => p.email) ? '<a class="btn ghost" href="mailto:' + esc(a.contacts.find(p => p.email).email) + '">Email now</a>' : '') + '</div>');
  const readPeople = () => [...document.querySelectorAll('[data-ci]')].map(row => { const o = {}; row.querySelectorAll('[data-cf]').forEach(x => { o[x.dataset.cf] = x.value.trim(); }); return o; }).filter(p => p.name || p.email || p.phone);
  $('aAddP').onclick = () => { a.contacts = readPeople().concat([{ name: '', role: '', email: '', phone: '' }]); $('aPeople').innerHTML = contactRows(); };
  let quick = null;
  document.querySelectorAll('[data-q]').forEach(b => b.onclick = () => { $('aNote').value = b.dataset.q; quick = +b.dataset.d; $('aNx').value = S.ymd(Date.now() + quick * DAY); });
  const save = async () => {
    const co = $('aCo').value.trim(); if (!co) return toast('Company name?');
    const note = $('aNote').value.trim(), stage = $('aSt').value;
    const out = Object.assign(clone(a), { company: co, companyType: $('aTy').value, stage, owner: $('aOw').value, fleet: $('aFl').value.trim(), area: $('aAr').value.trim(), sector: $('aSe').value.trim(),
      nextAt: $('aNx').value ? Date.parse($('aNx').value + 'T09:00:00') : 0, nextWhat: $('aNw').value.trim(), contacts: readPeople() });
    const log = (out.log || []).slice();
    if (note) log.push({ t: Date.now(), by: ME, what: note });
    if (stage !== a0.stage && id) log.push({ t: Date.now(), by: ME, what: 'Moved to ' + S.B2B_STAGES.find(s => s.k === stage).label });
    out.log = log;
    try {
      await saveRow(out.id, cur => Object.assign(cur || {}, out, { log: mergeLog((cur || {}).log, log), type: 'account' }));
      // keep the CRM's own B2B board in step
      if (out.b2bId && stage !== a0.stage) {
        const crm = S.B2B_STAGES.find(s => s.k === stage).crm;
        try { await cas('kith_b2b', out.b2bId, cur => cur ? Object.assign(cur, { status: crm }) : undefined); } catch (e) { console.warn('kith_b2b mirror', e); }
      }
      closeSheet(); await loadSales(true); show('b2b'); toast('✓ Saved');
    } catch (e) { toast('⚠ ' + e.message, 6000); }
  };
  $('aGo').onclick = save;
  if ($('aSeq')) $('aSeq').onclick = () => { closeSheet(); builder({ id: 'C' + Date.now().toString(36), type: 'campaign', name: 'B2B — ' + a.company, status: 'draft', channels: ['email'], audience: { segment: 'b2b', accounts: [a.id] },
    msg: { sms: { body: '' }, email: { subject: 'Fleet servicing for {company}', body: 'Hi {first_name},\n\n' }, whatsapp: { template: '', params: [] } }, followUps: [] }); };
}
// Two people adding notes at once: keep both
function mergeLog(a, b) {
  const seen = new Map();
  (a || []).concat(b || []).forEach(x => seen.set(x.t + '|' + x.what, x));
  return [...seen.values()].sort((x, y) => x.t - y.t);
}
function importSheet() {
  sheet('<button class="btn sm x" data-close>Close</button><h2>Import a list</h2>' +
    '<p class="hint">A spreadsheet saved as CSV, or paste the rows straight from Excel / Google Sheets. It needs a header row with at least a company or email column. Duplicates are matched on email, phone or company name and filled in, never doubled.</p>' +
    '<input type="file" id="iFile" accept=".csv,text/csv,.tsv,text/plain" style="margin:.4rem 0">' +
    '<textarea class="reply" id="iTxt" placeholder="Company,Contact,Email,Phone,Fleet Size&#10;Acme Plumbing Ltd,Pat,pat@acme.co.uk,,12" style="min-height:9rem"></textarea>' +
    '<div id="iPrev"></div><button class="btn primary" id="iGo" disabled>Import</button>');
  let res = null;
  const prev = () => {
    res = S.importAccounts($('iTxt').value, D.accounts, ME);
    if (res.error) { $('iPrev').innerHTML = '<div class="note warn">' + esc(res.error) + '</div>'; $('iGo').disabled = true; return; }
    const ltd = res.added.filter(a => a.companyType === 'ltd').length;
    $('iPrev').innerHTML = '<div class="sum"><div class="big">' + res.added.length + ' new</div><div class="hint">' + res.updated.length + ' already here (filled in) · ' + res.skipped + ' blank rows skipped · ' +
      ltd + ' limited compan' + (ltd === 1 ? 'y' : 'ies') + ' can be cold emailed; ' + (res.added.length - ltd) + ' need a yes first</div>' +
      '<div class="hint">Columns found: ' + esc(Object.keys(res.map).join(', ')) + '</div></div>' +
      res.added.slice(0, 5).map(a => '<div class="hint">' + esc(a.company + ' · ' + ((a.contacts[0] || {}).email || (a.contacts[0] || {}).phone || '')) + '</div>').join('');
    $('iGo').disabled = !(res.added.length || res.updated.length);
  };
  $('iTxt').oninput = prev;
  $('iFile').onchange = e => { const f = e.target.files[0]; if (!f) return; const r = new FileReader(); r.onload = () => { $('iTxt').value = r.result; prev(); }; r.readAsText(f); };
  $('iGo').onclick = async () => {
    if (!res) return;
    $('iGo').disabled = true;
    try {
      const rows = res.added.map(a => ({ id: a.id, data: a, updated_at: new Date().toISOString() }));
      for (let i = 0; i < rows.length; i += 200) {
        const r = await fetch(REST() + 'kith_sales', { method: 'POST', headers: HDR({ Prefer: 'resolution=ignore-duplicates' }), body: JSON.stringify(rows.slice(i, i + 200)) });
        if (!r.ok) throw new Error('Import stopped (' + r.status + ')');
      }
      for (const a of res.updated) await saveRow(a.id, cur => Object.assign(cur || {}, a, { type: 'account', log: mergeLog((cur || {}).log, a.log) }));
      closeSheet(); await loadSales(true); show('b2b'); toast('✓ Imported ' + res.added.length + ' new, updated ' + res.updated.length, 5000);
    } catch (e) { toast('⚠ ' + e.message, 6000); $('iGo').disabled = false; }
  };
}

/* ---------------------------------------------------------------- go ---- */
window.KSalesUI = {
  show,
  openCustomer(key) { V.seg = 'all'; V.q = ''; V.open = key; show('customers'); },
  reload: () => loadSales(true).then(paint),
  data: () => D
};
let saved = HAS_INBOX() ? 'inbox' : 'pipeline'; try { saved = localStorage.getItem('kith_sales_view') || saved; } catch (e) {}
if (!HAS_INBOX() && saved === 'inbox') saved = 'pipeline';
const wait = setInterval(() => { if (ME) { clearInterval(wait); if (saved !== 'inbox') show(saved); } }, 300);
})();
