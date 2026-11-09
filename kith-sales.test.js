/* Tests for kith-sales.js — run with: node kith-sales.test.js */
'use strict';
const S = require('./kith-sales.js');
let pass = 0, fail = 0;
const ok = (c, n) => { if (c) pass++; else { fail++; console.log('✗ ' + n); } };
const eq = (a, b, n) => ok(JSON.stringify(a) === JSON.stringify(b), n + ' — got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b));
const DAY = 864e5;
const NOW = Date.parse('2026-10-14T10:00:00Z');        // a Wednesday, 11am UK
const J = (o) => Object.assign({ stage: 'done', quote: 200, custType: 'Retail' }, o);

/* ---------------- building customers ---------------- */
const jobs = [
  J({ id: 'J1', name: 'Dave Smith', phone: '07700 900123', email: 'dave@x.com', reg: 'LV16XKT', make: 'Ford', model: 'Focus', work: 'MOT and full service', completedAt: NOW - 340 * DAY, quote: 260 }),
  J({ id: 'J2', name: 'Dave', phone: '+447700900123', reg: 'LV16XKT', work: 'Front brakes', completedAt: NOW - 100 * DAY, quote: 210 }),
  J({ id: 'J3', name: 'Amy', email: 'AMY@Y.COM', reg: 'AB12CDE', work: 'Clutch', stage: 'lost', createdAt: new Date(NOW - 30 * DAY).toISOString(), quote: 600 }),
  J({ id: 'J4', name: 'AA Guy', phone: '07700900444', reg: 'AA11AAA', work: 'Battery', custType: 'AA', completedAt: NOW - 50 * DAY }),
  J({ id: 'J5', name: 'Fleet Co', phone: '07700900555', email: 'ops@fleetco.co.uk', reg: 'FL22EET', work: 'Service', custType: 'Fleet', completedAt: NOW - 20 * DAY }),
  J({ id: 'J6', name: 'Old Timer', phone: '07700900666', reg: 'OL15OLD', work: 'Timing belt', completedAt: NOW - 400 * DAY, marketingOptIn: true }),
  J({ id: '__pos__' }), J({ id: 'J7', name: 'Merged', phone: '07700900777', mergedInto: 'J1' })
];
const leads = [
  { id: 'L1', source: 'whatsapp', from: { name: 'Zoe', phone: '07700900888' }, reg: 'ZO19ZOE', ts: NOW - 20 * DAY, status: 'closed', closed: true, closedWhy: 'Said no to the range', closedAt: NOW - 16 * DAY,
    range: { low: 100, high: 150 }, msgs: [{ dir: 'in', text: 'brakes', ts: NOW - 20 * DAY, channel: 'whatsapp' }] },
  { id: 'L2', source: 'webform', from: { name: 'Dave S', email: 'dave@x.com' }, ts: NOW - 5 * DAY, msgs: [{ dir: 'in', text: 'hi', ts: NOW - 5 * DAY }] },
  { id: 'L3', source: 'instagram', from: { handle: '999' }, ts: NOW, msgs: [] }
];
const accounts = [{ id: 'A1', company: 'Acme Plumbing Ltd', contacts: [{ name: 'Pat', email: 'pat@acme.co.uk' }] },
                  { id: 'A2', company: 'Bob the Builder', contacts: [{ name: 'Bob', email: 'bob@bob.com', phone: '07700900999' }] }];
let C = S.buildContacts({ jobs, leads, accounts }, NOW);
const by = k => C.find(c => c.key === k || c.phones.includes(k) || c.emails.includes(k));
const dave = by('447700900123');
ok(dave, 'Dave found');
eq([dave.jobs.length, dave.leads.length, dave.cars.length], [2, 1, 1], 'Dave: phone and email records joined (2 jobs, the web enquiry, one car)');
eq(dave.name, 'Dave S', 'latest name wins (his web enquiry)');
eq(dave.spent, 470, 'spent adds up won jobs');
ok(dave.lastMot === NOW - 340 * DAY && Math.round((dave.motDue - NOW) / DAY) === 25, 'MOT due a year after the one we did');
ok(Math.round((dave.serviceDue - NOW) / DAY) === 25, 'service due a year on');
eq(dave.car.make, 'Ford', 'make kept from the job that had it');
ok(!C.some(c => c.name === 'Merged'), 'merged and system rows left out');
ok(!C.some(c => c.leads.some(l => l.id === 'L3')), 'a lead with no number or email is not a contact');
const amy = by('amy@y.com'); ok(amy && !amy.isCustomer && amy.askedPrice, 'Amy: lost quote — not a customer, but asked for a price');

/* ---------------- who may be messaged ---------------- */
const A = (c, ch, set) => S.allowed(c, ch, set);
ok(A(dave, 'email').ok && A(dave, 'sms').ok, 'past customer: email and text on soft opt-in');
ok(!A(dave, 'whatsapp').ok, 'past customer: no WhatsApp marketing without a yes');
ok(!A(dave, 'email', { softOptIn: false }).ok, 'soft opt-in switched off → no');
ok(A(amy, 'email').ok, 'asked for a price → email on soft opt-in');
ok(!A(amy, 'sms').ok && /mobile/.test(A(amy, 'sms').why), 'no mobile → no text');
const aa = by('447700900444');
ok(!A(aa, 'sms').ok && /AA/.test(A(aa, 'sms').why), 'AA customer: their details came from the AA — needs a yes');
const old = by('447700900666');
ok(A(old, 'sms').ok && A(old, 'sms').why === 'Said yes', 'CRM "agreed to reminders" tick counts as a yes');
const zoe = by('447700900888');
ok(A(zoe, 'sms').ok, 'Zoe asked for a price on WhatsApp → texts ok');
ok(!A(zoe, 'whatsapp').ok, 'Zoe: WhatsApp marketing still needs a yes');
const zoe2 = S.buildContacts({ jobs: jobs.concat([J({ id: 'JZ', phone: '07700900888', work: 'brakes', completedAt: NOW - 60 * DAY })]), leads }, NOW).find(c => c.phones.includes('447700900888'));
ok(A(zoe2, 'whatsapp', { waCountsMessaged: true }).ok, 'setting on: a customer who messaged on WhatsApp counts');
const pat = by('pat@acme.co.uk'), bob = by('bob@bob.com');
ok(A(pat, 'email').ok && /Limited company/.test(A(pat, 'email').why), 'cold B2B: Ltd company → email ok');
ok(!A(pat, 'sms').ok, 'cold B2B: no texts');
ok(!A(bob, 'email').ok && /sole trader/i.test(A(bob, 'email').why), 'cold B2B: not a Ltd → needs a yes');
// opt-outs
C = S.buildContacts({ jobs, leads, accounts, prefs: [{ type: 'optout', phone: '07700900123', channels: ['sms'], at: NOW - DAY }, { type: 'optin', email: 'bob@bob.com', channels: ['email'], at: NOW }] }, NOW);
ok(!S.allowed(by('447700900123'), 'sms').ok && S.allowed(by('447700900123'), 'email').ok, 'opted out of texts: still email');
ok(S.allowed(by('bob@bob.com'), 'email').ok, 'Bob said yes → email ok');

/* ---------------- audiences ---------------- */
const camp = { id: 'C1', name: 'Winter check', channels: ['whatsapp', 'sms', 'email'], audience: { segment: 'customers' },
  msg: { sms: { body: 'Hi {first_name}, winter check for {reg}?' }, email: { subject: 'Winter check', body: 'Hi {first_name}, book {reg} in.' } } };
let au = S.audience(C, camp, {}, NOW);
ok(au.reach.length >= 3, 'customers reached: ' + au.reach.length);
eq(au.reach.find(x => x.c === by('447700900123')).channel, 'email', 'Dave opted out of texts → email instead');
ok(au.reach.find(x => x.c === by('447700900666')).channel === 'sms', 'text before email when allowed');
ok(au.skipped.some(x => x.c === by('447700900444')), 'AA customer skipped');
ok(Object.keys(au.reasons).length > 0, 'reasons counted for the skipped');
eq(S.audience(C, Object.assign({}, camp, { audience: { segment: 'motSoon' } }), {}, NOW).reach.length, 1, 'MOT due segment');
eq(S.audience(C, Object.assign({}, camp, { audience: { segment: 'lapsed' } }), {}, NOW).reach.map(x => x.c.name), ['Old Timer'], 'lapsed segment');
eq(S.audience(C, Object.assign({}, camp, { audience: { segment: 'customers', kind: 'brakes-front' } }), {}, NOW).reach.length, 1, 'filter by work done');

/* ---------------- messages ---------------- */
const r = S.render(camp, 0, by('447700900666'), 'sms', {});
ok(/^Hi Old, winter check for OL15OLD\?/.test(r.text) && /Reply STOP to opt out/.test(r.text), 'text filled in, STOP added');
const e = S.render(camp, 0, by('447700900123'), 'email', {});
ok(/Kith Cars Ltd/.test(e.text) && /UNSUBSCRIBE/.test(e.text) && /Hackbridge/.test(e.text), 'email carries who we are and how to stop');
const noname = S.buildContacts({ jobs: [J({ id: 'X', phone: '07700900321', work: 'mot', completedAt: NOW })] }, NOW)[0];
ok(/^Hi there, winter check for your car/.test(S.render(camp, 0, noname, 'sms', {}).text), 'blanks fall back gently');
eq(S.badFields('Hi {first_name} {frist_name}'), ['frist_name'], 'typo in a field spotted');
eq(S.smsParts('x'.repeat(160)), 1, '160 characters is one text'); eq(S.smsParts('x'.repeat(161)), 2, '161 is two');

/* ---------------- hours ---------------- */
const sunday = Date.parse('2026-10-18T10:00:00Z');
eq(new Date(S.nextSlot(sunday)).toISOString(), '2026-10-19T08:00:00.000Z', 'Sunday → Monday 9am UK (BST)');
eq(new Date(S.nextSlot(Date.parse('2026-11-02T19:30:00Z'))).toISOString(), '2026-11-03T09:00:00.000Z', 'Monday 7:30pm → Tuesday 9am UK (GMT)');
eq(new Date(S.nextSlot(Date.parse('2026-10-17T16:30:00Z'))).toISOString(), '2026-10-19T08:00:00.000Z', 'Saturday 5:30pm → Monday');
ok(S.inHours(NOW), 'Wednesday 11am is in hours');

/* ---------------- plan, ids and sending checks ---------------- */
const pl = S.plan(C, camp, {}, NOW);
ok(pl.sends.length === pl.audience.reach.length && pl.sends.every(x => x.status === 'queued'), 'plan queues one per person');
eq(new Set(pl.sends.map(x => x.id)).size, pl.sends.length, 'ids unique');
eq(S.plan(C, camp, {}, NOW + 5000).sends.map(x => x.id), pl.sends.map(x => x.id), 'same campaign twice → same ids (can\'t double-queue)');
const sd = pl.sends.find(x => x.channel === 'sms');
const cOf = s => C.find(c => c.key === s.contact);
eq(S.check(sd, cOf(sd), {}, NOW).do, 'send', 'due and allowed → send');
eq(S.check(sd, cOf(sd), {}, sunday).do, 'wait', 'Sunday → wait');
eq(S.check(sd, cOf(sd), {}, NOW, { sms: 200 }).do, 'wait', 'cap reached → wait');
const recent = Object.assign({}, cOf(sd), { sends: [{ id: 'other', status: 'sent', sentAt: NOW - 2 * DAY }] });
const w = S.check(sd, recent, {}, NOW);
ok(w.do === 'wait' && w.until >= NOW + 5 * DAY - 3600e3, 'one message a week per person');
const optd = Object.assign({}, cOf(sd), { optOut: { sms: NOW } });
eq(S.check(sd, optd, {}, NOW).do, 'skip', 'opted out after queueing → skipped');

/* ---------------- follow-ups ---------------- */
const seq = Object.assign({}, camp, { id: 'C2', followUps: [{ afterDays: 3, msg: { sms: { body: 'Just checking, {first_name}?' }, email: { subject: 'Re', body: 'Checking in' } } }] });
const first = Object.assign(S.plan(C, seq, {}, NOW).sends.find(x => x.channel === 'sms'), { status: 'sent', sentAt: NOW });
const fu = S.followUp(seq, first, cOf(first), {});
ok(fu && fu.step === 1 && fu.sendAt >= NOW + 3 * DAY && /Just checking/.test(fu.text), 'follow-up queued 3 days on');
ok(!S.followUp(seq, Object.assign({}, fu, { status: 'sent', sentAt: NOW + 3 * DAY }), cOf(first), {}), 'no step after the last');
const replied = Object.assign({}, cOf(first), { sends: [first], leads: [{ lastIn: NOW + DAY }] });
eq(S.check(fu, replied, {}, NOW + 3 * DAY + 3600e3).do, 'skip', 'they replied → follow-up skipped');

/* ---------------- automations ---------------- */
const saved = { motDue: { on: true }, reviewAsk: { on: true }, winBack: { on: true }, lapsed: { on: false } };
const jobs2 = jobs.concat([J({ id: 'J8', name: 'Rev', phone: '07700901111', work: 'Clutch', completedAt: NOW - 3 * DAY })]);
const C2 = S.buildContacts({ jobs: jobs2, leads }, NOW);
const auto = S.runAutomations(C2, saved, {}, NOW, []);
const names = auto.map(x => x.campaign + ':' + x.name).sort();
ok(names.includes('auto_motDue:Dave S'), 'MOT reminder for Dave');
ok(names.includes('auto_reviewAsk:Rev'), 'review ask 3 days after a job');
ok(names.includes('auto_winBack:Zoe'), 'win-back for Zoe who said no 16 days ago');
ok(!names.some(n => n.startsWith('auto_lapsed')), 'switched-off automation sends nothing');
eq(S.runAutomations(C2, saved, {}, NOW + 3600e3, auto.map(x => x.id)).length, 0, 'running again the same day adds nothing');
eq(S.runAutomations(C2, saved, {}, NOW + 3 * DAY, auto.map(x => x.id)).filter(x => x.campaign === 'auto_motDue').length, 0, 'MOT reminder is once per MOT, not daily');
ok(!S.runAutomations(C2, {}, {}, NOW, []).length, 'all automations start off');

/* ---------------- STOP ---------------- */
['STOP', 'stop', 'Unsubscribe', 'opt out', 'please unsubscribe me from your list', 'STOP.'].forEach(t => ok(S.isStop(t), 'stop: ' + t));
['stop by tomorrow?', 'can you stop the squeak', 'the brakes wont stop'].forEach(t => ok(!S.isStop(t), 'not stop: ' + t));

/* ---------------- results ---------------- */
const sends = [Object.assign({}, first)];
const C3 = S.buildContacts({ jobs: jobs.concat([J({ id: 'J9', phone: '07700900666', work: 'Service', stage: 'booked', bookedFor: S.ymd(NOW + 5 * DAY), quote: 180 })]), leads, sends }, NOW);
const res = S.results('C2', sends, C3);
ok(res.sent === 1 && res.booked === (first.contact === C3.find(c => c.phones.includes('447700900666')).key ? 1 : 0), 'booked counted when a job follows the message');

/* ---------------- B2B ---------------- */
const csv = 'Company Name,Contact,Email,Phone,Fleet Size\n"Acme Plumbing Ltd",Pat,pat@acme.co.uk,,12\nNew Vans Limited,Sam,sam@newvans.co.uk,07700901234,30\n"Smith & Sons",Joe,joe@smith.com,,4\n,,,,\n';
const im = S.importAccounts(csv, [{ id: 'A1', company: 'Acme Plumbing Ltd', contacts: [{ name: 'Pat', email: 'pat@acme.co.uk' }] }], 'Logkith');
eq([im.added.length, im.updated.length], [2, 1], 'import: two new, one already there');
eq(im.added.map(a => a.companyType), ['ltd', 'unknown'], 'Limited → ltd; "Smith & Sons" could be a partnership');
eq(im.added[0].fleet, '30', 'fleet size read');
ok(S.importAccounts('foo,bar\n1,2', []).error, 'unknown headers explained');
const fromCrm = S.accountFromB2B({ id: 'B2Bx1', company: 'Paper Pad Ltd', contact: 'Jo', phone: '020 8000 0000', status: 'quoted', notes: 'email jo@pp.co.uk' });
eq([fromCrm.stage, fromCrm.contacts[0].email, fromCrm.companyType], ['quoted', 'jo@pp.co.uk', 'ltd'], 'CRM B2B board row becomes an account');
eq(S.b2bDue([{ stage: 'contacted', nextAt: NOW - DAY }, { stage: 'won', nextAt: NOW - DAY }, { stage: 'quoted', nextAt: NOW + 5 * DAY }], NOW).length, 1, 'tasks due today');

/* ---------------- the review's cases ---------------- */
// 1. AA work as the CRM really stores it
const aaC = S.buildContacts({ jobs: [J({ id: 'X1', name: 'Tow', phone: '07700905555', work: 'Recovery', custType: 'aa_towin', completedAt: NOW - 20 * DAY })] }, NOW)[0];
ok(!S.allowed(aaC, 'sms').ok && !aaC.b2b, 'aa_towin customer: no marketing, not B2B');
ok(!S.buildContacts({ jobs: [J({ id: 'X2', phone: '07700905556', custType: 'aa_fleet', completedAt: NOW })] }, NOW)[0].b2b, 'aa_fleet is not B2B');
// 2. UNSUBSCRIBE as it arrives by email
ok(S.isStopMsg('Subject: Re: MOT due on LV16XKT\nUNSUBSCRIBE\n\nSent from my iPhone', 'email'), 'email: UNSUBSCRIBE under a subject line');
ok(S.isStopMsg('Subject: Unsubscribe\n', 'email'), 'email: unsubscribe in the subject, empty body');
ok(S.isStopMsg('Stop please', 'sms') && S.isStopMsg('STOP thanks', 'sms'), 'text: "Stop please"');
ok(!S.isStopMsg('Subject: Re: brakes\nCan you stop the squeak?', 'email'), 'email about a squeak is not a STOP');
// 4. a shared family email doesn't merge two people, and one's yes isn't the other's
const fam = S.buildContacts({ jobs: [
  J({ id: 'F1', name: 'Alice', phone: '07700900010', email: 'fam@x.com', work: 'Service', completedAt: NOW - 50 * DAY }),
  J({ id: 'F2', name: 'Bob', phone: '07700900020', email: 'fam@x.com', work: 'Battery', custType: 'aa_towin', completedAt: NOW - 40 * DAY })],
  prefs: [{ type: 'optin', phone: '07700900020', channels: ['whatsapp'] }] }, NOW);
eq(fam.length, 2, 'two mobiles sharing an email stay two people');
const alice = fam.find(c => c.name === 'Alice'), bobF = fam.find(c => c.name === 'Bob');
ok(!S.allowed(alice, 'whatsapp').ok, 'Bob\'s WhatsApp yes is not Alice\'s');
ok(!S.allowed(bobF, 'sms').ok, 'Bob (AA) still gets no texts');
eq(S.plan(fam, { id: 'FX', name: 'x', channels: ['email'], audience: { segment: 'all' }, msg: { email: { subject: 'x', body: 'x' } } }, {}, NOW).sends.length, 1, 'shared email gets ONE email');
const famOut = S.buildContacts({ jobs: [J({ id: 'F1', name: 'Alice', phone: '07700900010', email: 'fam@x.com', completedAt: NOW }), J({ id: 'F2', name: 'Bob', phone: '07700900020', email: 'fam@x.com', completedAt: NOW })],
  prefs: [{ type: 'optout', email: 'fam@x.com', channels: ['email', 'sms', 'whatsapp'] }] }, NOW);
ok(famOut.every(c => !S.allowed(c, 'email').ok && !S.allowed(c, 'sms').ok), 'an opt-out from the shared email covers both people');
const joined = S.buildContacts({ jobs: [J({ id: 'G1', name: 'Kim', phone: '07700900030', completedAt: NOW }), J({ id: 'G2', name: 'Kim', email: 'kim@x.com', completedAt: NOW })],
  leads: [{ id: 'G3', from: { phone: '07700900030', email: 'kim@x.com' }, ts: NOW, msgs: [] }] }, NOW);
eq(joined.length, 1, 'phone-only and email-only records join when one enquiry links them');
// 5. the key doesn't change with row order
const rows = [J({ id: 'K1', name: 'Kim', email: 'kim@x.com', work: 'Service', completedAt: NOW - 400 * DAY }), J({ id: 'K2', name: 'Kim', phone: '07700900002', email: 'kim@x.com', work: 'Brakes', completedAt: NOW - 380 * DAY })];
eq(S.buildContacts({ jobs: rows }, NOW)[0].key, S.buildContacts({ jobs: rows.slice().reverse() }, NOW)[0].key, 'same key whichever order the rows come in');
// 7. the MOT reminder names the car that's due
const two = S.buildContacts({ jobs: [J({ id: 'M1', name: 'Two', phone: '07700900040', reg: 'AB12CDE', work: 'MOT', completedAt: NOW - 345 * DAY }),
  J({ id: 'M2', name: 'Two', phone: '07700900040', reg: 'XY70ZZZ', work: 'Brakes', completedAt: NOW - 20 * DAY })] }, NOW);
const m2 = S.runAutomations(two, { motDue: { on: true } }, {}, NOW, []);
ok(m2.length === 1 && /AB12CDE/.test(m2[0].text) && m2[0].reg === 'AB12CDE', 'MOT reminder names the car that\'s due — ' + (m2[0] || {}).text);
// 8. review link never blank
const rv = S.runAutomations(S.buildContacts({ jobs: [J({ id: 'R1', name: 'Rae', phone: '07700900050', work: 'Clutch', completedAt: NOW - 3 * DAY })] }, NOW), { reviewAsk: { on: true } }, {}, NOW, []);
ok(rv[0] && /google\.com\/maps/.test(rv[0].text), 'review request carries the review link by default');
// 9. names with accents
eq(S.firstName('Zoë Smith'), 'Zoë', 'Zoë'); eq(S.firstName('seán'), 'Seán', 'Seán');
// 10. odd rows don't break anything
ok(S.buildContacts({ jobs: [null, { id: 'Q', phone: '07700900060', work: 5 }], leads: [{ id: 'B', from: { phone: '07700900061' }, msgs: {} }], prefs: [{ type: 'optout', phone: '07700900060', channels: 'sms' }] }, NOW).length === 2, 'odd rows are skipped, not fatal');

/* ---------------- the pipeline ---------------- */
const pjobs = [
  { id: 'P1', name: 'Est', stage: 'labour', work: 'Clutch', rangeLow: 500, rangeHigh: 600, stageAt: NOW - 2 * DAY, fromLead: 'PL3' },
  { id: 'P2', name: 'Quo', stage: 'waiting', work: 'Brakes', quote: 240, stageAt: NOW - 5 * DAY },
  { id: 'P3', name: 'Bkd', stage: 'booked', work: 'Service', quote: 200, stageAt: NOW - 3 * DAY },
  { id: 'P4', name: 'Old', stage: 'done', work: 'MOT', quote: 54.85, stageAt: NOW - 90 * DAY },
  { id: 'P5', name: 'Lst', stage: 'lost', work: 'Timing belt', quote: 700, stageAt: NOW - 10 * DAY }
];
const pleads = [
  { id: 'PL1', from: { name: 'New' }, ts: NOW - 3600e3, msgs: [{ dir: 'in', text: 'hi', ts: NOW - 3600e3 }] },
  { id: 'PL2', from: { name: 'Rng' }, ts: NOW - 4 * DAY, range: { low: 100, high: 150 }, bot: { rangeAt: NOW - 3 * DAY }, msgs: [] },
  { id: 'PL3', from: { name: 'Est' }, ts: NOW - 3 * DAY, jobId: 'P1', status: 'converted', msgs: [] },
  { id: 'PL4', from: { name: 'Said no' }, ts: NOW - 20 * DAY, closed: true, closedWhy: 'Said no to the range', closedAt: NOW - 15 * DAY, msgs: [] },
  { id: 'PL5', from: { name: 'Junk' }, ts: NOW - DAY, status: 'junk', msgs: [] }
];
const paccs = [{ id: 'PA1', company: 'Cold Ltd', stage: 'prospect', contacts: [{ name: 'Pat' }], createdAt: NOW - 20 * DAY },
  { id: 'PA2', company: 'Talking Ltd', stage: 'replied', contacts: [], log: [{ t: NOW - DAY }] }, { id: 'PA3', company: 'Gone Ltd', stage: 'lost' }];
const ls = l => l.status === 'junk' || l.closed ? 'closed' : l.jobId ? 'crm' : (l.bot || {}).rangeAt ? 'rangeSent' : 'details';
const pp = S.pipeline({ jobs: pjobs, leads: pleads, accounts: paccs }, ls, NOW);
const where = n => (pp.cards.find(c => c.name === n) || {}).stage;
eq(['Cold Ltd', 'New', 'Talking Ltd', 'Rng', 'Est', 'Quo', 'Bkd'].map(where), ['cold', 'enquiry', 'enquiry', 'range', 'exact', 'quoted', 'booked'], 'each lead on the right rung');
eq(pp.cards.filter(c => c.name === 'Est').length, 1, 'a lead that became a job shows once (as the job)');
ok(!where('Old') && !where('Gone Ltd') && !where('Junk'), 'old bookings, lost accounts and junk left off');
eq(pp.cooled.map(c => c.name).sort(), ['Lst', 'Said no'], 'said no / lost → cooled, for win-back');
eq(pp.byStage.quoted.value, 240, 'value of quotes out'); eq(pp.byStage.exact.value, 550, 'range midpoint used while being estimated');
ok(pp.cards.find(c => c.name === 'Quo').stale && pp.cards.find(c => c.name === 'Rng').stale, 'quote sitting 5 days and range sitting 3 days flagged as going cold');
eq(S.funnel({ leads: pleads, jobs: pjobs }, 30, NOW), { enquiries: 4, ranged: 1, yes: 1, quoted: 0, booked: 0 }, 'funnel for the month');

/* ---------------- a contacted job's messages and chase ---------------- */
const CJ = { id: 'CJ1', name: 'Chase Me', stage: 'waiting', quote: 640, stageAt: NOW - 26 * 3600e3, signedOffAt: NOW - 26 * 3600e3,
  msgOutbox: [{ kind: 'quote', status: 'sent', t: NOW - 26 * 3600e3, sentVia: 'WhatsApp', text: 'Your quote is £640' }],
  chasesSent: JSON.stringify([{ step: 0, label: 'Day 1 · Phone call', at: '14 Oct 2026, 10:00', by: 'Ali' }, { step: 1, label: 'Day 1 · Text if no answer', at: '14 Oct 2026, 13:00', by: 'Ali' }]),
  log: [{ t: '13 Oct 2026, 09:00', s: '✓ Approved at £640 — quote sent [Logkith]' }] };
const act = S.jobActivity(CJ, { outbox: [{ jobId: 'CJ1', kind: 'quote', t: NOW - 26 * 3600e3, status: 'sent' }] }, NOW);
eq(act.messages.filter(m => m.kind === 'quote').length, 1, 'quote shown once, not doubled from the outbox');
eq([act.chase.active, act.chase.done, act.chase.next.label], [true, 2, 'Day 1 · End of day nudge'], 'chase: 2 of 6 done, next is the end-of-day nudge');
ok(act.chase.next.overdue, 'next chase is overdue (due at 8h, it\'s been 26h)');
eq(act.history[0].who, 'Logkith', 'history: who did it pulled out');
const act2 = S.jobActivity(Object.assign({}, CJ, { lastReplyAt: NOW - 3600e3, lastReply: 'yes please' }), {}, NOW);
ok(act2.chase.replied && act2.messages.some(m => m.dir === 'in' && /yes please/.test(m.text)), 'a reply shows and counts');
ok(!S.jobActivity(Object.assign({}, CJ, { saidNo: { at: 'x' } }), {}, NOW).chase.active, 'said no → no more chasing');

/* ---------------- the live inbox's leads ---------------- */
const LIVE = [
  { id: 'LD1', channel: 'website', name: 'Web Wendy', phone: '+447700911111', reg: 'WE11WEB', what: 'clutch slipping', state: 'ready', t: NOW - 2 * 3600e3,
    messages: [{ dir: 'in', channel: 'website', t: NOW - 2 * 3600e3, text: 'clutch slipping' }, { dir: 'out', channel: 'whatsapp', t: NOW - 3600e3, text: 'Range…', status: 'queued', msgId: 'M1-rf' }],
    triage: { category: 'service_adviser', is_rapid_fire: true, rapidFireSentAt: new Date(NOW - 3600e3).toISOString(), rapidFireRange: { lo: 480, hi: 620 } } },
  { id: 'LD2', channel: 'instagram', handle: 'ig_bob', name: 'Bob', what: 'how much for brakes', state: 'new', t: NOW - 600e3, messages: [], triage: { category: 'service_adviser' } },
  { id: 'LD3', channel: 'phone', name: 'Junk', phone: '07700911333', state: 'junk', t: NOW - DAY },
  { id: 'LD4', channel: 'whatsapp', name: 'Jobbed', phone: '07700911444', state: 'job', jobId: 'JX', t: NOW - DAY },
  null
];
const ad = LIVE.map(S.fromLive).filter(Boolean);
eq(ad.length, 4, 'every real live lead adapted');
const wl = ad.find(l => l.id === 'LD1');
eq([wl.source, wl.from.phone, wl.range.low, wl.range.high, !!wl.bot.rangeAt, wl.msgs.length], ['webform', '+447700911111', 480, 620, true, 2], 'website lead: range and messages carried over');
eq(wl.msgs[1].by, 'Triage AI', 'rapid-fire message credited to Triage AI');
eq(ad.map(l => S.liveStage(l, l.jobId ? { stage: 'labour' } : null)), ['rangeSent', 'details', 'closed', 'crm'], 'live stages');
const plv = S.pipeline({ jobs: [{ id: 'JX', name: 'Jobbed', stage: 'labour', leadId: 'LD4', stageAt: NOW }], leads: ad }, l => S.liveStage(l, l.jobId ? { stage: 'labour' } : null), NOW);
eq(plv.cards.map(c => c.name + ':' + c.stage).sort(), ['Bob:enquiry', 'Jobbed:exact', 'Web Wendy:range'], 'live leads on the Pipeline, a lead that became a job shown once');
const cs = S.buildContacts({ jobs: [], leads: ad }, NOW);
ok(cs.some(c => c.phones.includes('447700911111') && c.askedPrice), 'a live lead who got a range counts as having asked for a price');

console.log((fail ? '✗ ' : '✓ ') + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
