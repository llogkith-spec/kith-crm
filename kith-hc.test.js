// node kith-hc.test.js
const H = require('./kith-hc.js');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL', m); } };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), m + ' — got ' + JSON.stringify(a) + ' want ' + JSON.stringify(b));

// Levels are exactly 20 / 40 / 60 and nested
eq(H.LEVELS.map(l => H.itemsFor(l).length), [20, 40, 60], 'level sizes');
const ids = H.ALL.map(i => i.id);
ok(new Set(ids).size === ids.length, 'unique ids');
ok(H.itemsFor(20).every(i => H.itemsFor(40).includes(i)) && H.itemsFor(40).every(i => H.itemsFor(60).includes(i)), '20 ⊂ 40 ⊂ 60');
['tyre_fl', 'tyre_fr', 'tyre_rl', 'tyre_rr', 'pads_f', 'pads_r'].forEach(id => ok(H.itemById(id).level === 20, id + ' in the 20'));
ok(!H.ALL.some(i => /nearside|offside|\bns[fr]\b|\bos[fr]\b/i.test(i.name)), 'no nearside/offside wording');

// Tread: under 1.6 red, under 3 amber; worst groove counts
eq(H.ragFromReading('tread', { inner: 1.5, mid: 4, outer: 4 }), 'red', 'tread 1.5 inner');
eq(H.ragFromReading('tread', { inner: 1.6, mid: 4, outer: 4 }), 'amber', 'tread exactly 1.6 is legal');
eq(H.ragFromReading('tread', { inner: 2.9 }), 'amber', 'tread 2.9');
eq(H.ragFromReading('tread', { inner: 3, mid: 3, outer: 3 }), 'green', 'tread exactly 3');
eq(H.ragFromReading('tread', { inner: '2,5' }), 'amber', 'comma decimal');
eq(H.ragFromReading('tread', {}), null, 'no reading');
// Pads: 3 or less red, 5 or less amber
eq(H.ragFromReading('pad', { inner: 3, outer: 8 }), 'red', 'pad 3');
eq(H.ragFromReading('pad', { inner: 5, outer: 8 }), 'amber', 'pad 5');
eq(H.ragFromReading('pad', { inner: 5.1, outer: 9 }), 'green', 'pad 5.1');

// Reading sets the floor: mechanic can go worse, never better
const tyre = H.itemById('tyre_fl');
eq(H.effectiveRag(tyre, { rag: 'green', reading: { inner: 1.2 } }), 'red', 'green tapped but reading red');
eq(H.effectiveRag(tyre, { rag: 'red', reading: { inner: 6, mid: 6, outer: 6 } }), 'red', 'mechanic may go worse');
eq(H.effectiveRag(tyre, { reading: { inner: 2 } }), 'amber', 'reading alone gives a colour');
eq(H.effectiveRag(tyre, { rag: 'na', reading: { inner: 1 } }), 'na', 'N/A stays N/A');
eq(H.effectiveRag(H.itemById('oil'), {}), null, 'untouched');

// Problems block sending
const base = () => ({ level: 20, mileage: '84210', items: {} });
const fillGreen = hc => { H.itemsFor(hc.level).forEach(i => { hc.items[i.id] = i.m ? { reading: i.m === 'tread' ? { inner: 6, mid: 6, outer: 6 } : { inner: 9, outer: 9 } } : { rag: 'green' }; }); return hc; };
let hc = fillGreen(base());
eq(H.problems(hc), [], 'all green 20 has no problems');
hc.mileage = ''; ok(H.problems(hc).some(p => /Mileage/.test(p.why)), 'mileage required');
hc = fillGreen(base()); hc.items.oil = { rag: 'red' };
eq(H.problems(hc).filter(p => p.id === 'oil').map(p => p.why), ['Urgent item needs a note', 'Urgent item needs a photo'], 'red needs note and photo');
hc.items.oil = { rag: 'red', note: 'Very low', photos: [{ url: 'x' }] }; eq(H.problems(hc), [], 'red with note and photo ok');
hc.items.wipers = { rag: 'amber' }; ok(H.problems(hc).some(p => p.id === 'wipers' && /note/.test(p.why)), 'amber needs note');
hc = fillGreen(base()); hc.items.tyre_fl = { rag: 'green' }; ok(H.problems(hc).some(p => p.id === 'tyre_fl' && /Measurement/.test(p.why)), 'tyre needs mm');
hc.items.tyre_fl = { rag: 'na' }; ok(!H.problems(hc).some(p => p.id === 'tyre_fl'), 'N/A tyre (e.g. no spare) needs no mm');
hc = fillGreen(base()); hc.level = 40; ok(H.problems(hc).length === 20, 'upgrade to 40 leaves the new 20 to do');

// Summary + findings
hc = fillGreen(base()); hc.items.screen = { rag: 'amber', note: 'chip' }; hc.items.tyre_rr = { reading: { inner: 1 }, note: 'cord', photos: [{ url: 'a' }, { url: 'b' }] };
const s = H.summary(hc);
eq([s.green, s.amber, s.red, s.todo, s.total, s.photos], [18, 1, 1, 0, 20, 2], 'summary');
eq(H.findings(hc).map(f => f.item.id), ['tyre_rr', 'screen'], 'findings worst first');
const txt = H.customerText(hc, { reg: 'AB12 CDE' });
ok(/AB12 CDE/.test(txt) && /Needs doing now:\n• Tyre — rear right — cord \(1mm in\)/.test(txt) && /Keep an eye on:/.test(txt), 'customer text');
ok(/good order/.test(H.customerText(fillGreen(base()), {})), 'all-clear text');

// Merge: newer item edit wins, other items kept, photos unioned, removals stick
const server = { level: 20, items: { oil: { rag: 'green', t: 10 }, screen: { rag: 'amber', note: 'x', t: 50, photos: [{ url: 'p1' }], decision: { d: 'yes' } } } };
const local = { level: 20, items: { oil: { rag: 'red', t: 20, note: 'leak' }, screen: { rag: 'amber', note: 'x2', t: 60, photos: [{ url: 'p2' }] } } };
let m = H.mergeHC(server, local);
eq(m.items.oil.rag, 'red', 'newer local wins');
eq(m.items.screen.photos.map(p => p.url).sort(), ['p1', 'p2'], 'photos unioned');
eq(m.items.screen.decision, { d: 'yes' }, 'adviser decision survives a mechanic edit');
m = H.mergeHC(server, { items: { oil: { rag: 'amber', t: 5 } } });
eq(m.items.oil.rag, 'green', 'older local loses');
m = H.mergeHC(server, { items: { screen: { rag: 'amber', t: 70, photos: [], removed: ['p1'] } } });
eq(m.items.screen.photos, [], 'removed photo stays removed');
m = H.mergeHC(server, { items: { screen: { rag: 'amber', t: 70, decision: null } } });
eq(m.items.screen.decision, null, 'adviser can clear a decision');
m = H.mergeHC({ level: 60, items: {} }, { level: 20, items: {} });
eq(m.level, 60, 'level never goes down in a merge');
eq(H.jobFolder({ reg: 'ab12 cde' }), 'AB12CDE', 'folder matches CRM');
eq(H.jobFolder({ reg: 'ab12 cde', tmJob: '4411' }), '4411', 'folder prefers TM job number like CRM');

console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
