/* =============================================================================
   kith-core.js — ONE place for the database connection and the staff list.

   Every KITH app loads this file first:  <script src="kith-core.js"></script>

   STAFF
   - BASE below is the list the CRM has always used (names, roles, PINs, WhatsApp).
   - The kith_staff table (Accounts → Staff) sits on top of it. From there you can
     add a new person, retire someone (tick "left"), add a role, or set a new PIN —
     and every app picks it up next time it opens. No code change needed.
   - While the table and this list are being brought into line, a person can sign
     in with EITHER their PIN here or the PIN on their kith_staff row. Once Accounts
     → Staff shows the right PIN for everyone, set TABLE_PINS_ONLY to true.

   This is an identification gate, not real security: the key below is the public
   "anon" key and anyone can read this file. Proper logins = Supabase Auth.
   ============================================================================= */
(function (w) {
  'use strict';

  var URL = 'https://mxyrxyhvjndgjqupgstu.supabase.co';
  var KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im14eXJ4eWh2am5kZ2pxdXBnc3R1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIyMTMyNjgsImV4cCI6MjA5Nzc4OTI2OH0.z7F_sUqx56bIcBLxjWFJSP3rT1jhNPAL9_1SWZ7cUog';
  var TABLE_PINS_ONLY = false;
  var BOSS = 'Logkith';                       // director — can see and approve everything

  // name, icon, filter (the CRM's main role), roles, PIN, WhatsApp, label (shown on pickers)
  var BASE = [
    { name: 'Ali',     icon: '📞', filter: 'adviser',   roles: ['adviser', 'parts'],               pin: '7777', wa: '2348126024190', label: 'Service Adviser' },
    { name: 'Joel',    icon: '📋', filter: 'estimator', roles: ['estimator', 'adviser'],           pin: '2222', wa: '639072943859',  label: 'Estimator + Service Adviser (12pm–5pm)' },
    { name: 'Paul',    icon: '📋', filter: 'estimator', roles: ['estimator', 'parts'],             pin: '3333', wa: '',              label: 'Estimator (parts + labour)' },
    { name: 'Elvis',   icon: '📞', filter: 'adviser',   roles: ['adviser', 'parts'],               pin: '8888', wa: '',              label: 'Service Adviser + Parts' },
    { name: 'Sudha',   icon: '🔩', filter: 'parts',     roles: ['parts', 'accounts', 'onsite'],    pin: '6666', wa: '447514422991',  label: 'Accounts / Parts' },
    { name: 'Giles',   icon: '🔧', filter: 'parts',     roles: ['parts', 'workshop'],              pin: '4444', wa: '447496673248',  label: 'Parts / Workshop' },
    { name: 'Harith',  icon: '📋', filter: 'estimator', roles: ['estimator'],                      pin: '5555', wa: '',              label: 'Parts' },
    { name: 'Logkith', icon: '⭐', filter: 'all',       roles: ['director'],                       pin: '0000', wa: '',              label: 'Director' }
  ];
  var ALIAS = { logan: 'logkith' };           // "Logan" on a table row = the director

  // Free-text roles from the table ("Service Adviser", "Parts / Workshop") → role keys
  var ROLE_WORDS = [
    [/direct|owner|boss|admin/i, 'director'], [/advis/i, 'adviser'], [/estimat/i, 'estimator'],
    [/part/i, 'parts'], [/account/i, 'accounts'], [/workshop|manager/i, 'workshop'],
    [/mech|tech/i, 'mechanic'], [/body/i, 'bodyshop'], [/on.?site/i, 'onsite']
  ];
  function rolesFrom(v) {
    var out = [];
    (Array.isArray(v) ? v : [v]).forEach(function (t) {
      if (!t) return;
      ROLE_WORDS.forEach(function (rw) { if (rw[0].test(String(t)) && out.indexOf(rw[1]) < 0) out.push(rw[1]); });
    });
    return out;
  }
  function key(name) { var k = String(name || '').trim().toLowerCase(); return ALIAS[k] || k; }
  function copy(p) {
    var c = {}; for (var k in p) c[k] = Array.isArray(p[k]) ? p[k].slice() : p[k];
    return c;
  }
  function finish(p) {
    p.roles = p.roles || [];
    if (!p.filter) p.filter = p.roles.indexOf('director') >= 0 ? 'all' : (p.roles[0] || 'staff');
    p.role = p.filter === 'all' ? 'director' : p.filter;   // what the role-page apps compare against
    p.icon = p.icon || '👤';
    p.label = p.label || p.role;
    p.pins = p.pins || (p.pin ? [String(p.pin)] : []);
    if (p.active === undefined) p.active = true;
    return p;
  }

  // A kith_staff row may be flat (id, name, pin, role, site, active) or carry a
  // data jsonb column — both are read the same way.
  function fromRow(row) {
    var d = {}, k;
    row = row || {};
    for (k in row) if (k !== 'data') d[k] = row[k];
    if (row.data && typeof row.data === 'object') for (k in row.data) d[k] = row.data[k];
    return {
      id: d.id, name: d.name ? String(d.name).trim() : '', pin: d.pin ? String(d.pin) : '',
      roles: rolesFrom([d.role].concat(d.roles || [])), active: d.active, site: d.site,
      wa: d.wa || d.whatsapp || d.phone || '', label: d.role || ''
    };
  }

  function merge(rows) {
    var map = {}, order = [];
    BASE.forEach(function (b) { var p = finish(copy(b)); map[key(b.name)] = p; order.push(key(b.name)); });
    (rows || []).map(fromRow).forEach(function (r) {
      if (!r.name) return;
      var k = key(r.name), p = map[k];
      if (!p) {                                   // someone added in Accounts → Staff
        p = finish({ id: r.id, name: r.name, roles: r.roles, pin: r.pin, wa: r.wa, label: r.label, active: r.active, site: r.site });
        map[k] = p; order.push(k); return;
      }
      if (r.id) p.id = r.id;
      if (r.active === false) p.active = false;   // ticked as left
      if (r.site !== undefined && r.site !== null) p.site = r.site;
      if (r.wa && !p.wa) p.wa = r.wa;
      r.roles.forEach(function (x) { if (p.roles.indexOf(x) < 0) p.roles.push(x); });
      if (r.pin) {
        if (TABLE_PINS_ONLY) { p.pins = [r.pin]; p.pin = r.pin; }
        else if (p.pins.indexOf(r.pin) < 0) p.pins.push(r.pin);
      }
    });
    return order.map(function (k) { return map[k]; }).filter(function (p) { return p.active !== false; });
  }

  function hdr(extra) {
    var h = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' };
    if (extra) for (var k in extra) h[k] = extra[k];
    return h;
  }
  function rest(path, opts) {
    opts = opts || {};
    opts.headers = hdr(opts.headers);
    return fetch(URL + '/rest/v1/' + String(path).replace(/^\//, ''), opts);
  }

  var current = merge([]);      // usable straight away, before the table answers
  var loading = null;
  var source = 'built-in list';

  function staff(force) {
    if (loading && !force) return loading;
    var ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var t = ctl ? setTimeout(function () { ctl.abort(); }, 6000) : null;
    loading = rest('kith_staff?select=*&limit=200', ctl ? { signal: ctl.signal } : {})
      .then(function (r) { if (!r.ok) throw new Error('kith_staff ' + r.status); return r.json(); })
      .then(function (rows) { current = merge(rows); source = 'kith_staff'; return current.slice(); })
      .catch(function (e) {
        try { console.warn('[kith-core] staff table not readable, using the built-in list:', e && e.message); } catch (x) {}
        source = 'built-in list'; return current.slice();
      })
      .then(function (list) { if (t) clearTimeout(t); return list; });
    return loading;
  }

  function find(name) {
    var k = key(name);
    for (var i = 0; i < current.length; i++) if (key(current[i].name) === k) return current[i];
    return null;
  }
  function hasRole(p, role) {
    if (!p) return false;
    if (p.filter === 'all' || (p.roles || []).indexOf('director') >= 0) return true;
    return p.filter === role || (p.roles || []).indexOf(role) >= 0;
  }
  // true if this PIN belongs to this person. A person with no PIN at all
  // returns true — the apps already warn about that on the sign-in screen.
  function pinOk(p, pin) {
    if (typeof p === 'string') p = find(p);
    if (!p) return false;
    var pins = p.pins || (p.pin ? [String(p.pin)] : []);
    if (!pins.length) return true;
    return pins.indexOf(String(pin == null ? '' : pin).trim()) >= 0;
  }

  // Save a PIN to kith_staff so it follows the person onto every app and device.
  function savePin(name, pin) {
    var p = find(name) || { name: name };
    var body = { pin: String(pin) };
    var q = p.id ? 'id=eq.' + encodeURIComponent(p.id) : 'name=eq.' + encodeURIComponent(p.name);
    return rest('kith_staff?' + q, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(body) })
      .then(function (r) { if (!r.ok) throw new Error('save ' + r.status); return r.json(); })
      .then(function (rows) {
        if (rows && rows.length) return rows;
        var id = String(p.name).toLowerCase().replace(/[^a-z0-9]+/g, '-');
        return rest('kith_staff', {
          method: 'POST', headers: { Prefer: 'return=representation' },
          body: JSON.stringify({ id: id, name: p.name, pin: String(pin), role: p.label || p.role || '', active: true })
        }).then(function (r) { if (!r.ok) throw new Error('save ' + r.status); return r.json(); });
      })
      .then(function (rows) {
        if (p.pins) { if (TABLE_PINS_ONLY) p.pins = [String(pin)]; else if (p.pins.indexOf(String(pin)) < 0) p.pins.push(String(pin)); p.pin = String(pin); }
        return rows;
      });
  }

  // ── PIPELINE + MY DASHBOARDS SWITCHER (20 Nov 2026, Logan) ─────────
  // Everyone lands on the main pipeline. A strip across the top takes them
  // between the pipeline and their own dashboards, on every one of the apps.
  var DASHES = {
    adviser:   { label: '📞 Service Adviser', href: 'kith-adviser.html' },
    parts:     { label: '🔩 Parts',           href: 'kith-parts.html' },
    estimator: { label: '⏱ Labour hours',    href: 'kith-estimator.html' }
  };
  var DASH_FOR = {               // who sees which — by name first, then by role
    Elvis: ['adviser', 'parts'],
    Ali:   ['adviser'],
    Joel:  ['adviser', 'estimator']
  };
  function dashUser() {
    var keys = ['kith_user', 'kith_adv_me', 'kith_parts_me', 'kith_est_me'];
    for (var i = 0; i < keys.length; i++) {
      try {
        var raw = w.localStorage && w.localStorage.getItem(keys[i]);
        if (!raw) continue;
        var n = raw.charAt(0) === '{' ? (JSON.parse(raw).name || '') : raw;
        if (n) return n;
      } catch (e) {}
    }
    return '';
  }
  function dashesFor(name) {
    if (!name) return [];
    if (name === BOSS) return ['adviser', 'parts', 'estimator'];
    if (DASH_FOR[name]) return DASH_FOR[name];
    var p = find(name); if (!p) return [];
    return ['adviser', 'parts', 'estimator'].filter(function (r) { return hasRole(p, r); });
  }
  function dashBar(here, name) {
    try {
      if (!w.document || !w.document.body) return;
      name = name || dashUser();
      var list = dashesFor(name);
      var old = w.document.getElementById('kith-dashbar');
      if (!list.length) { if (old) old.remove(); return; }
      var btn = function (key, label, href) {
        var on = key === here;
        return '<a href="' + href + '" style="flex:1;text-align:center;padding:7px 8px;border-radius:7px;font:700 12.5px system-ui,-apple-system,sans-serif;text-decoration:none;white-space:nowrap;' +
          (on ? 'background:#d4a537;color:#000' : 'background:#1d1d1d;color:#e8e8e8;border:1px solid #333') + '">' + label + '</a>';
      };
      var html = btn('pipeline', '🗂 Pipeline', './') +
        list.map(function (k) { return btn(k, DASHES[k].label, DASHES[k].href); }).join('');
      var bar = old || w.document.createElement('div');
      bar.id = 'kith-dashbar';
      bar.style.cssText = 'display:flex;gap:6px;padding:6px 8px;background:#0b0b0b;border-bottom:1px solid #2a2a2a;position:relative;z-index:50';
      bar.innerHTML = html;
      if (!old) w.document.body.insertBefore(bar, w.document.body.firstChild);
    } catch (e) {}
  }

  w.KithCore = {
    URL: URL, KEY: KEY, BOSS: BOSS,
    dashBar: dashBar, dashesFor: dashesFor,
    hdr: hdr, rest: rest,
    base: function () { return merge([]); },        // the built-in list, fresh copies
    now: function () { return current.slice(); },   // whatever is loaded right now
    staff: staff,                                   // Promise → merged list (table on top of BASE)
    find: find, hasRole: hasRole, pinOk: pinOk, savePin: savePin,
    source: function () { return source; },
    _merge: merge                                   // for tests
  };
  staff();
})(typeof window !== 'undefined' ? window : globalThis);
