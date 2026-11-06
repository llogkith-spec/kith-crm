-- =============================================================================
-- KITH SOP config — single source of truth for every pricing number
-- =============================================================================
-- One row with id='current' holds the live SOP as JSON. Brain, CRM and
-- estimator read from it; the SOP editor writes to it. Every save bumps
-- the version and appends to history so you can see what changed and when.
-- =============================================================================

CREATE TABLE IF NOT EXISTS kith_sop_config (
  id             TEXT PRIMARY KEY DEFAULT 'current',
  data           JSONB NOT NULL,
  version        INT NOT NULL DEFAULT 1,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by     TEXT,
  note           TEXT
);

CREATE TABLE IF NOT EXISTS kith_sop_history (
  id             BIGSERIAL PRIMARY KEY,
  version        INT NOT NULL,
  data           JSONB NOT NULL,
  changed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  changed_by     TEXT,
  note           TEXT
);

CREATE INDEX IF NOT EXISTS idx_sop_history_at ON kith_sop_history (changed_at DESC);

-- Seed with SOP v8.0 defaults (the current engine.js values).
INSERT INTO kith_sop_config (id, data, version, updated_by, note) VALUES (
  'current',
  '{
    "version": "8.0",
    "rates": { "LOW": 50, "MED": 60, "TOP": 70, "BODY": 90 },
    "customers": {
      "retail":     { "label": "Retail / B2C",   "kind": "kith", "threshold": 2.0, "tiers": ["LOW","TOP"],       "collapseMed": true  },
      "trade":      { "label": "Trade / B2B",    "kind": "kith", "threshold": 1.5, "tiers": ["LOW","MED","TOP"], "collapseMed": false },
      "aa_smart":   { "label": "AA Smart",       "kind": "aa",   "labourRate": 55,  "partsPct": 0.15 },
      "aa_towin":   { "label": "AA Tow-in",      "kind": "aa",   "labourRate": 90,  "partsPct": 0.20, "diagRate": 33 },
      "aa_pgc":     { "label": "AA PGC",         "kind": "aa",   "labourRate": 90,  "partsPct": 0.15, "diagFixed": 29.77 },
      "aa_fleet":   { "label": "AA Fleet",       "kind": "aa",   "labourRate": 44,  "partsPct": 0.15, "diagRate": 44, "diagAuthMax": 0.5 },
      "warranty":   { "label": "Warranty co.",   "kind": "flat", "labourRate": 110, "partsPct": 0.15, "note": "Raw SRT, no multiplier, inc VAT" },
      "insurance":  { "label": "Insurance",      "kind": "flat", "labourRate": 45,  "partsPct": 0.10, "note": "Main dealer + 10% parts" }
    },
    "multiplier": {
      "normal":   { "lower": 2.0,  "upper": 1.5  },
      "ramp":     { "lower": 2.5,  "upper": 1.75 },
      "alwaysX2": ["suspension", "bearings", "dpf", "trackrod"]
    },
    "minimums": {
      "labourHours":      0.5,
      "bodyMinCharge":    90,
      "exemptCategories": ["bulb", "tyre", "wiper"]
    },
    "partsLadder": [
      { "to": 10,   "mult": 2.0, "minSell": 0  },
      { "to": 20,   "mult": 1.8, "minSell": 20 },
      { "to": 30,   "mult": 1.6, "minSell": 36 },
      { "to": 40,   "mult": 1.4, "minSell": 48 },
      { "to": 2000, "mult": 1.3, "minSell": 56 }
    ],
    "partsEscalateAbove": 2000,
    "inspectionMinutes": { "interim": 12.5, "full": 20, "major": 30 },
    "tyreFitEach": 20,
    "mot": { "4": 50, "5": 58, "7": 58 },
    "diagnostics": {
      "Mechanical diagnostic":         60,
      "Oil and coolant leak diagnostic": 90,
      "Deep diagnostic":               120,
      "Electrical diagnostic":         150
    },
    "inspections": {
      "25-point interim health check": { "price": 25, "incVat": true  },
      "40-point full inspection":      { "price": 45, "incVat": false },
      "60-point / pre-purchase":       { "price": 60, "incVat": false }
    },
    "tuning": {
      "Stage 1 remap":        200,
      "Stage 2 remap":        300,
      "Economy remap":        200,
      "Pop & bang (standalone)": 150,
      "Map restore to stock":  75,
      "EGR Solution":         200,
      "AdBlue delete":        250,
      "DPF remap (+ removal labour)": 330
    },
    "recovery": [
      { "toMiles": 3,  "price": 90  },
      { "toMiles": 5,  "price": 110 },
      { "toMiles": 7,  "price": 150 },
      { "toMiles": 10, "price": 180 }
    ],
    "collection": [
      { "toMiles": 3,  "price": 30 },
      { "toMiles": 5,  "price": 45 },
      { "toMiles": 7,  "price": 60 },
      { "toMiles": 10, "price": 75 }
    ],
    "bodywork": {
      "panelBase": {
        "Roof": 400, "Boot / tailgate": 350, "Front bumper": 320,
        "Bonnet": 300, "Door (each)": 300, "Rear bumper": 275,
        "Front quarter panel": 275, "Rear quarter panel": 275,
        "Trim / moulding": 200, "Sliding door": 300
      },
      "panelUplift":  { "5-seater": 0, "7-seater / SUV": 40, "9-seater van": 80, "Large van": 100 },
      "repaint": {
        "Small (5-seater)":   { "Budget": 1650, "Standard": 2050, "Premium": 2460 },
        "Medium (7-seater)":  { "Budget": 2250, "Standard": 2750, "Premium": 3300 },
        "Large (9-seater +)": { "Budget": 3100, "Standard": 3750, "Premium": 4500 }
      },
      "multiPanelDiscount": 0.20,
      "blend":   { "panel": 50, "door": 100 },
      "smartRepair": 200,
      "dent":    { "min": 50, "max": 500 },
      "straightening": { "shallowMin": 70, "badMax": 300 },
      "vehicleAgeDiscount": { "overYears": 10, "pct": 0.25, "appliesTo": "panelPainting" }
    },
    "fluids": {
      "Budget oil (1L)": 5.50, "Castrol 5W-30 (1L)": 7.50,
      "Castrol 5W-30 C3 (1L)": 12.50, "Castrol 0W-30 C2 (1L)": 8.00,
      "Castrol 0W-20 LL (1L)": 10.50, "Transmission / PAS fluid (1L)": 10.40,
      "Brake & clutch fluid": 8.00, "Brake cleaner": 4.50, "WD-40": 9.00,
      "Cataclean DPF cleaner": 15.00, "Wynn''s exhaust DPF cleaner": 9.90,
      "Coolant (1L)": 5.00, "Screenwash": 2.00, "AdBlue (1L)": 2.50,
      "Bulb": 8.00, "Wiper blade - front": 7.00, "Wiper blade - rear": 5.00
    },
    "instantRange": { "lowerPct": 10, "upperPct": 25 }
  }'::jsonb,
  1,
  'system',
  'Seeded with SOP v8.0 defaults'
) ON CONFLICT (id) DO NOTHING;
