/* =============================================================================
   KITH ESTIMATOR — PRICING ENGINE v8.0
   =============================================================================
   The single source of truth for every number KITH quotes.
   No LLM touches arithmetic. The AI layer proposes inputs; this file prices them.

   Ruleset: SOP v8.0 (consolidates v7.6 — retail two-tier rate card, AA customers)
   Works unmodified in Node and in the browser.
   ============================================================================= */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.KITH = factory();
}(typeof self !== 'undefined' ? self : this, function () {
'use strict';

const VERSION = '8.0';

/* ---------------------------------------------------------------- rates ---- */
// Ex VAT. Inc VAT is ex x 1.2 — the owner quotes these inc, so both are shown.
const RATES = { LOW: 50, MED: 60, TOP: 70, BODY: 70 };

/* ------------------------------------------------------------ customers ---- */
// Six customer types. KITH types use the multiplier ladder; AA types never do.
const CUSTOMERS = {
  retail: {
    label: 'Retail / B2C', kind: 'kith', threshold: 2.0,
    tiers: ['LOW', 'TOP'], collapseMed: true,
    note: 'No MED tier. Servicing and brakes are LOW, everything else is TOP.'
  },
  trade: {
    label: 'Trade / B2B', kind: 'kith', threshold: 1.5,
    tiers: ['LOW', 'MED', 'TOP'], collapseMed: false,
    note: 'Gets the MED tier AND the earlier 1.5 hr threshold. Both stack.'
  },
  aa_smart: {
    label: 'AA Smart', kind: 'aa', labourRate: 55, partsPct: 0.15,
    diagRate: null, note: 'Retail customer of the AA network, not of KITH.'
  },
  aa_towin: {
    label: 'AA Tow-in', kind: 'aa', labourRate: 90, partsPct: 0.20,
    diagRate: 33, diagExtendable: true, note: 'Diagnostic hourly, extendable on authorisation.'
  },
  aa_pgc: {
    label: 'AA PGC', kind: 'aa', labourRate: 90, partsPct: null,
    diagFixed: 29.77, note: 'Warranty work. Parts markup NOT SET — escalate.'
  },
  aa_fleet: {
    label: 'AA Fleet', kind: 'aa', labourRate: 44, partsPct: 0.15,
    diagRate: 44, diagAuthMin: 0.3, diagAuthMax: 0.5,
    note: 'Only 0.3-0.5 hr of diagnostic is authorised by the AA.'
  }
};

/* ----------------------------------------------------------- multiplier ---- */
const MULT      = { lower: 2.0,  upper: 1.5  };   // normal
const MULT_RAMP = { lower: 2.5,  upper: 1.75 };   // REPLACES the above, never stacks

// Categories that never step down to the upper multiplier.
const ALWAYS_X2 = ['suspension', 'bearings', 'dpf', 'trackrod'];

/* -------------------------------------------------------------- minimums --- */
const MIN_LABOUR_HOURS = 0.5;                       // per mechanical line
const MIN_EXEMPT = ['bulb', 'tyre', 'wiper'];       // categories with no minimum
const BODY_MIN_CHARGE = 70;                         // per bodywork line, ex VAT

/* ------------------------------------------------------- inspection time --- */
// Minutes. Divided by 60 at full precision — never a rounded decimal.
const INSPECTION_MINUTES = { interim: 12.5, full: 20, major: 30 };

/* ------------------------------------------------------------ parts ladder - */
// Banded PER PART on its own net unit cost. Quantity never bands a part up.
// minSell is applied per part and is what stops the ladder inverting at a band edge.
const LADDER = [
  { from: 0.01,    to: 10,   mult: 2.0, minSell: 0,  markup: '100%' },
  { from: 10.01,   to: 20,   mult: 1.8, minSell: 20, markup: '80%'  },
  { from: 20.01,   to: 30,   mult: 1.6, minSell: 36, markup: '60%'  },
  { from: 30.01,   to: 40,   mult: 1.4, minSell: 48, markup: '40%'  },
  { from: 40.01,   to: 2000, mult: 1.3, minSell: 56, markup: '30%'  }
];
const PARTS_ESCALATE_ABOVE = 2000;

/* --------------------------------------------- fluids: sell prices ex VAT -- */
// These ARE the selling price. They never enter the ladder. One price for everyone.
const FLUIDS = {
  'Budget oil (1L)': 5.50,        'Castrol 5W-30 (1L)': 7.50,
  'Castrol 5W-30 C3 (1L)': 12.50, 'Castrol 0W-30 C2 (1L)': 8.00,
  'Castrol 0W-20 LL (1L)': 10.50, 'Transmission / PAS fluid (1L)': 10.40,
  'Brake & clutch fluid': 8.00,   'Brake cleaner': 4.50,
  'WD-40': 9.00,                  'Cataclean DPF cleaner': 15.00,
  "Wynn's exhaust DPF cleaner": 9.90, 'Coolant (1L)': 5.00,
  'Screenwash': 2.00,             'AdBlue (1L)': 2.50,
  'Bulb': 8.00,                   'Wiper blade - front': 7.00,
  'Wiper blade - rear': 5.00
};

/* ------------------------------------------------------------ tyres -------- */
const TYRE_FIT_EACH = 20;   // ex VAT, flat, per tyre. No multiplier, no minimum.

/* -------------------------------------------------------- fixed prices ----- */
const MOT = { 4: 50, 5: 58, 7: 58 };   // OUTSIDE the scope of VAT
const DIAGNOSTICS = {
  'Mechanical diagnostic': 60, 'Oil and coolant leak diagnostic': 90,
  'Deep diagnostic': 120,      'Electrical diagnostic': 150
};
const INSPECTIONS = {
  '25-point interim health check': { price: 25, incVat: true },
  '40-point full inspection':      { price: 45, incVat: false },
  '60-point / pre-purchase':       { price: 60, incVat: false }
};
const ENGINE_REPLACEMENT = {
  'Up to 1.4L':  { petrol: 900,  diesel: 1050 },
  '1.5 - 2.0L':  { petrol: 1200, diesel: 1450 },
  '2.1 - 3.0L':  { petrol: 1550, diesel: 1850 },
  '3.0L +':      { petrol: 1950, diesel: 2350 }
};
const TUNING = {
  'Stage 1 remap': 250, 'Stage 2 remap': 320, 'Economy remap': 200,
  'Pop & bang (standalone)': 150, 'Pop & bang + Stage 1': 350,
  'Map restore to stock': 75, 'EGR Solution': 200, 'AdBlue delete': 250,
  'DPF remap (+ removal labour)': 330
};
const SUBCONTRACT = {
  'Wheel alignment (HS Tyres)':      { cost: 60,  sell: 80  },
  'DPF coding':                      { cost: 150, sell: 250 },
  'DPF drilling (Grace Autos)':      { cost: 50,  sell: 100 },
  'Head skimming w/ pressure test':  { cost: 110, sell: 150 },
  'Deep diagnostic (Jason)':         { cost: 110, sell: 120 },
  'Certified plates (per plate)':    { cost: 20,  sell: 30  },
  'UMA Bodyworks':                   { cost: null, sell: null },
  'Key coding':                      { cost: null, sell: null },
  'Deep coding':                     { cost: null, sell: null }
};
const RECOVERY  = [{ to: 3, price: 90 }, { to: 5, price: 110 }, { to: 7, price: 150 }, { to: 10, price: 180 }];
const COLLECTION = [{ to: 3, price: 30 }, { to: 5, price: 45 }, { to: 7, price: 60 },  { to: 10, price: 75  }];

/* ----------------------------------------------------------- bodywork ------ */
const PANEL_BASE = {
  'Roof': 300, 'Boot / tailgate': 250, 'Front bumper': 220, 'Bonnet': 200,
  'Door (each)': 200, 'Rear bumper': 175, 'Front quarter panel': 175,
  'Rear quarter panel': 175, 'Trim / moulding': 100
};
const PANEL_UPLIFT = { '5-seater': 0, '7-seater / SUV': 40, '9-seater van': 80, 'Large van': 100 };
const SLIDING_DOOR = { '5-seater': null, '7-seater / SUV': 270, '9-seater van': 320, 'Large van': 350 };
const REPAINT = {
  'Small (5-seater)':   { Budget: 1650, Standard: 2050, Premium: 2460 },
  'Medium (7-seater)':  { Budget: 2250, Standard: 2750, Premium: 3300 },
  'Large (9-seater +)': { Budget: 3100, Standard: 3750, Premium: 4500 }
};
const MULTI_PANEL_DISCOUNT = 0.20;   // dearest full, every other panel 20% off

const VAT_RATE = 0.20;

/* =============================================================================
   HELPERS
   ============================================================================= */

const money = n => Math.round(n * 100) / 100;   // round MONEY only, never hours
const vat   = n => money(n * VAT_RATE);

function isAA(customer) { return (CUSTOMERS[customer] || {}).kind === 'aa'; }

/**
 * Resolve the tier actually charged. Retail has no MED tier — a MED job
 * for a retail customer is charged at TOP. Returns {tier, rate, collapsed}.
 */
function resolveTier(tier, customer) {
  const c = CUSTOMERS[customer];
  if (!c) throw new Error('Unknown customer type: ' + customer);
  if (c.kind === 'aa') return { tier: 'AA', rate: c.labourRate, collapsed: false };
  let t = tier;
  let collapsed = false;
  if (t === 'MED' && c.collapseMed) { t = 'TOP'; collapsed = true; }
  return { tier: t, rate: RATES[t], collapsed };
}

/**
 * The multiplier for one line. Returns the number, or 1 for AA / bodywork.
 */
function multiplierFor(hours, { customer = 'retail', category = 'mechanical',
                                rampExempt = false, isBodywork = false } = {}) {
  if (isAA(customer)) return 1;          // AA work is charged at raw SRT
  if (isBodywork)     return 1;          // bodywork never takes a multiplier
  const set = rampExempt ? MULT_RAMP : MULT;
  if (ALWAYS_X2.includes(category)) return set.lower;   // never steps down
  const threshold = CUSTOMERS[customer].threshold;
  return hours >= threshold ? set.upper : set.lower;    // exactly on = upper
}

/* =============================================================================
   LABOUR
   ============================================================================= */

/**
 * Price one labour line.
 *   srt              raw book hours from HaynesPro
 *   tier             LOW | MED | TOP | BODY
 *   category         mechanical | servicing | brakes | suspension | bearings |
 *                    dpf | trackrod | exhaust | bodywork | bulb | tyre | wiper
 *   pairSecondarySrt hours of the paired second item, billed at RAW srt
 *   inspection       interim | full | major  (adds its minutes to the SRT)
 *   extraSrt         other hours pooled into a SERVICE line only
 */
function labourLine(opts) {
  const {
    srt = 0, tier = 'TOP', category = 'mechanical', customer = 'retail',
    rampExempt = false, pairSecondarySrt = 0, inspection = null, extraSrt = 0,
    label = ''
  } = opts;

  const isBodywork = tier === 'BODY' || category === 'bodywork';
  const exemptMin  = MIN_EXEMPT.includes(category);

  // Service pooling: oil SRT + inspection + filter SRTs make ONE line.
  let hours = srt + extraSrt;
  if (inspection) hours += INSPECTION_MINUTES[inspection] / 60;

  const rawHours = hours;
  let minApplied = false;
  if (!isBodywork && !exemptMin && hours < MIN_LABOUR_HOURS) {
    hours = MIN_LABOUR_HOURS; minApplied = true;
  }

  const t    = resolveTier(tier, customer);
  const mult = multiplierFor(hours, { customer, category, rampExempt, isBodywork });

  const chargedHours = hours * mult + pairSecondarySrt;   // pair secondary is raw
  let total = chargedHours * t.rate;

  let bodyMinApplied = false;
  if (isBodywork && total < BODY_MIN_CHARGE) {
    total = BODY_MIN_CHARGE; bodyMinApplied = true;
  }

  return {
    kind: 'labour', label, srt, rawHours, hours, chargedHours,
    tier: t.tier, requestedTier: tier, tierCollapsed: t.collapsed, rate: t.rate,
    multiplier: mult, category, rampExempt, pairSecondarySrt,
    minApplied, bodyMinApplied, isBodywork,
    total: money(total), vatable: true
  };
}

/* =============================================================================
   PARTS
   ============================================================================= */

function bandFor(unitNet) {
  return LADDER.find(b => unitNet <= b.to) || null;
}

/**
 * One parts line. Banded per part on the UNIT net cost, then multiplied by qty.
 */
function partLine({ label = '', unitNet = 0, qty = 1, customer = 'retail' }) {
  if (unitNet > PARTS_ESCALATE_ABOVE) {
    return { kind: 'part', label, unitNet, qty, escalate: true, total: null,
             reason: 'Part over £2,000 net — no band exists. Escalate to Logan.',
             vatable: true };
  }
  const c = CUSTOMERS[customer];

  // AA customers use a flat percentage, not the ladder.
  if (c.kind === 'aa') {
    if (c.partsPct == null) {
      return { kind: 'part', label, unitNet, qty, escalate: true, total: null,
               reason: 'No parts markup is set for this AA customer. Escalate to Logan.',
               vatable: true };
    }
    const unitSell = unitNet * (1 + c.partsPct);
    return { kind: 'part', label, unitNet, qty, unitSell: money(unitSell),
             band: (c.partsPct * 100) + '%', minSellApplied: false,
             total: money(unitSell * qty), vatable: true };
  }

  const band = bandFor(unitNet);
  let unitSell = unitNet * band.mult;
  let minSellApplied = false;
  if (unitSell < band.minSell) { unitSell = band.minSell; minSellApplied = true; }

  return { kind: 'part', label, unitNet, qty, unitSell: money(unitSell),
           band: band.markup, mult: band.mult, minSellApplied,
           total: money(unitSell * qty), vatable: true };
}

/** Fluids and consumables — the list figure IS the sell price. No ladder. */
function fluidLine({ label = '', unitSell = 0, qty = 1 }) {
  return { kind: 'fluid', label, unitSell, qty, total: money(unitSell * qty), vatable: true };
}

/** Tyres — net cost, no markup ever, plus flat fitting per tyre. */
function tyreLine({ label = '', netEach = 0, qty = 1 }) {
  return { kind: 'tyre', label, netEach, qty, fitEach: TYRE_FIT_EACH,
           total: money(netEach * qty + TYRE_FIT_EACH * qty), vatable: true };
}

/* =============================================================================
   FIXED PRICES
   ============================================================================= */

function fixedLine({ label = '', price = 0, vatable = true, incVat = false }) {
  // incVat = the figure quoted already includes VAT (e.g. the 25-point check)
  const ex = incVat ? price / 1.2 : price;
  return { kind: 'fixed', label, total: money(ex), vatable, quotedIncVat: incVat };
}

/** MOT sits OUTSIDE the scope of VAT. Never converted, never taxed. */
function motLine({ motClass = 4 }) {
  return { kind: 'mot', label: 'MOT test — Class ' + motClass,
           total: MOT[motClass], vatable: false,
           note: 'VAT not applicable' };
}

/** Bodywork panels: dearest full price, every other panel 20% off. */
function panelLines(panels, category = '5-seater') {
  const uplift = PANEL_UPLIFT[category] || 0;
  const priced = panels.map(name => {
    const base = name === 'Sliding door'
      ? SLIDING_DOOR[category]
      : (PANEL_BASE[name] != null ? PANEL_BASE[name] + uplift : null);
    return { name, price: base };
  });
  if (priced.some(p => p.price == null)) {
    return [{ kind: 'panel', label: 'Panel not priced for this vehicle category',
              escalate: true, total: null,
              reason: 'Panel or category not in the matrix. Escalate to Logan.', vatable: true }];
  }
  const sorted = [...priced].sort((a, b) => b.price - a.price);
  return sorted.map((p, i) => ({
    kind: 'panel', label: p.name + (i === 0 ? ' (dearest — full price)' : ' (−20%)'),
    listPrice: p.price, discounted: i > 0,
    total: money(i === 0 ? p.price : p.price * (1 - MULTI_PANEL_DISCOUNT)),
    vatable: true
  }));
}

/* =============================================================================
   QUOTE TOTAL
   ============================================================================= */

function quote(lines, { customer = 'retail' } = {}) {
  const escalations = [];
  let net = 0, outsideVat = 0;

  lines.forEach(l => {
    if (l.escalate) { escalations.push(l.reason || l.label); return; }
    if (l.vatable === false) outsideVat += l.total;
    else net += l.total;
  });

  net = money(net);
  const vatAmount = vat(net);
  const incVat = money(net + vatAmount);
  const customerPays = money(incVat + outsideVat);

  // Deposit: 50% of the inc-VAT total, required at £200 inc VAT and above.
  const depositRequired = customerPays >= 200;

  return {
    version: VERSION, customer, lines,
    net, vat: vatAmount, incVat, outsideVat, customerPays,
    depositRequired, deposit: depositRequired ? money(customerPays / 2) : 0,
    escalations, readyToSend: escalations.length === 0
  };
}

/* =============================================================================
   HARD STOPS — the estimator must not send these
   ============================================================================= */

const HARD_STOPS = [
  'Any customer-supplied part',
  'Any part costing over £2,000 net',
  'A pairing that is not on the closed list of three',
  'Any SRT not found in HaynesPro after also calling the main dealer',
  'Any vehicle above 8 seats (minibus, 12-seater)',
  'Any split rim alloy',
  'Any expensive-make paint (rare code, unusual manufacturer)',
  'Any recovery beyond 10 miles',
  'Any accident or insurance work',
  'Any sill rot welding'
];

const PAIR_RULE = [
  { primary: 'Brake pads — same axle',            secondary: 'Brake discs — same axle' },
  { primary: 'Clutch',                            secondary: 'Dual mass flywheel' },
  { primary: 'Inner CV boot — same driveshaft',   secondary: 'Outer CV boot — same driveshaft' }
];

return {
  VERSION, RATES, CUSTOMERS, MULT, MULT_RAMP, ALWAYS_X2, LADDER, FLUIDS,
  TYRE_FIT_EACH, MIN_LABOUR_HOURS, MIN_EXEMPT, BODY_MIN_CHARGE, INSPECTION_MINUTES,
  MOT, DIAGNOSTICS, INSPECTIONS, ENGINE_REPLACEMENT, TUNING, SUBCONTRACT,
  RECOVERY, COLLECTION, PANEL_BASE, PANEL_UPLIFT, SLIDING_DOOR, REPAINT,
  MULTI_PANEL_DISCOUNT, VAT_RATE, HARD_STOPS, PAIR_RULE, PARTS_ESCALATE_ABOVE,
  money, vat, isAA, resolveTier, multiplierFor,
  labourLine, partLine, fluidLine, tyreLine, fixedLine, motLine, panelLines, quote
};
}));
