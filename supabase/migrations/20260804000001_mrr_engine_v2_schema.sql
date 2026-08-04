-- ============================================================
-- MRR Engine v2 — nouvelles colonnes (docs/openspec.md §12)
--
-- Support du moteur MRR extrait dans _shared/mrr-engine.ts (Phase 2.1/2.2) :
-- statut "no data ≠ neutral data" par compte/subscription, MRR trial séparé
-- du MRR confirmé, délinquence/annulation planifiée comme signaux distincts
-- du churn, modèle de facturation détecté, devise par compte/subscription
-- (vote majoritaire org, pas la première invoice du batch), et un type de
-- mouvement 'correction' réservé aux migrations de restatement (Phase 2.4).
--
-- Additif uniquement : aucune colonne existante n'est renommée ni retypée.
-- accounts.billing_interval ('monthly'/'annual') N'EST PAS élargi ici —
-- delibérément laissé intact pour ne pas changer le vocabulaire consommé
-- par calcBillingIntervalScore (_shared/scoring.ts, Health Score V3), hors
-- périmètre de l'autorisation de ce chantier. La granularité fine
-- (interval Stripe brut + interval_count) est portée par les NOUVELLES
-- colonnes subscriptions.interval_raw/interval_count ci-dessous, purement
-- additives.
-- ============================================================

-- ------------------------------------------------------------
-- accounts
-- ------------------------------------------------------------
ALTER TABLE public.accounts
  ADD COLUMN IF NOT EXISTS mrr_status TEXT NOT NULL DEFAULT 'ok',
  ADD COLUMN IF NOT EXISTS trial_mrr_cents INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS is_delinquent BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS pending_cancellation BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_zero_dollar_active BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS billing_model TEXT NOT NULL DEFAULT 'subscription',
  ADD COLUMN IF NOT EXISTS currency TEXT NULL;

ALTER TABLE public.accounts
  DROP CONSTRAINT IF EXISTS accounts_mrr_status_check;
ALTER TABLE public.accounts
  ADD CONSTRAINT accounts_mrr_status_check CHECK (mrr_status = ANY (ARRAY['ok', 'unavailable']));

ALTER TABLE public.accounts
  DROP CONSTRAINT IF EXISTS accounts_trial_mrr_cents_check;
ALTER TABLE public.accounts
  ADD CONSTRAINT accounts_trial_mrr_cents_check CHECK (trial_mrr_cents >= 0);

ALTER TABLE public.accounts
  DROP CONSTRAINT IF EXISTS accounts_billing_model_check;
ALTER TABLE public.accounts
  ADD CONSTRAINT accounts_billing_model_check CHECK (billing_model = ANY (ARRAY['subscription', 'invoice_only']));

ALTER TABLE public.accounts
  DROP CONSTRAINT IF EXISTS accounts_currency_format_check;
ALTER TABLE public.accounts
  ADD CONSTRAINT accounts_currency_format_check CHECK (currency IS NULL OR currency ~ '^[a-z]{3}$');

COMMENT ON COLUMN public.accounts.mrr_status IS
  'no data ≠ neutral data (docs/openspec.md §1) : ''unavailable'' quand au moins une subscription billable du compte est non-chiffrable (metered, unit_amount null, devise minoritaire) ou quand le compte n''a jamais eu de subscription connue (invoice-only, pas encore synchronisé). mrr_cents peut être un total partiel (subscriptions connues sommées) même quand mrr_status=''unavailable'' — voir _shared/mrr-engine.ts aggregateAccountMrr.';
COMMENT ON COLUMN public.accounts.trial_mrr_cents IS
  'MRR "en pipeline" des subscriptions trialing, exclu de mrr_cents (docs/openspec.md §4). Convention Baremetrics/ChartMogul.';
COMMENT ON COLUMN public.accounts.is_delinquent IS
  'true si au moins une subscription billable est past_due/unpaid. Ne déclenche JAMAIS isChurned (docs/openspec.md §5) — alimente les signaux de risque existants (invoice_overdue_15d, payment_failures_90d).';
COMMENT ON COLUMN public.accounts.pending_cancellation IS
  'true si au moins une subscription active a cancel_at_period_end=true. Signal de risque, pas un mouvement churn tant que Stripe n''a pas effectivement annulé (docs/openspec.md §5).';
COMMENT ON COLUMN public.accounts.is_zero_dollar_active IS
  'true si le compte a un downgrade vers un plan $0 avec subscription toujours active (classé churn en interne pour rester cohérent avec D1, mais distingué pour un reporting NRR/GRR externe futur — docs/openspec.md §6).';
