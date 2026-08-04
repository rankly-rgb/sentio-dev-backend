-- ============================================================
-- mrr_restatements — journal des recalculs MRR one-shot (Phase 2.4)
--
-- Le passage au moteur MRR v2 (_shared/mrr-engine.ts, Phase 2.1/2.2) change
-- la formule de calcul de accounts.mrr_cents pour les comptes existants
-- (items multiples désormais sommés, interval_count respecté, remises
-- appliquées, trials exclus...). Si ce changement de formule était laissé
-- au sync quotidien normal, la Phase 3 de sync-stripe (génération des
-- mrr_movements par comparaison avant/après) génèrerait une vague de FAUX
-- mouvements contraction/expansion/churn pour chaque compte dont la valeur
-- change uniquement à cause de la formule — polluant le NRR pour toujours
-- et risquant de déclencher sync-anomaly-guard.
--
-- sync-stripe expose donc un mode `restatement_mode` (docs/openspec.md,
-- IMPLEMENTATION_LOG.md Phase 2.4) qui recalcule accounts.mrr_cents avec le
-- nouveau moteur SANS générer de mrr_movements et SANS passer par le
-- garde-fou d'anomalie (bypass explicite, documenté) — chaque delta est
-- journalisé ici, pas juste appliqué silencieusement. Réservé à un
-- déclenchement opérateur explicite, jamais au cron normal.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.mrr_restatements (
  id                UUID NOT NULL DEFAULT gen_random_uuid(),
  organization_id   UUID NOT NULL,
  account_id        UUID NOT NULL,

  old_mrr_cents     INTEGER NOT NULL,
  new_mrr_cents     INTEGER NOT NULL,
  reason            TEXT NOT NULL DEFAULT 'mrr_engine_v2_migration',

  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT mrr_restatements_pkey PRIMARY KEY (id),
  CONSTRAINT mrr_restatements_organization_id_fkey FOREIGN KEY (organization_id)
    REFERENCES public.organizations(id) ON DELETE CASCADE,
  CONSTRAINT mrr_restatements_account_id_fkey FOREIGN KEY (account_id)
    REFERENCES public.accounts(id) ON DELETE CASCADE
) TABLESPACE pg_default;

CREATE INDEX IF NOT EXISTS idx_mrr_restatements_org ON public.mrr_restatements USING btree (organization_id);
CREATE INDEX IF NOT EXISTS idx_mrr_restatements_account ON public.mrr_restatements USING btree (account_id);
CREATE INDEX IF NOT EXISTS idx_mrr_restatements_created ON public.mrr_restatements USING btree (organization_id, created_at DESC);

DROP TRIGGER IF EXISTS update_mrr_restatements_updated_at ON public.mrr_restatements;
CREATE TRIGGER update_mrr_restatements_updated_at
  BEFORE UPDATE ON public.mrr_restatements
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE public.mrr_restatements ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "mrr_restatements_org_isolation" ON public.mrr_restatements;
CREATE POLICY "mrr_restatements_org_isolation"
ON public.mrr_restatements FOR ALL
USING (
  organization_id = public.user_organization_id()
  OR public.user_role() = 'service_role'
);
