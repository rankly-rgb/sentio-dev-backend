-- Action 7 (moitié backend de 5.9) : feedback produit sur les scores/insights.
-- Zero-PII strict : aucune colonne référençant l'utilisateur Sentio ayant
-- donné le feedback — uniquement account_id/insight_id/organization_id.
-- Convention reprise de ai_insights (20260301000005_phase4_intelligence.sql).

CREATE TABLE IF NOT EXISTS public.score_feedback (
  id                UUID NOT NULL DEFAULT gen_random_uuid(),
  organization_id   UUID NOT NULL,
  account_id        UUID NOT NULL,
  insight_id        UUID NULL,
  is_helpful        BOOLEAN NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT score_feedback_pkey PRIMARY KEY (id),
  CONSTRAINT score_feedback_organization_id_fkey FOREIGN KEY (organization_id)
    REFERENCES public.organizations(id) ON DELETE CASCADE,
  CONSTRAINT score_feedback_account_id_fkey FOREIGN KEY (account_id)
    REFERENCES public.accounts(id) ON DELETE CASCADE,
  CONSTRAINT score_feedback_insight_id_fkey FOREIGN KEY (insight_id)
    REFERENCES public.ai_insights(id) ON DELETE CASCADE
) TABLESPACE pg_default;

CREATE INDEX IF NOT EXISTS idx_score_feedback_account ON public.score_feedback USING btree (account_id);
CREATE INDEX IF NOT EXISTS idx_score_feedback_org ON public.score_feedback USING btree (organization_id);

ALTER TABLE public.score_feedback ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "score_feedback_org_isolation" ON public.score_feedback;
CREATE POLICY "score_feedback_org_isolation"
ON public.score_feedback FOR ALL
USING (
  organization_id = public.user_organization_id()
  OR public.user_role() = 'service_role'
);
