-- stripe-billing-webhook n'avait aucune protection contre le rejeu/désordre
-- d'événements Stripe : `event.id` n'était jamais ni déduplication ni même
-- loggé hors du chemin d'erreur, et updatePlanType() faisait un UPDATE
-- inconditionnel. Contrairement à stripe-webhook (garde
-- last_event_created_at par subscription, cf. supabase/functions/stripe-webhook/
-- index.ts), un événement Stripe re-délivré en retard ou hors ordre (retry
-- réseau, resend manuel depuis le Dashboard Stripe) pouvait écraser
-- organizations.plan_type avec un état plus ancien que celui déjà appliqué.
--
-- Même mécanisme que stripe-webhook : on retient le timestamp de l'event
-- Stripe (`event.created`, pas la date de traitement) du dernier
-- updatePlanType() appliqué avec succès, et le code applicatif
-- (stripe-billing-webhook/index.ts) n'écrit désormais que via un UPDATE
-- conditionnel atomique (WHERE billing_event_at IS NULL OR < event.created)
-- -- pas de lecture préalable, donc pas de fenêtre TOCTOU.

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS billing_event_at TIMESTAMPTZ;

COMMENT ON COLUMN public.organizations.billing_event_at IS
  'Timestamp Stripe (event.created) du dernier événement stripe-billing-webhook appliqué avec succès à plan_type -- garde anti-désordre/rejeu, jamais la date de traitement.';