COMMENT ON COLUMN public.accounts.billing_model IS
  '''subscription'' (défaut) ou ''invoice_only'' (customer avec invoices mais aucune Subscription Stripe — send_invoice). Un compte invoice_only n''est jamais churned par défaut et n''a pas de MRR de repli dans cette itération (docs/openspec.md §8.2, §11 hors périmètre).';
COMMENT ON COLUMN public.accounts.currency IS
  'Devise ISO 4217 du compte, dérivée de ses subscriptions (docs/openspec.md §9). NULL si aucune subscription chiffrable. Distincte de organizations.currency (devise d''affichage par défaut de l''org, résolue par vote majoritaire — voir migration Phase 2.4/sync-stripe).';

-- ------------------------------------------------------------
-- subscriptions
-- ------------------------------------------------------------
ALTER TABLE public.subscriptions
  ADD COLUMN IF NOT EXISTS currency TEXT NULL,
  ADD COLUMN IF NOT EXISTS interval_raw TEXT NULL,
  ADD COLUMN IF NOT EXISTS interval_count INTEGER NULL,
  ADD COLUMN IF NOT EXISTS mrr_status TEXT NOT NULL DEFAULT 'ok';

ALTER TABLE public.subscriptions
  DROP CONSTRAINT IF EXISTS subscriptions_currency_format_check;
ALTER TABLE public.subscriptions
  ADD CONSTRAINT subscriptions_currency_format_check CHECK (currency IS NULL OR currency ~ '^[a-z]{3}$');

ALTER TABLE public.subscriptions
  DROP CONSTRAINT IF EXISTS subscriptions_interval_count_check;
ALTER TABLE public.subscriptions
  ADD CONSTRAINT subscriptions_interval_count_check CHECK (interval_count IS NULL OR interval_count > 0);

ALTER TABLE public.subscriptions
  DROP CONSTRAINT IF EXISTS subscriptions_mrr_status_check;
ALTER TABLE public.subscriptions
  ADD CONSTRAINT subscriptions_mrr_status_check CHECK (mrr_status = ANY (ARRAY['ok', 'unavailable']));

-- Élargit la CHECK sur status : 'unpaid' et 'incomplete_expired' sont des
-- statuts Stripe réels (l'API /subscriptions?status=all les retourne) que le
-- code lisait déjà sans condition avant ce correctif — un abonnement
-- réellement 'unpaid' échouait silencieusement à l'upsert (bug pré-existant,
-- trouvé lors de la revue de la Phase 2.2, voir IMPLEMENTATION_LOG.md).
ALTER TABLE public.subscriptions
  DROP CONSTRAINT IF EXISTS subscriptions_status_check;
ALTER TABLE public.subscriptions
  ADD CONSTRAINT subscriptions_status_check CHECK (
    status = ANY (ARRAY['active', 'past_due', 'canceled', 'trialing', 'paused', 'incomplete', 'unpaid', 'incomplete_expired'])
  );

COMMENT ON COLUMN public.subscriptions.currency IS
  'Devise ISO 4217 de cette subscription (price.currency Stripe). Docs/openspec.md §9.';
COMMENT ON COLUMN public.subscriptions.interval_raw IS
  'Intervalle Stripe brut (year/month/week/day) — granularité complète, contrairement à accounts.billing_interval qui reste un bucket monthly/annual à poids fixe pour ne pas changer le vocabulaire consommé par calcBillingIntervalScore (Health Score V3, hors périmètre de ce chantier).';
COMMENT ON COLUMN public.subscriptions.interval_count IS
  'interval_count Stripe (ex. interval=month, interval_count=3 = trimestriel). Docs/openspec.md §3.';
COMMENT ON COLUMN public.subscriptions.mrr_status IS
  'no data ≠ neutral data : ''unavailable'' si cette subscription seule n''est pas chiffrable (metered, unit_amount null) ou si sa devise diverge de la devise majoritaire de l''org. Voir _shared/mrr-engine.ts calcSubscriptionMrrCents.';

-- ------------------------------------------------------------
-- mrr_movements — nouveau movement_type 'correction'
-- ------------------------------------------------------------
-- Réservé aux migrations de restatement (Phase 2.4) et recalculs manuels
-- futurs — exclu par construction du calcul NRR (docs/openspec.md §10).
ALTER TABLE public.mrr_movements
  DROP CONSTRAINT IF EXISTS mrr_movements_movement_type_check;
ALTER TABLE public.mrr_movements
  ADD CONSTRAINT mrr_movements_movement_type_check CHECK (
    movement_type = ANY (ARRAY['new', 'expansion', 'contraction', 'churn', 'reactivation', 'correction'])
  );
