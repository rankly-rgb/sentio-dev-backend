-- ============================================================
-- playbook_runs — Historique des exports CSV playbook (chantier A)
--
-- Distinct de playbook_executions (historique d'exécution automatisée
-- par compte, dispatch HubSpot/Slack/etc. — voir migration
-- 20260301000005_phase4_intelligence.sql). playbook_runs suit un
-- concept différent : un export CSV manuel (un CSM active un
-- playbook, prévisualise les comptes ciblés, exporte un CSV pour
-- import dans son outil d'emailing externe), avec un statut de cycle
-- de vie propre ('exported' → 'executed' une fois l'envoi confirmé
-- manuellement côté ESP du client) plutôt qu'un statut d'exécution
-- automatisée par compte.
--
-- Zero-PII : aucune colonne ne stocke email/nom — uniquement des
-- métriques agrégées et l'organization_id/playbook_id.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.playbook_runs (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   UUID        NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  playbook_id       UUID        NOT NULL REFERENCES public.playbooks(id) ON DELETE CASCADE,
  -- Snapshot au moment de l'export (nom du segment ciblé ou du playbook),
  -- pour affichage dans l'historique sans re-jointure — pas un mécanisme
  -- de ciblage (le ciblage réel vit dans playbook.segment_id /
  -- eligibility_criteria, résolu par _shared/playbook-targeting.ts).
  target_label      TEXT        NULL,
  accounts_count    INTEGER     NOT NULL DEFAULT 0,
  mrr_at_risk_cents INTEGER     NOT NULL DEFAULT 0,
  status            TEXT        NOT NULL DEFAULT 'exported' CHECK (status IN ('exported', 'executed')),
  exported_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  exported_by       UUID        NULL, -- auth_user_id, pas de FK pour simplicité V1 (convention playbook_approval_queue)
  executed_at       TIMESTAMPTZ NULL,
  executed_by       UUID        NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT playbook_runs_executed_coherence_check CHECK (
    (status = 'exported' AND executed_at IS NULL)
    OR (status = 'executed' AND executed_at IS NOT NULL)
  )
);

ALTER TABLE public.playbook_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "playbook_runs_org_isolation" ON public.playbook_runs;
CREATE POLICY "playbook_runs_org_isolation"
ON public.playbook_runs FOR ALL
USING (
  organization_id = public.user_organization_id()
  OR public.user_role() = 'service_role'
);

CREATE INDEX IF NOT EXISTS idx_playbook_runs_org
  ON public.playbook_runs (organization_id, exported_at DESC);

CREATE INDEX IF NOT EXISTS idx_playbook_runs_playbook
  ON public.playbook_runs (playbook_id, exported_at DESC);

-- Anti-double-send (A7a) : trouver rapidement les runs 'executed' récents
-- d'un playbook donné, pour exclure leurs comptes des prochains targets.
CREATE INDEX IF NOT EXISTS idx_playbook_runs_executed
  ON public.playbook_runs (playbook_id, executed_at DESC)
  WHERE status = 'executed';

DROP TRIGGER IF EXISTS update_playbook_runs_updated_at ON public.playbook_runs;
CREATE TRIGGER update_playbook_runs_updated_at
  BEFORE UPDATE ON public.playbook_runs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
