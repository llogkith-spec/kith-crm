/* KITH Health Check — the rules, shared by the mechanic app and anything
 * else (CRM, tests) that needs to read a health check.
 *
 * WHERE IT LIVES
 * A health check is stored ON THE JOB: jobs.data.healthCheck. Nothing new
 * in Supabase except photos, which go into the same "job-sheets" bucket the
 * CRM's vehicle check-in already uses, under the job's folder.
 *
 * THE THREE LEVELS
 * Every item carries the smallest level it belongs to (20, 40 or 60). A 40
 * point check is every 20 item plus the 40 items; a 60 is everything. So a
 * job can be upgraded from 20 to 60 without losing what was already done.
 *
 * QUALITY RULES (so a check can't be pencil-whipped)
 *  - every item in the level must have a result before it can be sent
 *  - RED needs a note AND at least one photo
 *  - AMBER needs a note
 *  - tyre tread and brake pad readings set the colour themselves; the
 *    mechanic can make it worse but not better than the reading says
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.KITHHC = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const VERSION = '1.0';

  // m: measurement type. 'tread' = tyre tread mm, 'pad' = pad thickness mm
  const SECTIONS = [
    { id: 'bonnet', name: 'Under the bonnet', items: [
      ['oil', 'Engine oil level and condition', 20],
      ['coolant', 'Coolant level and condition', 20],
      ['brakefluid', 'Brake fluid level and condition', 20],
      ['screenwash', 'Screenwash level', 20],
      ['battery', 'Battery condition and terminals', 20],
      ['belt', 'Auxiliary / drive belt', 40],
      ['hoses', 'Coolant hoses and radiator', 40],
      ['leaks', 'Engine oil or fluid leaks', 40],
      ['psfluid', 'Power steering fluid', 60],
      ['airfilter', 'Air and pollen filters', 60],
      ['mounts', 'Engine mounts', 60],
      ['cambelt', 'Cambelt / timing belt due (records)', 60]
    ] },
    { id: 'lights', name: 'Lights and electrics', items: [
      ['headlights', 'Headlights (dipped and main beam)', 20],
      ['rearlights', 'Rear lights and brake lights', 20],
      ['indicators', 'Indicators and hazards', 20],
      ['warnings', 'Dashboard warning lights', 20],
      ['wipers', 'Wiper blades and washers', 20],
      ['horn', 'Horn', 40],
      ['sidelights', 'Side lights and number plate lights', 40],
      ['foglights', 'Fog lights and reverse light', 60],
      ['hvac', 'Heater, air con and demist', 60],
      ['interior', 'Interior lights', 40],
      ['windows', 'Electric windows, mirrors and service light', 60]
    ] },
    { id: 'tyres', name: 'Tyres and wheels', items: [
      ['tyre_fl', 'Tyre — front left', 20, 'tread'],
      ['tyre_fr', 'Tyre — front right', 20, 'tread'],
      ['tyre_rl', 'Tyre — rear left', 20, 'tread'],
      ['tyre_rr', 'Tyre — rear right', 20, 'tread'],
      ['pressures', 'Tyre pressures set', 40],
      ['spare', 'Spare wheel / repair kit and locking nut key', 40],
      ['wheels', 'Wheel and tyre damage (sidewalls, rims)', 40],
      ['bearings', 'Wheel bearings', 60]
    ] },
    { id: 'brakes', name: 'Brakes', items: [
      ['pads_f', 'Front brake pads', 20, 'pad'],
      ['pads_r', 'Rear brake pads / shoes', 20, 'pad'],
      ['handbrake', 'Handbrake / parking brake', 20],
      ['discs_f', 'Front discs', 40],
      ['discs_r', 'Rear discs / drums', 40],
      ['pipes', 'Brake pipes and hoses', 60],
      ['calipers', 'Calipers', 60]
    ] },
    { id: 'steering', name: 'Steering and suspension', items: [
      ['shocks_f', 'Front shock absorbers', 40],
      ['shocks_r', 'Rear shock absorbers', 40],
      ['trackrods', 'Track rod ends', 40],
      ['steerplay', 'Steering play and power assist', 40],
      ['cvboots', 'CV boots and driveshafts', 40],
      ['springs', 'Road springs', 60],
      ['balljoints', 'Ball joints', 60],
      ['bushes', 'Suspension arms and bushes', 60],
      ['rack', 'Steering rack and gaiters', 60]
    ] },
    { id: 'under', name: 'Underneath and exhaust', items: [
      ['exhaust', 'Exhaust system and mountings', 40],
      ['clutch', 'Clutch / gearbox operation', 40],
      ['smoke', 'Exhaust smoke / emissions', 60],
      ['fuel', 'Fuel lines and tank', 60],
      ['gbleaks', 'Gearbox and diff leaks', 60],
      ['corrosion', 'Underbody corrosion and undertrays', 60]
    ] },
    { id: 'body', name: 'Body and interior', items: [
      ['screen', 'Windscreen chips and cracks', 20],
      ['seatbelts', 'Seatbelts', 20],
      ['plates', 'Number plates', 20],
      ['mirrors', 'Mirrors (glass and housings)', 40],
      ['doors', 'Doors, locks and boot', 60],
      ['bodywork', 'Bodywork damage', 60],
      ['roadtest', 'Road test', 40]
    ] }
  ].map(s => ({ id: s.id, name: s.name,
    items: s.items.map(([id, name, level, m]) => ({ id, name, level, m: m || null, section: s.id })) }));

  const ALL = SECTIONS.reduce((a, s) => a.concat(s.items), []);
  const LEVELS = [20, 40, 60];
  const RAGS = ['green', 'amber', 'red', 'na'];
  const RAG_LABEL = { green: 'OK', amber: 'Advisory', red: 'Urgent', na: 'N/A' };
  const RANK = { green: 0, na: 0, amber: 1, red: 2 };

  // Thresholds — the mechanic sees these on the screen
  const TREAD = { red: 1.6, amber: 3 };  // mm: under 1.6 illegal, under 3 advise
  const PAD = { red: 3, amber: 5 };      // mm: 3 or less urgent, 5 or less advise

  const itemsFor = level => ALL.filter(i => i.level <= Number(level));
  const sectionsFor = level => SECTIONS.map(s => Object.assign({}, s, { items: s.items.filter(i => i.level <= Number(level)) })).filter(s => s.items.length);
  const itemById = id => ALL.find(i => i.id === id) || null;

  const num = v => { if (v === '' || v == null) return null; const n = parseFloat(String(v).replace(',', '.')); return isFinite(n) ? n : null; };

  // Colour a reading would give. For tyres the worst of the readings counts.
  function ragFromReading(m, reading) {
    if (!m || !reading) return null;
    const vals = (m === 'tread' ? [reading.inner, reading.mid, reading.outer] : [reading.inner, reading.outer]).map(num).filter(v => v != null);
    if (!vals.length) return null;
    const low = Math.min.apply(null, vals);
    const t = m === 'tread' ? TREAD : PAD;
    if (m === 'tread') return low < t.red ? 'red' : low < t.amber ? 'amber' : 'green';
    return low <= t.red ? 'red' : low <= t.amber ? 'amber' : 'green';
  }
  const worse = (a, b) => (RANK[a] || 0) >= (RANK[b] || 0) ? a : b;

  // The colour actually saved: the reading sets the floor.
  function effectiveRag(item, entry) {
    entry = entry || {};
    const fromReading = ragFromReading(item.m, entry.reading);
    if (!entry.rag) return fromReading;
    if (entry.rag === 'na' || !fromReading) return entry.rag;
    return worse(entry.rag, fromReading);
  }

  function problems(hc) {
    const out = [];
    if (!hc || !hc.level) return [{ id: null, why: 'No check level chosen' }];
    const items = hc.items || {};
    itemsFor(hc.level).forEach(it => {
      const e = items[it.id] || {};
      const rag = effectiveRag(it, e);
      if (!rag) { out.push({ id: it.id, why: 'Not checked yet' }); return; }
      const note = String(e.note || '').trim();
      const photos = (e.photos || []).length;
      if (rag === 'red' && !note) out.push({ id: it.id, why: 'Urgent item needs a note' });
      if (rag === 'red' && !photos) out.push({ id: it.id, why: 'Urgent item needs a photo' });
      if (rag === 'amber' && !note) out.push({ id: it.id, why: 'Advisory needs a note' });
      if (it.m && rag !== 'na' && !ragFromReading(it.m, e.reading)) out.push({ id: it.id, why: 'Measurement missing (mm)' });
    });
    if (!num(hc.mileage)) out.push({ id: null, why: 'Mileage not entered' });
    return out;
  }

  function summary(hc) {
    const s = { green: 0, amber: 0, red: 0, na: 0, todo: 0, total: 0, photos: 0 };
    if (!hc || !hc.level) return s;
    itemsFor(hc.level).forEach(it => {
      const e = (hc.items || {})[it.id] || {};
      const r = effectiveRag(it, e);
      s.total++; if (r) s[r]++; else s.todo++;
      s.photos += (e.photos || []).length;
    });
    return s;
  }

  // Red and amber items, worst first — what the adviser needs to sell
  function findings(hc) {
    if (!hc || !hc.level) return [];
    return itemsFor(hc.level).map(it => {
      const e = (hc.items || {})[it.id] || {};
      return { item: it, entry: e, rag: effectiveRag(it, e) };
    }).filter(f => f.rag === 'red' || f.rag === 'amber')
      .sort((a, b) => RANK[b.rag] - RANK[a.rag]);
  }

  function readingText(item, entry) {
    const r = (entry || {}).reading; if (!item.m || !r) return '';
    const parts = item.m === 'tread' ? [['in', r.inner], ['mid', r.mid], ['out', r.outer]] : [['inner', r.inner], ['outer', r.outer]];
    const shown = parts.filter(p => num(p[1]) != null).map(p => num(p[1]) + 'mm ' + p[0]);
    return shown.join(' · ');
  }

  // Plain-text summary the adviser can paste into WhatsApp
  function customerText(hc, job) {
    const f = findings(hc), s = summary(hc);
    const lines = [];
    lines.push('KITH Cars — ' + hc.level + '-point health check' + (job && job.reg ? ' for ' + job.reg : ''));
    lines.push(s.green + ' items OK · ' + s.amber + ' advisory · ' + s.red + ' urgent');
    const red = f.filter(x => x.rag === 'red'), amber = f.filter(x => x.rag === 'amber');
    if (red.length) { lines.push(''); lines.push('Needs doing now:'); red.forEach(x => lines.push('• ' + x.item.name + (x.entry.note ? ' — ' + x.entry.note : '') + (readingText(x.item, x.entry) ? ' (' + readingText(x.item, x.entry) + ')' : ''))); }
    if (amber.length) { lines.push(''); lines.push('Keep an eye on:'); amber.forEach(x => lines.push('• ' + x.item.name + (x.entry.note ? ' — ' + x.entry.note : '') + (readingText(x.item, x.entry) ? ' (' + readingText(x.item, x.entry) + ')' : ''))); }
    if (!red.length && !amber.length) { lines.push(''); lines.push('Everything we checked is in good order.'); }
    return lines.join('\n');
  }

  function ts(d) {
    return (d || new Date()).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  // Same folder name the CRM uses for a job's files
  const jobFolder = j => String(j.tmJob || j.reg || j.id).replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  const clone = o => JSON.parse(JSON.stringify(o));

  // Change one job row safely: re-read it, apply only this change, write it
  // back only if nobody else wrote in between (same rule as the Parts app).
  async function updateRow(cfg) {
    const f = cfg.fetch || fetch;
    const base = cfg.url.replace(/\/$/, '') + '/rest/v1/jobs';
    const H = { apikey: cfg.key, Authorization: 'Bearer ' + cfg.key, 'Content-Type': 'application/json' };
    for (let attempt = 0; attempt < 6; attempt++) {
      const g = await f(base + '?id=eq.' + encodeURIComponent(cfg.rowId) + '&select=data,updated_at', { headers: H });
      if (!g.ok) throw new Error('Could not read the job (' + g.status + ')');
      const row = (await g.json())[0];
      if (!row) throw new Error('This job is not in the CRM any more.');
      const next = cfg.mutate(clone(row.data));
      if (!next) return { data: row.data, changed: false };
      const stamp = new Date().toISOString();
      next.updatedAt = stamp;
      const cond = row.updated_at == null ? 'updated_at=is.null' : 'updated_at=eq.' + encodeURIComponent(row.updated_at);
      const r = await f(base + '?id=eq.' + encodeURIComponent(cfg.rowId) + '&' + cond, { method: 'PATCH',
        headers: Object.assign({}, H, { Prefer: 'return=representation' }), body: JSON.stringify({ data: next, updated_at: stamp }) });
      if (!r.ok) throw new Error('Save failed (' + r.status + ')');
      const back = await r.json();
      if (Array.isArray(back) && back.length) return { data: back[0].data, changed: true };
    }
    throw new Error('Too many people saving this job at once — try again.');
  }

  // Merge the phone's copy of the check into the server's copy, item by
  // item, so two mechanics on one car (or an adviser decision) don't wipe
  // each other out. The newer edit of each item wins.
  function mergeHC(server, local) {
    if (!server) return clone(local);
    if (!local) return clone(server);
    const out = Object.assign({}, server, local);
    out.items = Object.assign({}, server.items || {});
    Object.keys(local.items || {}).forEach(k => {
      const a = (server.items || {})[k], b = local.items[k];
      if (!a || (b.t || 0) >= (a.t || 0)) {
        const photos = {};
        (a && a.photos || []).concat(b.photos || []).forEach(p => { photos[p.url] = p; });
        out.items[k] = Object.assign({}, a || {}, b, { photos: Object.values(photos).filter(p => !(b.removed || []).includes(p.url)) });
        // adviser decisions live on the server copy unless this phone made one
        if (a && a.decision && !('decision' in b)) out.items[k].decision = a.decision;
      }
    });
    out.level = Math.max(Number(server.level) || 0, Number(local.level) || 0) || local.level;
    return out;
  }

  return { VERSION, SECTIONS, ALL, LEVELS, RAGS, RAG_LABEL, TREAD, PAD, itemsFor, sectionsFor, itemById,
    ragFromReading, effectiveRag, problems, summary, findings, readingText, customerText, ts, jobFolder, updateRow, mergeHC, clone };
});
