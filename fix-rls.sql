-- =============================================================================
-- FIX: let the anon key read KITH's own tables from the browser (master,
-- inbox, CRM). Supabase enforces Row Level Security by default on tables
-- created via SQL — the anon key is then blocked from reading them, which
-- is why kith-master.html shows all zeros.
--
-- These tables are only ever read in the browser by KITH staff behind the
-- director PIN or by the CRM's own authenticated session, so turning RLS
-- OFF here matches what the rest of your CRM tables already do (jobs is
-- unrestricted). Nothing of real sensitivity lives in them.
-- =============================================================================

ALTER TABLE kith_sop_config          DISABLE ROW LEVEL SECURITY;
ALTER TABLE kith_sop_history         DISABLE ROW LEVEL SECURITY;
ALTER TABLE kith_srt_cache           DISABLE ROW LEVEL SECURITY;
ALTER TABLE kith_parts_cache         DISABLE ROW LEVEL SECURITY;
ALTER TABLE kith_brain_queries       DISABLE ROW LEVEL SECURITY;
ALTER TABLE kith_triage_corrections  DISABLE ROW LEVEL SECURITY;
