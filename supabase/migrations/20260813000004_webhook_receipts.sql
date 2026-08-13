-- Lot 3 (2026-08-13, webhook diagnostic) — public.webhook_receipts
--
-- Diagnostic préalable (voir docs/CHANGELOG_STABILITY.md, "Lot 3") : zéro
-- ligne dans webhook_dead_letter, zéro ligne data_syncs.webhook_event_id non
-- nul, zéro invocation de stripe-webhook dans les logs des dernières 24h.
-- Cause racine trouvée dans le code, pas seulement l'absence de données :
-- stripe-webhook/index.ts rejette une signature invalide avec un simple
-- console.warn (ligne ~595) — aucune trace persistée. Un webhook mal signé
-- (mauvais secret, mauvais endpoint côté Stripe, trafic non-Stripe) est donc
-- rigoureusement indiscernable de "Stripe n'a jamais tenté" par une requête
-- SQL. C'est le vrai bug à corriger, indépendamment de la cause racine
-- confirmée par ailleurs.
--
-- organization_id volontairement NULLABLE : un event à la signature
-- rejetée n'a par construction aucune org résolvable (le rejet a lieu avant
-- toute résolution d'org, stripe-webhook/index.ts ligne ~594) — une
-- exception documentée, pas un relâchement de la règle RLS générale
-- (aucune query utilisateur ne lit cette table directement, seul un
-- endpoint ops agrégé — health-check — expose last_webhook_received_at par
-- org). "No data ≠ neutral data" appliqué à l'observabilité elle-même :
-- un event non-résolvable ne doit pas simplement disparaître faute de
-- correspondre au schéma.

CREATE TABLE IF NOT EXISTS public.webhook_receipts (
  id                UUID NOT NULL DEFAULT gen_random_uuid(),
  organization_id   UUID NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  provider          TEXT NOT NULL,
  signature_valid   BOOLEAN NOT NULL,
  event_type        TEXT NULL,
  stripe_event_id   TEXT NULL,
  received_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT webhook_receipts_pkey PRIMARY KEY (id),
  CONSTRAINT webhook_receipts_provider_check CHECK (provider = ANY (ARRAY['stripe','hubspot']))
) TABLESPACE pg_default;

CREATE INDEX IF NOT EXISTS idx_webhook_receipts_org_received
  ON public.webhook_receipts (organization_id, received_at DESC)
  WHERE organization_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_webhook_receipts_received
  ON public.webhook_receipts (received_at DESC);

ALTER TABLE public.webhook_receipts ENABLE ROW LEVEL SECURITY;

-- Deny-by-default : aucune policy pour anon/authenticated. Écrit
-- exclusivement par stripe-webhook (service_role, qui bypass RLS) ; lu
-- exclusivement par health-check via une agrégation par org (service_role
-- également) — jamais de lecture directe utilisateur sur cette table.
DROP POLICY IF EXISTS webhook_receipts_org_isolation ON public.webhook_receipts;
CREATE POLICY webhook_receipts_org_isolation ON public.webhook_receipts
  FOR SELECT
  USING (organization_id = public.user_organization_id());
