-- ============================================================
-- Lot 8 — capture des objets `playbook_exports` créés hors migration
-- ============================================================
--
-- Contexte (issue #55) : `export-playbook-accounts` était déployé sans
-- source git ; les objets base qu'il utilise ont été créés de la même
-- façon — directement contre le projet, sans fichier versionné. Ils
-- existent donc en base sans qu'aucune migration ne les déclare :
--
--   - public.date_trunc_minute_immutable(timestamptz)  (helper d'index)
--   - public.playbook_exports                          (table + RLS)
--   - public.get_playbook_export_summary(uuid, jsonb)  (RPC SECURITY DEFINER)
--
-- Cette migration les déclare **à l'identique de leur définition live**
-- (relevée via information_schema / pg_get_functiondef / pg_policies le
-- 2026-08-15). Elle est entièrement idempotente : sur le projet dev, où
-- ces objets existent déjà, elle ne change rien. Sur une base neuve,
-- elle les recrée dans le même état.
--
-- Aucune amélioration n'est apportée ici volontairement : l'objet de ce
-- lot est de mettre l'existant sous contrôle de version, pas de le
-- corriger. Les dettes relevées sont consignées dans PARKING_LOT.md.
-- ============================================================

-- ── Helper d'index ─────────────────────────────────────────
-- Nécessaire à l'index d'idempotence ci-dessous : date_trunc() n'est pas
-- IMMUTABLE sur timestamptz (dépend de TimeZone), donc inutilisable dans
-- un index. Ce wrapper fixe UTC, ce qui le rend légitimement immutable.
-- Pas SECURITY DEFINER, pas de données touchées : les droits d'exécution
-- par défaut (PUBLIC) sont conservés, comme en live.
CREATE OR REPLACE FUNCTION public.date_trunc_minute_immutable(ts timestamp with time zone)
 RETURNS timestamp with time zone
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE
AS $function$SELECT date_trunc('minute', ts AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'$function$;

-- ── Table ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.playbook_exports (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id        UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  playbook_id            UUID REFERENCES public.playbooks(id) ON DELETE SET NULL,
  exported_by_profile_id UUID REFERENCES public.profiles_(id) ON DELETE SET NULL,
  exported_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  account_count          INTEGER NOT NULL DEFAULT 0,
  mrr_at_risk_cents      INTEGER NOT NULL DEFAULT 0,
  filters_applied        JSONB NOT NULL DEFAULT '{}'::jsonb,
  format                 TEXT NOT NULL DEFAULT 'csv',
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- CHECK constraints (ADD CONSTRAINT n'a pas de IF NOT EXISTS avant PG 16 —
-- garde explicite pour rester rejouable).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'playbook_exports_account_count_check') THEN
    ALTER TABLE public.playbook_exports
      ADD CONSTRAINT playbook_exports_account_count_check CHECK (account_count >= 0);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'playbook_exports_mrr_at_risk_check') THEN
    ALTER TABLE public.playbook_exports
      ADD CONSTRAINT playbook_exports_mrr_at_risk_check CHECK (mrr_at_risk_cents >= 0);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'playbook_exports_format_check') THEN
    ALTER TABLE public.playbook_exports
      ADD CONSTRAINT playbook_exports_format_check CHECK (format = ANY (ARRAY['csv'::text, 'json'::text]));
  END IF;
END $$;

-- ── Index ──────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_playbook_exports_org
  ON public.playbook_exports USING btree (organization_id, exported_at DESC);

-- Index d'idempotence : deux exports identiques du même playbook dans la
-- même minute ne créent qu'une ligne. C'est ce 23505 que
-- export-playbook-accounts/index.ts avale explicitement.
CREATE UNIQUE INDEX IF NOT EXISTS idx_playbook_exports_idempotent
  ON public.playbook_exports USING btree (
    organization_id,
    playbook_id,
    format,
    filters_applied,
    public.date_trunc_minute_immutable(exported_at)
  );

-- ── RLS ────────────────────────────────────────────────────
ALTER TABLE public.playbook_exports ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS playbook_exports_org_isolation ON public.playbook_exports;
CREATE POLICY playbook_exports_org_isolation ON public.playbook_exports
  FOR ALL
  USING (
    (organization_id = public.user_organization_id())
    OR (public.user_role() = 'service_role'::text)
  );

-- ── RPC ────────────────────────────────────────────────────
-- Corps repris verbatim de pg_get_functiondef sur le projet.
CREATE OR REPLACE FUNCTION public.get_playbook_export_summary(p_playbook_id uuid, p_filters jsonb DEFAULT '{}'::jsonb)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_org_id UUID;
  v_playbook_org_id UUID;
  v_result JSON;
BEGIN
  -- Resolve caller's organization_id (RLS enforcement)
  v_org_id := public.user_organization_id();
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'Unauthorized: no organization context';
  END IF;

  -- Verify playbook belongs to caller's org
  SELECT organization_id INTO v_playbook_org_id
  FROM public.playbooks
  WHERE id = p_playbook_id;

  IF v_playbook_org_id IS NULL THEN
    RAISE EXCEPTION 'Playbook not found';
  END IF;

  IF v_playbook_org_id <> v_org_id THEN
    RAISE EXCEPTION 'Forbidden: cross-tenant access';
  END IF;

  -- Build summary
  WITH filtered_accounts AS (
    SELECT
      a.id,
      a.mrr_cents,
      a.churn_risk_score,
      a.health_score,
      a.contract_end_date,
      a.billing_interval,
      -- Priority calculation (same logic as Edge Function)
      CASE
        WHEN a.churn_risk_score >= 70
             AND a.contract_end_date IS NOT NULL
             AND (a.contract_end_date - CURRENT_DATE) < 30
          THEN 'P0'
        WHEN a.churn_risk_score >= 50
             OR (a.contract_end_date IS NOT NULL AND (a.contract_end_date - CURRENT_DATE) < 60)
          THEN 'P1'
        ELSE 'P2'
      END AS priority,
      -- Segment name via active membership
      cs.segment_type
    FROM public.accounts a
    LEFT JOIN public.segment_memberships sm
      ON sm.account_id = a.id
      AND sm.organization_id = v_org_id
      AND sm.status = 'active'
    LEFT JOIN public.account_segments cs
      ON cs.id = sm.segment_id
      AND cs.organization_id = v_org_id
    WHERE a.organization_id = v_org_id
      -- Apply optional filters
      AND (
        NOT (p_filters ? 'churn_risk_min')
        OR a.churn_risk_score >= (p_filters->>'churn_risk_min')::NUMERIC
      )
      AND (
        NOT (p_filters ? 'mrr_min_cents')
        OR a.mrr_cents >= (p_filters->>'mrr_min_cents')::INTEGER
      )
      AND (
        NOT (p_filters ? 'billing_interval')
        OR a.billing_interval = (p_filters->>'billing_interval')
      )
      AND (
        NOT (p_filters ? 'segment')
        OR cs.segment_type = (p_filters->>'segment')
      )
  )
  SELECT json_build_object(
    'total_accounts', COUNT(*),
    'total_mrr_at_risk_cents', COALESCE(SUM(
      CASE WHEN priority IN ('P0', 'P1') THEN mrr_cents ELSE 0 END
    ), 0),
    'by_priority', json_build_object(
      'P0', COUNT(*) FILTER (WHERE priority = 'P0'),
      'P1', COUNT(*) FILTER (WHERE priority = 'P1'),
      'P2', COUNT(*) FILTER (WHERE priority = 'P2')
    ),
    'by_segment', COALESCE(
      (SELECT json_object_agg(seg, cnt)
       FROM (
         SELECT COALESCE(segment_type, 'Non segmente') AS seg, COUNT(*) AS cnt
         FROM filtered_accounts
         GROUP BY segment_type
       ) sub),
      '{}'::JSON
    )
  ) INTO v_result
  FROM filtered_accounts;

  RETURN v_result;
END;
$function$;

-- Matrice de privilèges du Lot 1 (20260813000003) : aucune fonction
-- SECURITY DEFINER accessible à anon/PUBLIC ; `get_playbook_export_summary`
-- figure dans la liste des RPC applicatives accordées à `authenticated`
-- (elle dérive l'org via user_organization_id() en interne).
-- Rappelé explicitement ici : sur une base neuve, cette migration
-- s'exécute APRÈS le lockdown du Lot 1, donc la fonction naîtrait avec
-- l'EXECUTE par défaut de PUBLIC et échapperait à l'assertion CI a1.
-- Sur le projet dev, ces trois lignes reproduisent l'état déjà en place.
REVOKE ALL ON FUNCTION public.get_playbook_export_summary(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_playbook_export_summary(uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_playbook_export_summary(uuid, jsonb) TO service_role;
