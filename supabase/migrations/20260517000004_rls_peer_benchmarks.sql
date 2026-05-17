-- Migration : activer RLS sur peer_benchmarks
-- Table d'agrégats inter-orgs (pas de org_id, données anonymisées).
-- Lecture autorisée pour tous les rôles authentifiés.
-- Écriture réservée au service_role (cron compute-peer-benchmarks).

ALTER TABLE peer_benchmarks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "peer_benchmarks_read_authenticated"
ON peer_benchmarks FOR SELECT
USING (true);

CREATE POLICY "peer_benchmarks_write_service_only"
ON peer_benchmarks FOR INSERT
WITH CHECK (public.user_role() = 'service_role');

CREATE POLICY "peer_benchmarks_delete_service_only"
ON peer_benchmarks FOR DELETE
USING (public.user_role() = 'service_role');
