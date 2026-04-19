-- ============================================================
-- Migration : Chantier 2 — Onboarding & Aha Moment
-- Ajoute sur organizations :
--   first_score_calculated_at  — timestamp du premier scoring
--   aha_moment_seen_at         — timestamp quand le aha moment a été affiché
-- ============================================================

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS first_score_calculated_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS aha_moment_seen_at         TIMESTAMPTZ NULL;

COMMENT ON COLUMN public.organizations.first_score_calculated_at IS
  'Timestamp du premier calcul de score réussi pour cette organisation. Nul tant qu''aucun score n''est calculé.';

COMMENT ON COLUMN public.organizations.aha_moment_seen_at IS
  'Timestamp quand le aha moment onboarding a été affiché à l''utilisateur. Nul = pas encore affiché.';
