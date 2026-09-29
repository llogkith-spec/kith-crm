/* KITH Stock — the rules for bodywork and mechanical stock.
 *
 *   Bodywork   — bodyshop materials: tins, clear, primer, masking, abrasives.
 *              Used against a job, so every bodywork job carries its real
 *              materials cost.
 *   Mechanical — oils, fluids, filters, bulbs. The same list the Parts app
 *              keeps (one "__stock__" row; paint items are kind:'paint').
 *
 * Plain data in, plain data out, so it runs in the browser and in tests.
 * Saving uses KITHParts.saveList (the safe, merge-don't-overwrite save).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.KITHStock = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const VERSION = '1.0';

  // ── The three sections ──────────────────────────────────────────
  // Every item carries kind:'paint' (bodyshop), 'tyre' or nothing at all
  // (mechanical), and a cat within it. The Parts app sees the same list.
  const SECTIONS = [
    { k: 'paint', label: 'Bodywork', hint: 'Paint, clear, primer, thinners, masking, abrasives.' },
    { k: 'tyre', label: 'Tyres', hint: 'Tyres on the rack, valves, weights, repair kit.' },
    { k: 'shop', label: 'Mechanical', hint: 'Oils, fluids, filters, bulbs, sprays, workshop sundries.' }
  ];
  const PAINT_CATS = ['Paint', 'Clear and hardener', 'Primer and filler', 'Thinners and cleaners', 'Masking', 'Abrasives', 'Other'];
  const TYRE_CATS = ['Tyres', 'Valves and TPMS', 'Weights', 'Repair and sundries', 'Other'];
  const SHOP_CATS = ['Oils and fluids', 'Filters', 'Brakes and clutch', 'Electrical and bulbs', 'Service parts', 'Sprays and cleaners', 'Workshop consumables', 'Fixings and sundries', 'Other'];
  const CATS = { paint: PAINT_CATS, tyre: TYRE_CATS, shop: SHOP_CATS };
  const kindOf = it => (it && it.kind === 'paint') ? 'paint' : (it && it.kind === 'tyre') ? 'tyre' : 'shop';
  const catsFor = k => CATS[k] || SHOP_CATS;

  // A starting list for each section, so nobody has to type the shelf out.
  // Quantities start at nothing — the first stocktake fills them in.
  const STARTER = {
    paint: [
      ['Base coat — mixed to code', 'Paint', 'litre', 1], ['2K clear coat', 'Clear and hardener', 'litre', 3],
      ['Clear hardener', 'Clear and hardener', 'litre', 2], ['Aerosol touch-up', 'Paint', 'can', 2],
      ['Epoxy primer', 'Primer and filler', 'litre', 1], ['High-build primer', 'Primer and filler', 'litre', 1],
      ['Body filler', 'Primer and filler', 'tin', 2], ['Stopper / fine filler', 'Primer and filler', 'tin', 1],
      ['Seam sealer', 'Primer and filler', 'tube', 2], ['Stone chip / underbody', 'Primer and filler', 'can', 2],
      ['Thinners', 'Thinners and cleaners', 'litre', 5], ['Panel wipe', 'Thinners and cleaners', 'litre', 5],
      ['Degreaser', 'Thinners and cleaners', 'litre', 2], ['Tack cloths', 'Thinners and cleaners', 'pack', 2],
      ['Masking tape 18mm', 'Masking', 'roll', 6], ['Masking tape 36mm', 'Masking', 'roll', 6],
      ['Fine line tape', 'Masking', 'roll', 2], ['Masking paper', 'Masking', 'roll', 2],
      ['Masking film', 'Masking', 'roll', 1], ['Aperture / door foam', 'Masking', 'roll', 1],
      ['P80 discs', 'Abrasives', 'box', 2], ['P180 discs', 'Abrasives', 'box', 2],
      ['P400 discs', 'Abrasives', 'box', 2], ['P800 discs', 'Abrasives', 'box', 3],
      ['P1500 wet and dry', 'Abrasives', 'pack', 2], ['Compound', 'Abrasives', 'bottle', 1],
      ['Polish', 'Abrasives', 'bottle', 1], ['Polishing pads', 'Abrasives', 'each', 2],
      ['Mixing cups', 'Other', 'pack', 2], ['Spray gun filters', 'Other', 'pack', 1],
      ['Paint suits', 'Other', 'each', 3], ['Spray masks / filters', 'Other', 'each', 3],
      ['Nitrile gloves (bodyshop)', 'Other', 'box', 2]
    ],
    tyre: [
      ['Tyres 15" — budget', 'Tyres', 'each', 2], ['Tyres 16" — budget', 'Tyres', 'each', 2],
      ['Tyres 17" — budget', 'Tyres', 'each', 2], ['Tyres 18" — budget', 'Tyres', 'each', 2],
      ['Part-worn stock', 'Tyres', 'each', 0],
      ['Rubber valves TR414', 'Valves and TPMS', 'box', 1], ['Metal valves', 'Valves and TPMS', 'box', 1],
      ['TPMS service kits', 'Valves and TPMS', 'pack', 1], ['Valve caps', 'Valves and TPMS', 'box', 1],
      ['Valve cores', 'Valves and TPMS', 'pack', 1],
      ['Clip-on weights', 'Weights', 'box', 1], ['Stick-on weight strips', 'Weights', 'box', 1],
      ['Puncture repair patches', 'Repair and sundries', 'box', 1], ['Repair plugs', 'Repair and sundries', 'box', 1],
      ['Vulcanising fluid', 'Repair and sundries', 'tube', 2], ['Tyre soap / bead lube', 'Repair and sundries', 'tub', 1],
      ['Bead sealer', 'Repair and sundries', 'tin', 1], ['Tyre shine', 'Repair and sundries', 'bottle', 1],
      ['Wheel nuts / bolts (common)', 'Other', 'each', 4], ['Locking nut key set', 'Other', 'each', 1],
      ['Hub paste / copper grease', 'Other', 'tin', 1], ['Alloy wheel cleaner', 'Other', 'litre', 1]
    ],
    shop: [
      ['5W-30 engine oil', 'Oils and fluids', 'litre', 20], ['5W-40 engine oil', 'Oils and fluids', 'litre', 20],
      ['0W-20 engine oil', 'Oils and fluids', 'litre', 10], ['10W-40 engine oil', 'Oils and fluids', 'litre', 10],
      ['Gear oil 75W-90', 'Oils and fluids', 'litre', 5], ['ATF (auto gearbox)', 'Oils and fluids', 'litre', 5],
      ['Coolant / antifreeze', 'Oils and fluids', 'litre', 10], ['Brake fluid DOT4', 'Oils and fluids', 'litre', 5],
      ['Power steering fluid', 'Oils and fluids', 'litre', 2], ['AdBlue', 'Oils and fluids', 'litre', 10],
      ['Screenwash', 'Oils and fluids', 'litre', 10],
      ['Oil filters (common sizes)', 'Filters', 'each', 5], ['Air filters (common sizes)', 'Filters', 'each', 3],
      ['Cabin filters (common sizes)', 'Filters', 'each', 3], ['Fuel filters', 'Filters', 'each', 2],
      ['Sump plugs and washers', 'Service parts', 'pack', 2], ['Sump plug washers (assorted)', 'Service parts', 'pack', 1],
      ['Wiper blades (common sizes)', 'Service parts', 'each', 4], ['Spark plugs (common)', 'Service parts', 'each', 4],
      ['Brake cleaner', 'Sprays and cleaners', 'can', 6], ['Carb / throttle cleaner', 'Sprays and cleaners', 'can', 2],
      ['Penetrating spray (WD-type)', 'Sprays and cleaners', 'can', 3], ['Copper grease', 'Sprays and cleaners', 'tin', 2],
      ['Ceramic brake grease', 'Sprays and cleaners', 'tube', 1], ['Silicone spray', 'Sprays and cleaners', 'can', 1],
      ['Contact cleaner', 'Sprays and cleaners', 'can', 1], ['Battery terminal spray', 'Sprays and cleaners', 'can', 1],
      ['Brake pad grease sachets', 'Brakes and clutch', 'pack', 2], ['Brake cleaner brushes', 'Brakes and clutch', 'each', 1],
      ['Bulbs H7', 'Electrical and bulbs', 'each', 4], ['Bulbs H4', 'Electrical and bulbs', 'each', 4],
      ['Bulbs W5W / sidelight', 'Electrical and bulbs', 'each', 6], ['Bulbs 501 / indicator', 'Electrical and bulbs', 'each', 6],
      ['Blade fuses (assorted)', 'Electrical and bulbs', 'pack', 2], ['Cable ties', 'Fixings and sundries', 'pack', 2],
      ['Jubilee clips (assorted)', 'Fixings and sundries', 'pack', 1], ['Trim clips (assorted)', 'Fixings and sundries', 'box', 1],
      ['Self-tappers and washers', 'Fixings and sundries', 'box', 1], ['Exhaust paste', 'Fixings and sundries', 'tube', 2],
      ['Nitrile gloves', 'Workshop consumables', 'box', 3], ['Blue roll', 'Workshop consumables', 'roll', 6],
      ['Rags', 'Workshop consumables', 'bag', 2], ['Hand cleaner', 'Workshop consumables', 'tub', 1],
      ['Wing covers / seat covers', 'Workshop consumables', 'each', 4], ['Floor mats (paper)', 'Workshop consumables', 'pack', 2],
      ['Oil drain bags', 'Workshop consumables', 'each', 2], ['Funnel / oil jug', 'Workshop consumables', 'each', 1]
    ]
  };

  const num = v => { const n = parseFloat(v); return isFinite(n) ? n : 0; };
  const money = n => Math.round(n * 100) / 100;
  const clone = o => JSON.parse(JSON.stringify(o));
  const iso = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  function ts(d) {
    return (d || new Date()).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  // ═══════════════════════ PAINT MATERIALS ═════════════════════════

  const isPaint = it => !!it && it.kind === 'paint';
  const inSection = (it, k) => kindOf(it) === k;

  // Add the standard list for a section, skipping anything already there
  // (matched on name, so a shelf that has been half typed out is safe).
  function starterItems(stock, kind, by, now, makeStockItem) {
    const have = {};
    (stock || []).forEach(it => { if (it && it.name) have[String(it.name).toLowerCase().trim()] = true; });
    const rows = STARTER[kind] || [];
    const out = [];
    rows.forEach((r, i) => {
      if (have[r[0].toLowerCase()]) return;
      out.push(makeStockItem({ name: r[0], cat: r[1], unit: r[2], min: r[3], qty: 0, kind: kind === 'shop' ? '' : kind, idSuffix: 'S' + i }, by, now));
    });
    return out;
  }

  // ── Stocktake: tick each item as it is counted ──────────────────
  // counts: {itemId: countedQty}. Only the ones that moved are written,
  // and each is written as a CHANGE (+3, −1) so a delivery booked in by
  // someone else at the same moment is not thrown away.
  function stocktakeApply(stock, counts, by, now, adjustStock) {
    const changes = [];
    const out = (stock || []).map(it => {
      if (!it || !(it.id in (counts || {}))) return it;
      const was = num(it.qty), got = num(counts[it.id]);
      const diff = money(got - was);
      let next = diff ? adjustStock(it, diff, 'stocktake', by, now) : clone(it);
      next.countedOn = iso(now || new Date()); next.countedBy = by || '';
      if (diff) changes.push({ id: it.id, name: it.name, unit: it.unit || 'each', was, now: got, diff, value: money(diff * num(it.price)) });
      return next;
    });
    return { stock: out, changes, counted: Object.keys(counts || {}).length, valueDiff: money(changes.reduce((a, c) => a + c.value, 0)) };
  }
  const stockValue = items => money((items || []).reduce((a, it) => a + num(it.qty) * num(it.price), 0));
  function countedAgo(it, today) {
    if (!it || !it.countedOn) return null;
    const d1 = new Date(it.countedOn + 'T00:00:00'), d2 = new Date((today || iso(new Date())) + 'T00:00:00');
    if (isNaN(d1) || isNaN(d2)) return null;
    return Math.max(0, Math.round((d2 - d1) / 86400000));
  }
  const neverCounted = items => (items || []).filter(it => !it.countedOn).length;
  const unitCost = it => num(it && it.price);

  // Use materials on a job: takes each off the shelf and returns the lines
  // to record on the job. Refuses to use more than is on the shelf (a
  // recount is the fix, not a negative count).
  function useMaterials(stock, lines, reg, by, now, adjustStock) {
    const want = (lines || []).map(l => ({ id: l.stockId, qty: num(l.qty) })).filter(l => l.id && l.qty > 0);
    if (!want.length) throw new Error('Pick at least one item and how much.');
    const used = [];
    let out = (stock || []).slice();
    want.forEach(l => {
      const i = out.findIndex(s => s.id === l.id);
      if (i < 0) throw new Error('That item is no longer on the list.');
      const it = out[i];
      if (l.qty > num(it.qty) + 1e-9) throw new Error('Only ' + num(it.qty) + ' ' + (it.unit || '') + ' of ' + it.name + ' on the shelf. Recount it first if that’s wrong.');
      out[i] = adjustStock(it, -l.qty, 'used on ' + (reg || 'a job'), by, now);
      used.push({ id: 'M' + (now || new Date()).getTime() + '-' + used.length, stockId: it.id, name: it.name, cat: it.cat || '', qty: l.qty, unit: it.unit || 'each',
        unitCost: unitCost(it), cost: money(l.qty * unitCost(it)), on: iso(now || new Date()), at: ts(now), by: by || '' });
    });
    return { stock: out, used, total: money(used.reduce((a, u) => a + u.cost, 0)) };
  }
  // Record them on the job (the job keeps its own materials list)
  function addMaterialsToJob(data, used, by, now) {
    const d = data;
    d.materials = (d.materials || []).concat(used);
    d.materialsCost = money(d.materials.reduce((a, m) => a + num(m.cost), 0));
    d.materialsLast = iso(now || new Date());
    d.log = d.log || [];
    const tot = money(used.reduce((a, u) => a + num(u.cost), 0));
    d.log.push({ t: ts(now), s: '🎨 Materials: ' + used.map(u => u.qty + ' ' + u.unit + ' ' + u.name).join(', ') + ' — £' + tot.toFixed(2) + (by ? ' [' + by + ']' : '') });
    return d;
  }
  const jobMaterialsCost = j => money(((j && j.materials) || []).reduce((a, m) => a + num(m.cost), 0));
  // Materials against what the job is worth. Quotes are held inc VAT.
  function materialsReport(jobs) {
    return (jobs || []).filter(j => (j.materials || []).length).map(j => {
      const cost = jobMaterialsCost(j);
      const value = money(num(j.quote) / 1.2);
      return { id: j.id, reg: j.reg || '', work: j.work || '', stage: j.stage || '', cost, value, pct: value ? Math.round(cost / value * 1000) / 10 : null, last: j.materialsLast || '' };
    }).sort((a, b) => (b.last || '').localeCompare(a.last || '') || b.cost - a.cost);
  }

  return {
    VERSION, SECTIONS, PAINT_CATS, TYRE_CATS, SHOP_CATS, CATS, STARTER, kindOf, catsFor, inSection, starterItems,
    stocktakeApply, stockValue, countedAgo, neverCounted,
    isPaint, useMaterials, addMaterialsToJob, jobMaterialsCost, materialsReport, iso, ts
  };
});
