/* KITH Parts — the rules the CRM and the Parts app share.
 *
 * Purchase orders, goods in, returns and consumable stock. Everything here
 * is plain data in, plain data out, so it can be tested without a browser
 * and both screens follow exactly the same rules.
 *
 * WHY THE SAFE SAVE EXISTS
 * Every PO lives in ONE row (jobs.id = '__pos__'), and each screen used to
 * write back its whole list. Two people raising orders at the same time
 * meant the second save quietly wiped out the first. saveList() fixes that:
 * it re-reads the row, merges in only what THIS screen changed since it last
 * read it, and writes back only if nobody else wrote in between (checked
 * against updated_at). If someone did, it re-reads and tries again.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.KITHParts = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const VERSION = '1.0';
  const ORDER_WINDOW_DAYS = 3;
  // Same words the CRM uses to decide a job is bodywork (bodywork parts can
  // be ordered any time; mechanical waits until 3 days before the booking).
  const BODYWORK_RE = /body ?work|bodywork|panel|bumper|wing|door skin|paint|respray|dent|scratch|arch|quarter|bonnet|tailgate|sill|accident|crash/i;
  const PAY_METHODS = {
    credit: { label: 'On credit', needsPay: false },
    pod:    { label: 'Pay on delivery', needsPay: false },
    bank:   { label: 'Bank transfer', needsPay: true },
    email:  { label: 'Pay by email', needsPay: true }
  };
  // Still waiting on the supplier
  const OPEN = ['Ordered', 'Awaiting Delivery', 'Part Received', 'Not in stock'];
  const RETURN_STATES = ['Return Requested', 'Part Returned', 'Returned'];

  // ── Consumables: copied from the CRM's isNoMarkup() so both agree ──
  const NO_MARKUP_KEYWORDS = ['engine oil', 'coolant', 'screenwash', 'screen wash', 'antifreeze', 'adblue', 'ad blue', 'washer fluid', 'motor oil', '2-stroke oil', 'windscreen wash', 'tyre', 'tyres', 'tire', 'tires'];
  function isNoMarkup(p) {
    if (p && typeof p === 'object') { if (p.noMarkup) return true; p = p.name; }
    const n = String(p || '').toLowerCase();
    if (/filter|pump|cooler|seal|gasket|sump|dipstick|separator|housing/.test(n)) return false;
    if (/tank|reservoir|bottle|hose|pipe|sensor|switch|thermostat|radiator|valve|\bcap\b|motor(?!\s*oil)|jet|nozzle|flange|bracket|line|tpms/.test(n)) return false;
    if (/\bmot\b/.test(n)) return true;
    if (/\d{1,2}\s?w[-\s]?\d{2}/.test(n)) return true;
    if (/dexos|dexron|\bsae\b|\batf\b|synthetic|gear oil|brake fluid|power steering fluid|hydraulic/.test(n)) return true;
    return NO_MARKUP_KEYWORDS.some(k => n.includes(k));
  }
  const isConsumable = p => isNoMarkup(p) || String((p && p.consumable) || '') === '1';

  const num = v => { const n = parseFloat(v); return isFinite(n) ? n : 0; };
  const qtyOf = v => Math.max(1, parseInt(v, 10) || 1);
  const money = n => Math.round(n * 100) / 100;
  const clone = o => JSON.parse(JSON.stringify(o));

  function ts(d) {
    return (d || new Date()).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  // ── Job parts ─────────────────────────────────────────────────
  const bestPrice = p => num(p.price) || num(p.price1) || num(p.price2) || num(p.price3);
  const supplierOf = p => String(p.supplier || p.supplier1 || p.supplier2 || p.supplier3 || '').trim();
  const realParts = j => ((j && j.parts) || []).filter(p => p && String(p.name || p.num || '').trim());

  // What a part needs: 'ordered' | 'stock' | 'buy' | 'ask' (consumable not checked yet)
  function partState(p) {
    if (p.poNum) return 'ordered';
    if (p.stockStatus === 'stock') return 'stock';
    if (p.stockStatus === 'buy') return 'buy';
    return isConsumable(p) ? 'ask' : 'buy';
  }

  // Parts still to buy, grouped by supplier — same as the CRM's partsBySupplier()
  function toOrderBySupplier(j) {
    const g = {};
    ((j && j.parts) || []).forEach((p, i) => {
      if (!p || !String(p.name || p.num || '').trim()) return;
      if (partState(p) !== 'buy') return;
      const k = supplierOf(p) || '(no supplier)';
      (g[k] = g[k] || []).push({ p, i, cost: bestPrice(p) });
    });
    return g;
  }

  function isBodywork(j) {
    return !!j && (BODYWORK_RE.test(String(j.work || '')) || BODYWORK_RE.test(String(j.notes || '')));
  }
  function daysUntil(dateStr, today) {
    if (!dateStr) return null;
    const d = new Date(dateStr + 'T00:00:00');
    if (isNaN(d.getTime())) return null;
    const t = today ? new Date(today) : new Date();
    t.setHours(0, 0, 0, 0);
    return Math.round((d - t) / 86400000);
  }
  function addDays(dateStr, n) {
    const d = new Date(dateStr + 'T00:00:00'); d.setDate(d.getDate() + n);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  // When can this job's parts be ordered?
  //   now      — booked within 3 days, or bodywork, or already overdue
  //   wait     — booked further out; orderFrom says the first day to order
  //   unbooked — no date yet (parts wait for the booking unless it is bodywork)
  function orderWindow(j, today) {
    if (isBodywork(j)) return { state: 'now', why: 'Bodywork — order any time' };
    const days = daysUntil(j && j.bookedFor, today);
    if (days === null) return { state: 'unbooked', why: 'Not booked yet' };
    if (days <= ORDER_WINDOW_DAYS) return { state: 'now', days, why: days < 0 ? 'Booking date has passed' : days === 0 ? 'Booked today' : 'Booked in ' + days + ' day' + (days === 1 ? '' : 's') };
    return { state: 'wait', days, orderFrom: addDays(j.bookedFor, -ORDER_WINDOW_DAYS), why: 'Booked in ' + days + ' days' };
  }

  // Jobs that are finished with, or never going to need parts buying
  const CLOSED = ['lost', 'done', 'accounts', 'receivable', 'review', 'followup', 'disapproved'];
  // Parts are only bought once the customer has said yes
  const APPROVED_STAGES = ['booked', 'po', 'raised', 'checkin', 'authwait', 'inprog'];
  function needsOrdering(j) {
    if (!j || j.mergedInto || CLOSED.includes(j.stage)) return false;
    if (!APPROVED_STAGES.includes(j.stage) && !j.estApproved) return false;
    return realParts(j).some(p => ['buy', 'ask'].includes(partState(p)));
  }

  // ── Purchase orders ───────────────────────────────────────────
  function poTotal(po) {
    return money(((po && po.items) || []).reduce((a, i) => a + num(i.price) * qtyOf(i.qty), 0));
  }
  // Next free number. The CRM used list length + 1, which hands out a
  // number that is already taken as soon as any PO has been deleted.
  function nextPoNum(list, floor) {
    let max = Number(floor) || 0;
    (list || []).forEach(p => { const m = String((p && p.num) || '').match(/KITH-PO-(\d+)/); if (m) max = Math.max(max, +m[1]); });
    return 'KITH-PO-' + String(max + 1).padStart(3, '0');
  }
  function makePO(o) {
    if (!o || !String(o.supplier || '').trim()) throw new Error('Choose a supplier.');
    const items = (o.items || []).filter(i => String(i.name || '').trim()).map(i => {
      const it = { name: String(i.name).trim(), num: String(i.num || '').trim(), price: i.price === '' || i.price == null ? '' : String(num(i.price)), qty: String(qtyOf(i.qty)), status: 'Ordered' };
      if (i.stockId) it.stockId = i.stockId;
      return it;
    });
    if (!items.length) throw new Error('Add at least one part.');
    if (!PAY_METHODS[o.pay]) throw new Error('Choose how this order is being paid, so accounts know what to do.');
    const now = o.now || new Date();
    const po = {
      id: 'PO' + now.getTime() + (o.idSuffix || ''),
      num: nextPoNum(o.list, o.floor),
      supplier: String(o.supplier).trim(), jobId: o.jobId || null, notes: String(o.notes || '').trim(), items,
      eta: o.eta || '', status: 'Ordered', returnReason: '',
      createdBy: o.by || 'Parts', createdAt: ts(now),
      pay: { method: o.pay, urgent: !!o.urgent, state: PAY_METHODS[o.pay].needsPay ? 'to-pay' : 'fyi' },
      statusLog: [], via: 'parts-app'
    };
    if (o.earlyReason) {
      po.earlyOrder = true; po.earlyOrderReason = o.earlyReason;
      po.statusLog.push(ts(now) + ' ⚠ Raised early — ' + o.earlyReason + ' [' + po.createdBy + ']');
    }
    if (o.onStop) po.statusLog.push(ts(now) + ' ⚠ Raised against an ON STOP supplier [' + po.createdBy + ']');
    // The accounts heads-up, recorded the same way the CRM records it
    const m = PAY_METHODS[o.pay];
    const text = (po.pay.urgent ? 'URGENT: ' : 'Heads-up: ') + po.num + ' ordered from ' + po.supplier +
      (poTotal(po) ? ' for £' + poTotal(po).toFixed(2) : '') + (o.reg ? ' (' + o.reg + ')' : '') + '. ' +
      (m.needsPay ? m.label + ' — please pay this.' : m.label + ' — for your records, nothing to pay now.') + ' Raised by ' + po.createdBy + '.';
    po.msgOutbox = [{ kind: 'accounts-headsup', channel: 'email', to: 'accounts', text, status: 'queued', at: ts(now), t: now.getTime() }];
    if (po.pay.urgent) po.msgOutbox.push({ kind: 'accounts-urgent', channel: 'sms', to: 'accounts', text, status: 'queued', at: ts(now), t: now.getTime() });
    po.statusLog.push(ts(now) + ' ✉ Accounts told — ' + m.label + (po.pay.urgent ? ' (urgent: email + text)' : ' (email)'));
    po._headsUp = text;
    return po;
  }

  // Goods in: how many of each line actually turned up.
  function goodsIn(po, received, note, by, now) {
    const out = clone(po);
    let allIn = true, noneIn = true; const missing = [];
    (out.items || []).forEach((it, i) => {
      const ordered = qtyOf(it.qty);
      const got = Math.max(0, Math.min(ordered, parseInt(received && received[i] != null ? received[i] : ordered, 10) || 0));
      it.received = got;
      if (got < ordered) { allIn = false; missing.push(it.name + ' (' + got + ' of ' + ordered + ')'); }
      if (got > 0) noneIn = false;
    });
    out.deliveryNote = String(note || '').trim();
    out.checkedInAt = ts(now); out.checkedInBy = by || '';
    out.status = allIn ? 'Received' : (noneIn ? 'Ordered' : 'Part Received');
    out.statusLog = out.statusLog || [];
    out.statusLog.push(ts(now) + ' → ' + (allIn ? 'All received' : (noneIn ? 'Nothing arrived' : 'Part received — short: ' + missing.join('; '))) +
      (out.deliveryNote ? ' — ' + out.deliveryNote : '') + (by ? ' [' + by + ']' : ''));
    return { po: out, allIn, noneIn, missing };
  }

  function notInStock(po, note, by, now) {
    const out = clone(po);
    out.status = 'Not in stock'; out.outOfStock = true; out.outOfStockNote = String(note || '').trim();
    out.statusLog = out.statusLog || [];
    out.statusLog.push(ts(now) + ' → Not in stock' + (out.outOfStockNote ? ' — ' + out.outOfStockNote : '') + (by ? ' [' + by + ']' : ''));
    return out;
  }
  function backOnOrder(po, by, now) {
    const out = clone(po);
    out.outOfStock = false; out.outOfStockNote = ''; out.status = 'Ordered';
    out.statusLog = out.statusLog || [];
    out.statusLog.push(ts(now) + ' → Back on order' + (by ? ' [' + by + ']' : ''));
    return out;
  }

  // Return some or all lines. idx = which lines, qtys = how many of each.
  function raiseReturn(po, idx, qtys, reason, ref, by, now) {
    if (!String(reason || '').trim()) throw new Error('Say why it is going back.');
    if (!idx || !idx.length) throw new Error('Pick at least one item to return.');
    const out = clone(po);
    const names = [];
    idx.forEach(i => {
      const it = (out.items || [])[i]; if (!it) return;
      const q = Math.max(1, Math.min(qtyOf(it.qty), parseInt(qtys && qtys[i], 10) || qtyOf(it.qty)));
      it.returned = true; it.returnedQty = q; it.returnReason = String(reason).trim();
      names.push(it.name + (q > 1 ? ' ×' + q : ''));
    });
    const all = (out.items || []).every(it => it.returned);
    if (!RETURN_STATES.includes(out.status)) out.preReturnStatus = out.status;
    out.returnReason = String(reason).trim(); out.returnRef = String(ref || '').trim();
    out.status = all ? 'Return Requested' : 'Part Returned';
    out.returnBy = by || 'Parts'; out.returnAt = ts(now);
    out.statusLog = out.statusLog || [];
    out.statusLog.push(ts(now) + ' ↩ ' + (all ? 'Full return' : 'Part return') + ' — ' + names.join(', ') + ' — ' + out.returnReason +
      (out.returnRef ? ' (ref ' + out.returnRef + ')' : '') + (by ? ' [' + by + ']' : ''));
    return { po: out, all, names };
  }
  function markReturned(po, by, now) {
    const out = clone(po);
    out.status = 'Returned';
    out.statusLog = out.statusLog || [];
    out.statusLog.push(ts(now) + ' → Returned' + (by ? ' [' + by + ']' : ''));
    return out;
  }
  function returnValue(po) {
    return money(((po && po.items) || []).filter(i => i.returned || po.status === 'Return Requested' || po.status === 'Returned')
      .reduce((a, i) => a + num(i.price) * (i.returnedQty || qtyOf(i.qty)), 0));
  }

  // Put the PO number onto the job's parts it covers, and move the job on
  // once nothing is left to buy. Returns a new job object.
  function tagJob(job, idx, po, by, now) {
    const j = clone(job);
    j.parts = j.parts || [];
    (idx || []).forEach(i => { if (j.parts[i]) { j.parts[i].poNum = po.num; j.parts[i].poId = po.id; } });
    j.log = j.log || [];
    j.log.push({ t: ts(now), s: 'PO raised: ' + po.num + ' (' + po.supplier + ') — ' + (po.items || []).length + ' item(s)' + (by ? ' [' + by + ']' : '') });
    const left = realParts(j).filter(p => partState(p) === 'buy').length;
    const ask = realParts(j).filter(p => partState(p) === 'ask').length;
    if (['booked', 'po'].includes(j.stage)) {
      // Everything bought = POs Raised. It used to jump to Work Complete.
      const to = (left || ask) ? 'po' : 'raised';
      if (j.stage !== to) {
        j.stage = to; j.stageAt = (now || new Date()).getTime();
        j.stageHistory = j.stageHistory || [];
        const last = j.stageHistory[j.stageHistory.length - 1];
        if (last && !last.left) last.left = j.stageAt;
        j.stageHistory.push({ stage: to, at: j.stageAt, by: by || '' });
        j.log.push({ t: ts(now), s: to === 'raised' ? '→ All parts ordered — moved to POs/SOs Raised' : '→ More parts still to order' });
      }
    }
    if (j.orderNeeded && j.orderNeeded.pingedAt && !j.orderNeeded.doneAt && !left && !ask) j.orderNeeded.doneAt = (now || new Date()).getTime();
    return j;
  }

  // ── Consumable stock ──────────────────────────────────────────
  // item: {id,name,num,unit,qty,min,supplier,price,log:[],booked:[]}
  function makeStockItem(o, by, now) {
    if (!String((o && o.name) || '').trim()) throw new Error('Give the item a name.');
    return {
      id: 'ST' + (now || new Date()).getTime() + (o.idSuffix || ''), name: String(o.name).trim(), num: String(o.num || '').trim(),
      unit: String(o.unit || 'each').trim(), qty: Math.max(0, num(o.qty)), min: Math.max(0, num(o.min)),
      supplier: String(o.supplier || '').trim(), price: num(o.price) || '',
      log: [{ t: ts(now), s: 'Added with ' + Math.max(0, num(o.qty)) + ' ' + (o.unit || 'each') + (by ? ' [' + by + ']' : '') }], booked: [],
      // bodyshop and tyre stock sit in the same list, marked as such;
      // everything else is mechanical. cat is the shelf it lives on.
      ...(o.kind === 'paint' || o.kind === 'tyre' ? { kind: o.kind } : {}),
      ...(o.cat ? { cat: String(o.cat) } : {})
    };
  }
  function adjustStock(item, delta, why, by, now) {
    const out = clone(item);
    const d = num(delta);
    if (!d) return out;
    out.qty = Math.max(0, money(num(out.qty) + d));
    out.log = out.log || [];
    out.log.push({ t: ts(now), s: (d > 0 ? '+' : '') + d + ' → ' + out.qty + (why ? ' — ' + why : '') + (by ? ' [' + by + ']' : '') });
    if (out.log.length > 60) out.log = out.log.slice(-60);
    return out;
  }
  const isLow = it => num(it.min) > 0 && num(it.qty) <= num(it.min);
  // Enough to get back to twice the minimum
  const reorderQty = it => Math.max(1, Math.ceil(num(it.min) * 2 - num(it.qty)));

  // Book delivered consumables into stock. Idempotent: each PO line is
  // booked once, remembered on the stock item, so it doesn't matter which
  // screen did the goods-in or how many times this runs.
  function bookDeliveries(stock, pos, by, now) {
    let n = 0;
    const out = (stock || []).map(it => {
      let cur = it;
      (pos || []).forEach(po => {
        if (!po || ['Cancelled', 'Returned', 'Return Requested'].includes(po.status)) return;
        (po.items || []).forEach((line, li) => {
          if (line.stockId !== it.id) return;
          const got = line.received != null ? line.received : (['Received', 'Paid'].includes(po.status) ? qtyOf(line.qty) : 0);
          const key = po.id + ':' + li;
          if (!got || (cur.booked || []).includes(key)) return;
          cur = adjustStock(cur, got, 'delivered on ' + po.num, by, now);
          cur.booked = (cur.booked || []).concat(key);
          n++;
        });
      });
      return cur;
    });
    return { stock: out, n };
  }

  // History entries are matched by what they are, not their exact text, so
  // a message that later changes from queued to sent is one entry, not two.
  function entryKey(e) {
    if (e && typeof e === 'object') {
      if (e.id != null) return 'id:' + e.id;
      if (e.kind != null && e.t != null) return 'm:' + e.kind + '|' + (e.channel || '') + '|' + (e.to || '') + '|' + e.t;
    }
    return 'j:' + JSON.stringify(e);
  }
  function unionHistory(remoteArr, localArr, baseArr) {
    const out = remoteArr.slice();
    const at = {}; out.forEach((e, i) => { at[entryKey(e)] = i; });
    const inBase = {}; (baseArr || []).forEach(e => { inBase[entryKey(e)] = JSON.stringify(e); });
    localArr.forEach(e => {
      const k = entryKey(e);
      if (!(k in at)) { out.push(e); at[k] = out.length - 1; return; }
      // same entry on both sides: take this screen's version only if this screen changed it
      if (inBase[k] !== undefined && inBase[k] !== JSON.stringify(e)) out[at[k]] = e;
    });
    return out;
  }
  // Three-way merge of one record: only the fields this screen changed
  // (compared with base) are laid over the server's copy.
  function mergeRecord(b, x, r, opts) {
    const APPEND = opts.appendFields || ['statusLog', 'msgOutbox', 'log', 'cancelledReturns', 'booked'];
    const DELTA = opts.deltaFields || [];
    const m = Object.assign({}, r);
    const fields = new Set(Object.keys(x).concat(Object.keys(b)));
    fields.forEach(k => {
      const xs = JSON.stringify(x[k]), bs = JSON.stringify(b[k]);
      if (xs === bs) return;                                   // not touched here — keep the server's
      if (!(k in x)) { delete m[k]; return; }
      if (APPEND.includes(k) && Array.isArray(x[k]) && Array.isArray(r[k])) { m[k] = unionHistory(r[k], x[k], b[k]); return; }
      // a count (stock on the shelf): apply this screen's change, not its total
      if (DELTA.includes(k) && typeof x[k] === 'number' && typeof b[k] === 'number' && typeof r[k] === 'number') {
        m[k] = Math.round((r[k] + (x[k] - b[k])) * 1000) / 1000; return;
      }
      // a list of lines (a PO's items): merge line by line when the lines still match up
      if (Array.isArray(x[k]) && Array.isArray(b[k]) && Array.isArray(r[k]) &&
          x[k].length === b[k].length && r[k].length === b[k].length &&
          x[k].concat(b[k], r[k]).every(e => e && typeof e === 'object' && !Array.isArray(e))) {
        m[k] = r[k].map((re, i) => mergeRecord(b[k][i], x[k][i], re, { appendFields: [], deltaFields: [] }));
        return;
      }
      m[k] = x[k];
    });
    return m;
  }

  // ── Safe saving of a shared list ──────────────────────────────
  // base   = the list as this screen last read it from the server
  // local  = the list as this screen has it now
  // remote = the list on the server right now
  // Only the records THIS screen added, changed or deleted are applied on
  // top of the server copy, so nobody else's work is lost.
  function merge3(base, local, remote, opts) {
    opts = opts || {};
    const key = opts.key || 'id';
    const B = {}; (base || []).forEach(x => { if (x && x[key] != null) B[x[key]] = JSON.stringify(x); });
    const L = {}; (local || []).forEach(x => { if (x && x[key] != null) L[x[key]] = x; });
    const R = {}; (remote || []).forEach(x => { if (x && x[key] != null) R[x[key]] = true; });
    let out = (remote || []).filter(x => x && x[key] != null).slice();
    const added = [], changed = [];
    (local || []).forEach(x => {
      if (!x || x[key] == null) return;
      const id = x[key];
      if (!(id in B)) { if (!R[id]) added.push(x); else changed.push(x); return; }
      if (B[id] === JSON.stringify(x)) return;          // untouched here
      if (!R[id]) return;                               // deleted elsewhere — deletion wins
      changed.push(x);
    });
    // Field by field: only the fields THIS screen changed are applied, so
    // accounts marking a PO paid and parts booking it in both survive.
    const Bobj = {}; (base || []).forEach(x => { if (x && x[key] != null) Bobj[x[key]] = x; });
    changed.forEach(x => {
      const i = out.findIndex(y => y[key] === x[key]); if (i < 0) return;
      const b = Bobj[x[key]];
      // not in this screen's base but already on the server (e.g. our own save
      // whose reply was lost): only fill in, never overwrite someone else's fields
      out[i] = b ? mergeRecord(b, x, out[i], opts) : Object.assign({}, x, out[i]);
    });
    const deletedIds = Object.keys(B).filter(id => !(id in L));
    if (deletedIds.length) out = out.filter(x => !deletedIds.includes(String(x[key])));
    // new records go on the top, in the order this screen made them
    const renamed = [];
    if (opts.numField) {
      added.forEach((x, ai) => {
        const taken = out.concat(added).some(y => y !== x && y[opts.numField] === x[opts.numField]);
        if (taken && opts.nextNum) {
          // a copy — never change the caller's own record
          const from = x[opts.numField];
          const to = opts.nextNum(out.concat(added), opts.floor);
          const swap = v => typeof v === 'string' ? v.split(from).join(to) : v;
          const y = JSON.parse(JSON.stringify(x));
          y[opts.numField] = to;
          // the accounts heads-up and history already quote the number — fix them too
          (y.msgOutbox || []).forEach(mm => { mm.text = swap(mm.text); });
          if (Array.isArray(y.statusLog)) y.statusLog = y.statusLog.map(swap);
          added[ai] = y;
          renamed.push({ id: x[key], from, to });
        }
      });
    }
    out = added.concat(out);
    return { list: out, added: added.length, changed: changed.length, deleted: deletedIds.length, deletedIds, renamed };
  }
  const numOf = s => { const m = String(s || '').match(/(\d+)\s*$/); return m ? +m[1] : 0; };

  // Compare-and-swap write of one shared row in the jobs table.
  // cfg: {url, key, fetch, rowId, field, base, local, table?, tries?, numField?, nextNum?, deltaFields?}
  // Deletions are recorded in data.deletedIds (the database guard keeps
  // anything else from disappearing). The highest number ever issued is kept
  // in data.maxNum so a deleted PO's number is never handed out again.
  async function saveList(cfg) {
    const f = cfg.fetch || (typeof fetch !== 'undefined' ? fetch : null);
    const table = cfg.table || 'jobs';
    const base = cfg.url.replace(/\/$/, '') + '/rest/v1/' + table;
    const H = { apikey: cfg.key, Authorization: 'Bearer ' + cfg.key, 'Content-Type': 'application/json' };
    const tries = cfg.tries || 6;
    for (let attempt = 0; attempt < tries; attempt++) {
      const g = await f(base + '?id=eq.' + encodeURIComponent(cfg.rowId) + '&select=data,updated_at', { headers: H });
      if (!g.ok) throw new Error('Could not read ' + cfg.rowId + ' (' + g.status + ')');
      const rows = await g.json();
      const row = rows && rows[0];
      const rd = (row && row.data && typeof row.data === 'object') ? row.data : {};
      const remote = Array.isArray(rd[cfg.field]) ? rd[cfg.field] : [];
      const floor = Number(rd.maxNum) || 0;
      const m = merge3(cfg.base, cfg.local, remote, { numField: cfg.numField, nextNum: cfg.nextNum, floor, deltaFields: cfg.deltaFields });
      const data = Object.assign({}, rd); data[cfg.field] = m.list;
      if (m.deletedIds.length) data.deletedIds = Array.from(new Set((Array.isArray(rd.deletedIds) ? rd.deletedIds : []).concat(m.deletedIds))).slice(-2000);
      if (cfg.numField) data.maxNum = Math.max(floor, ...m.list.map(x => numOf(x && x[cfg.numField])), 0);
      const stamp = new Date().toISOString();
      let r;
      if (!row) {
        r = await f(base, { method: 'POST', headers: Object.assign({}, H, { Prefer: 'return=representation' }),
          body: JSON.stringify({ id: cfg.rowId, data, updated_at: stamp }) });
        if (r.status === 409) continue;               // someone created it first — go round again
      } else {
        const cond = row.updated_at == null ? 'updated_at=is.null' : 'updated_at=eq.' + encodeURIComponent(row.updated_at);
        r = await f(base + '?id=eq.' + encodeURIComponent(cfg.rowId) + '&' + cond, { method: 'PATCH',
          headers: Object.assign({}, H, { Prefer: 'return=representation' }), body: JSON.stringify({ data, updated_at: stamp }) });
      }
      if (!r.ok) throw new Error('Save of ' + cfg.rowId + ' failed (' + r.status + ')');
      const back = await r.json();
      if (Array.isArray(back) && back.length) {
        const bd = back[0].data || {};
        const list = Array.isArray(bd[cfg.field]) ? bd[cfg.field] : m.list;
        return { list, renamed: m.renamed, attempts: attempt + 1, updated_at: back[0].updated_at, maxNum: Number(bd.maxNum) || data.maxNum || 0 };
      }
      // zero rows updated = someone else saved in between. Re-read and retry.
    }
    throw new Error('Too many people saving ' + cfg.rowId + ' at once — try again.');
  }

  // Compare-and-swap change to ONE row (a job): read it fresh, apply the
  // change to what is on the server right now, write only if nobody else
  // saved in between. mutate(data) returns the new data (or null = no change).
  async function updateRow(cfg) {
    const f = cfg.fetch || (typeof fetch !== 'undefined' ? fetch : null);
    const base = cfg.url.replace(/\/$/, '') + '/rest/v1/' + (cfg.table || 'jobs');
    const H = { apikey: cfg.key, Authorization: 'Bearer ' + cfg.key, 'Content-Type': 'application/json' };
    for (let attempt = 0; attempt < (cfg.tries || 6); attempt++) {
      const g = await f(base + '?id=eq.' + encodeURIComponent(cfg.rowId) + '&select=data,updated_at', { headers: H });
      if (!g.ok) throw new Error('Could not read ' + cfg.rowId + ' (' + g.status + ')');
      const row = (await g.json())[0];
      if (!row) throw new Error(cfg.rowId + ' is not in the CRM any more.');
      const next = cfg.mutate(clone(row.data));
      if (!next) return { data: row.data, changed: false };
      const stamp = new Date().toISOString();
      next.updatedAt = stamp;
      const cond = row.updated_at == null ? 'updated_at=is.null' : 'updated_at=eq.' + encodeURIComponent(row.updated_at);
      const r = await f(base + '?id=eq.' + encodeURIComponent(cfg.rowId) + '&' + cond, { method: 'PATCH',
        headers: Object.assign({}, H, { Prefer: 'return=representation' }), body: JSON.stringify({ data: next, updated_at: stamp }) });
      if (!r.ok) throw new Error('Save of ' + cfg.rowId + ' failed (' + r.status + ')');
      const back = await r.json();
      if (Array.isArray(back) && back.length) return { data: back[0].data, changed: true, attempts: attempt + 1 };
    }
    throw new Error('Too many people saving ' + cfg.rowId + ' at once — try again.');
  }

  // Find a part on the fresh copy of a job: same position and name if it
  // is still there, otherwise by name. (Someone may have edited the list.)
  function findPart(parts, idx, name) {
    const n = String(name || '').trim().toLowerCase();
    if (parts[idx] && String(parts[idx].name || '').trim().toLowerCase() === n) return idx;
    return parts.findIndex(p => p && String(p.name || '').trim().toLowerCase() === n && !p.poNum);
  }

  return {
    updateRow, findPart,
    VERSION, ORDER_WINDOW_DAYS, PAY_METHODS, OPEN, RETURN_STATES, BODYWORK_RE,
    isNoMarkup, isConsumable, bestPrice, supplierOf, realParts, partState, toOrderBySupplier,
    isBodywork, daysUntil, orderWindow, needsOrdering,
    poTotal, nextPoNum, makePO, goodsIn, notInStock, backOnOrder, raiseReturn, markReturned, returnValue, tagJob,
    makeStockItem, adjustStock, isLow, reorderQty, bookDeliveries,
    merge3, mergeRecord, saveList, ts
  };
});
