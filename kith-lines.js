/* KITH service lines — what kind of work is this, and how is each line doing.
 *
 *   Mechanical   Repairs · Servicing · MOT
 *   Tyres        tyres, punctures, balancing, alignment, TPMS
 *   Tuning       remaps, induction, lowering, air ride, body kits
 *   Exhaust      systems, back boxes, downpipes, cats, manifolds
 *   Bodywork     panels, paint, dents, accident repair
 *
 * A job is put in a line from what the work says, unless somebody has set the
 * line by hand (j.line), which always wins. Everything the dashboard shows is
 * worked out here, so the numbers are testable without a browser.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.KITHLines = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const VERSION = '1.0';

  const LINES = [
    { k: 'mechanical', label: 'Mechanical', subs: [
      { k: 'repairs', label: 'Repairs' },
      { k: 'servicing', label: 'Servicing' },
      { k: 'mot', label: 'MOT' }
    ] },
    { k: 'tyres', label: 'Tyres', subs: [] },
    { k: 'tuning', label: 'Tuning', subs: [] },
    { k: 'exhaust', label: 'Exhaust', subs: [] },
    { k: 'bodywork', label: 'Bodywork', subs: [] }
  ];
  const LINE_KEYS = LINES.map(l => l.k);
  const lineLabel = k => (LINES.find(l => l.k === k) || { label: k }).label;
  function subLabel(line, sub) {
    const L = LINES.find(l => l.k === line);
    const s = L && (L.subs || []).find(x => x.k === sub);
    return s ? s.label : lineLabel(line);
  }

  // Read in this order — the first that matches wins.
  const RULES = [
    ['bodywork', /body ?work|\bpanel\b|bumper|\bwing\b|door skin|respray|\bpaint|dent|scratch|scuff|arch\b|quarter|bonnet|tailgate|sill\b|accident|crash|blend|filler|primer|insurance repair/i],
    ['tuning', /remap|re-map|\bstage ?[12]\b|tuning|\btune\b|\becu\b|dyno|induction|performance upgrade|turbo upgrade|coilover|lowering|air ride|air suspension|body kit|bodykit|spacer/i],
    ['exhaust', /exhaust|back ?box|downpipe|de-?cat\b|decat|resonator|tail ?pipe|silencer|cat ?back|catalytic|\bcat converter\b/i],
    ['tyres', /\btyres?\b|\btires?\b|puncture|wheel balanc|balancing|alignment|tracking\b|\btpms\b|wheel refurb|valve stem/i],
    ['mot', /\bmot\b|m\.o\.t|mot test|mot retest/i],
    ['servicing', /\bservice\b|servicing|oil change|oil and filter|interim|major service|full service|air filter|cabin filter|pollen filter|spark plugs?\b|fluid change/i]
  ];
  function classify(job) {
    const set = String((job && job.line) || '').toLowerCase();
    if (set) {
      if (LINE_KEYS.includes(set)) return { line: set, sub: set === 'mechanical' ? (job.sub || 'repairs') : set, by: 'set' };
      if (['repairs', 'servicing', 'mot'].includes(set)) return { line: 'mechanical', sub: set, by: 'set' };
    }
    const txt = [job && job.work, job && job.notes, job && job.enquiry].filter(Boolean).join(' · ');
    for (const [k, re] of RULES) {
      if (!re.test(txt)) continue;
      if (k === 'mot' || k === 'servicing') return { line: 'mechanical', sub: k, by: 'words' };
      return { line: k, sub: k, by: 'words' };
    }
    return { line: 'mechanical', sub: 'repairs', by: 'default' };
  }

  // ── where a job got to ──────────────────────────────────────────
  const LOST = ['lost', 'disapproved'];
  // Approved and going ahead, or already done and paid
  const WON = ['booked', 'po', 'raised', 'so', 'soraised', 'checkin', 'authwait', 'inprog', 'done', 'accounts', 'receivable', 'review', 'followup'];
  // A price has been put in front of the customer
  const QUOTED = ['signoff', 'contact', 'contacted', 'waiting', 'waiting2', 'ready'].concat(WON);
  const isLost = j => LOST.includes(j && j.stage);
  const isWon = j => !isLost(j) && (WON.includes(j && j.stage) || !!(j && j.estApproved && j.stage !== 'lost'));
  const isQuoted = j => QUOTED.includes(j && j.stage) || isWon(j) || (j && j.stage === 'disapproved');
  const num = v => { const n = parseFloat(v); return isFinite(n) ? n : 0; };
  const money = n => Math.round(n * 100) / 100;

  // ── weeks ───────────────────────────────────────────────────────
  const DAY = 86400000;
  function monday(d) {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
    return x;
  }
  const iso = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  const weekKey = t => iso(monday(new Date(t)));
  function weekLabel(key, now) {
    const d = new Date(key + 'T00:00:00');
    const thisWeek = iso(monday(now || new Date()));
    if (key === thisWeek) return 'This week';
    if (key === iso(new Date(monday(now || new Date()) - 7 * DAY))) return 'Last week';
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  }
  function weeksBack(n, now) {
    const start = monday(now || new Date());
    const out = [];
    for (let i = n - 1; i >= 0; i--) out.push(iso(new Date(start - i * 7 * DAY)));
    return out;
  }
  // When the enquiry came in
  function cameIn(j) {
    if (!j) return 0;
    if (j.createdAt) { const t = Date.parse(j.createdAt); if (!isNaN(t)) return t; }
    if (j.enquiredAt) { const t = Date.parse(j.enquiredAt); if (!isNaN(t)) return t; }
    const m = String(j.id || '').match(/^J(\d{13})/);      // ids carry the moment they were made
    if (m) return +m[1];
    return j.stageAt || 0;
  }

  const blank = () => ({ in: 0, quoted: 0, won: 0, lost: 0, open: 0, quotedValue: 0, wonValue: 0 });
  function addTo(row, j) {
    row.in++;
    const q = num(j.quote) || num(j.finalEst);
    if (isQuoted(j)) { row.quoted++; row.quotedValue = money(row.quotedValue + q); }
    if (isWon(j)) { row.won++; row.wonValue = money(row.wonValue + q); }
    else if (isLost(j)) row.lost++;
    else row.open++;
    return row;
  }
  const pct = (a, b) => b ? Math.round(a / b * 1000) / 10 : null;
  function finish(row) {
    row.conv = pct(row.won, row.won + row.lost);      // of the ones that were decided
    row.convAll = pct(row.won, row.in);               // of everything that came in
    row.avgWon = row.won ? money(row.wonValue / row.won) : 0;
    row.avgQuote = row.quoted ? money(row.quotedValue / row.quoted) : 0;
    return row;
  }

  // The whole dashboard in one object.
  //   weeks: how many weeks back (this week counts as one)
  function summarise(jobs, opts) {
    opts = opts || {};
    const now = opts.now ? new Date(opts.now) : new Date();
    const n = opts.weeks || 8;
    const keys = weeksBack(n, now);
    const from = Date.parse(keys[0] + 'T00:00:00');
    const lines = {}, byWeek = {}, subs = {};
    LINE_KEYS.forEach(k => {
      lines[k] = blank(); byWeek[k] = {}; keys.forEach(w => { byWeek[k][w] = blank(); });
    });
    const total = blank(), totalByWeek = {};
    keys.forEach(w => { totalByWeek[w] = blank(); });
    const skipped = [];
    (jobs || []).forEach(j => {
      if (!j || !j.id || String(j.id).indexOf('__') === 0 || j.mergedInto) return;
      const t = cameIn(j);
      if (!t || t < from) return;
      const w = weekKey(t);
      if (!(w in totalByWeek)) return;                 // in the future, or outside the window
      const c = classify(j);
      addTo(lines[c.line], j); addTo(byWeek[c.line][w], j); addTo(total, j); addTo(totalByWeek[w], j);
      const sk = c.line + '/' + c.sub;
      addTo(subs[sk] = subs[sk] || blank(), j);
      if (c.by === 'default' && !String(j.work || '').trim()) skipped.push(j.id);
    });
    LINE_KEYS.forEach(k => { finish(lines[k]); keys.forEach(w => finish(byWeek[k][w])); });
    keys.forEach(w => finish(totalByWeek[w]));
    finish(total);
    Object.keys(subs).forEach(k => finish(subs[k]));
    return { weeks: keys, lines, byWeek, subs, total, totalByWeek, now: now.getTime(), noWork: skipped.length };
  }

  // This week against the one before, for the tiles
  function trend(sum, key) {
    const w = sum.weeks, a = sum.totalByWeek[w[w.length - 1]], b = sum.totalByWeek[w[w.length - 2]];
    if (!b) return null;
    const x = a[key], y = b[key];
    if (!y) return x ? { up: true, pct: null, from: y, to: x } : null;
    return { up: x >= y, pct: Math.round((x - y) / y * 100), from: y, to: x };
  }
  // The jobs behind a number, so a figure can always be opened up
  function jobsIn(jobs, opts) {
    opts = opts || {};
    const s = summarise([], { weeks: opts.weeks || 8, now: opts.now });
    const from = Date.parse(s.weeks[0] + 'T00:00:00');
    return (jobs || []).filter(j => {
      if (!j || !j.id || String(j.id).indexOf('__') === 0 || j.mergedInto) return false;
      const t = cameIn(j);
      if (!t || t < from) return false;
      if (opts.week && weekKey(t) !== opts.week) return false;
      const c = classify(j);
      if (opts.line && c.line !== opts.line) return false;
      if (opts.sub && c.sub !== opts.sub) return false;
      if (opts.state === 'won' && !isWon(j)) return false;
      if (opts.state === 'lost' && !isLost(j)) return false;
      if (opts.state === 'open' && (isWon(j) || isLost(j))) return false;
      return true;
    }).sort((a, b) => cameIn(b) - cameIn(a));
  }

  return {
    VERSION, LINES, LINE_KEYS, lineLabel, subLabel, classify, RULES,
    isWon, isLost, isQuoted, WON, LOST, QUOTED,
    monday, iso, weekKey, weekLabel, weeksBack, cameIn,
    summarise, trend, jobsIn, pct
  };
});
