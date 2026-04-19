-- ============================================================
-- Migration : Chantier 7 — Session tracking (last_seen_at)
-- Ajoute last_seen_at sur profiles_ pour détecter les éléments
-- "nouveaux" apparus depuis la dernière visite de l'utilisateur.
-- ============================================================

ALTER TABLE public.profiles_
  ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ NULL;

COMMENT ON COLUMN public.profiles_.last_seen_at IS
  'Timestamp de la dernière ouverture de session active (mise à jour via POST /session/ping). Utilisé pour marquer insights et variations de score comme "nouveau".';

CREATE INDEX IF NOT EXISTS idx_profiles_last_seen_at
  ON public.profiles_ (organization_id, last_seen_at)
  WHERE last_seen_at IS NOT NULL;
