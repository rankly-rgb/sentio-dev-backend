-- ============================================================
-- Migration : Cron job pour refresh-hubspot-tokens (toutes les 5h)
-- Les tokens HubSpot expirent toutes les 6h.
-- Ce cron tourne toutes les 5h pour rafraîchir avant expiration.
-- Prérequis : activer pg_cron et pg_net dans le dashboard Supabase
--   Dashboard > Database > Extensions > pg_cron (enable)
--   Dashboard > Database > Extensions > pg_net (enable)
-- ============================================================

-- Activer les extensions requises (no-op si déjà actives)
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

-- Nettoyage automatique des oauth_states expirés (toutes les heures)
SELECT cron.schedule(
  'cleanup-expired-oauth-states',
  '0 * * * *',
  $$DELETE FROM public.oauth_states WHERE expires_at < now()$$
);

-- Refresh des tokens HubSpot toutes les 5 heures
SELECT cron.schedule(
  'refresh-hubspot-tokens',
  '0 */5 * * *',
  $$SELECT net.http_post(
    url := current_setting('app.supabase_functions_url') || '/refresh-hubspot-tokens',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || current_setting('app.service_role_key'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  )$$
);
