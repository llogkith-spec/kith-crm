-- =============================================================================
-- KITH TRIAGE corrections — when Logan overrides the triage AI's category,
-- the correction is written here so the next triage call can learn from it.
-- =============================================================================

CREATE TABLE IF NOT EXISTS kith_triage_corrections (
  id                  BIGSERIAL PRIMARY KEY,
  lead_id             TEXT,
  original_text       TEXT NOT NULL,
  original_category   TEXT NOT NULL,
  corrected_category  TEXT NOT NULL,
  original_rapid_fire BOOLEAN,
  corrected_rapid_fire BOOLEAN,
  corrected_by        TEXT,
  corrected_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  note                TEXT
);

CREATE INDEX IF NOT EXISTS idx_triage_corrections_at ON kith_triage_corrections (corrected_at DESC);
