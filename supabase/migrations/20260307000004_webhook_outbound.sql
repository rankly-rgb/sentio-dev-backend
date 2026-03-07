-- ============================================================
-- Migration : Extension webhook_configs pour webhooks sortants
-- + Extension webhook_dead_letter pour le provider outbound_webhook
-- ============================================================

-- 1. Élargir la contrainte CHECK de webhook_configs.provider
ALTER TABLE public.webhook_configs
  DROP CONSTRAINT IF EXISTS webhook_configs_provider_check;

ALTER TABLE public.webhook_configs
  ADD CONSTRAINT webhook_configs_provider_check CHECK (
    provider = ANY (ARRAY['stripe','hubspot','usage','webhook'])
  );

-- 2. Ajouter les colonnes pour le webhook sortant
ALTER TABLE public.webhook_configs
  ADD COLUMN IF NOT EXISTS active_events JSONB DEFAULT '["churn_risk_critical","payment_failed","renewal_reminder","expansion_opportunity","health_score_drop","onboarding_completed"]'::jsonb,
  ADD COLUMN IF NOT EXISTS last_triggered_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS failure_count INTEGER NOT NULL DEFAULT 0;

-- 3. Supprimer la contrainte UNIQUE org+provider pour permettre
--    une config 'webhook' en plus des configs 'stripe','hubspot','usage'
--    (UNIQUE reste sur org+provider donc pas de doublon pour le même provider)
-- Note : la contrainte existante webhook_configs_org_provider_key couvre déjà ce cas.

-- 4. Élargir la contrainte CHECK de webhook_dead_letter.provider
ALTER TABLE public.webhook_dead_letter
  DROP CONSTRAINT IF EXISTS webhook_dead_letter_provider_check;

ALTER TABLE public.webhook_dead_letter
  ADD CONSTRAINT webhook_dead_letter_provider_check CHECK (
    provider = ANY (ARRAY['stripe','hubspot','usage','outbound_webhook'])
  );

-- 5. Renommer webhook_secret en secret pour le provider 'webhook'
--    (la colonne existante s'appelle webhook_secret, le prompt demande 'secret')
--    On garde webhook_secret tel quel pour compatibilité avec les providers existants.
--    Le code Edge Function accède via l'alias dans le SELECT.

-- 6. RPC atomique pour incrémenter failure_count et retourner la nouvelle valeur
CREATE OR REPLACE FUNCTION public.increment_webhook_failure(p_org_id UUID)
RETURNS INTEGER
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE webhook_configs
  SET failure_count = failure_count + 1,
      updated_at = now()
  WHERE organization_id = p_org_id
    AND provider = 'webhook'
  RETURNING failure_count;
$$;

GRANT EXECUTE ON FUNCTION public.increment_webhook_failure(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.increment_webhook_failure(UUID) TO service_role;
