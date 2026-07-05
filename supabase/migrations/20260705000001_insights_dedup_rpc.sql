-- ============================================================
-- Migration : Deduplicated + prioritized insights listing
--
-- insights-crud returned every row matching the filters, ordered by a
-- single column, with no way to detect near-duplicate insights (same
-- account + type + day) once the caller requests multiple statuses.
-- The unique index idx_ai_insights_org_account_type_day (migration
-- 20260704000001) already prevents inserting more than one row per
-- (organization_id, account_id, insight_type, day) going forward, but
-- rows created before that migration — or belonging to different days —
-- can still look like duplicates to the caller. DISTINCT ON here is a
-- defense-in-depth safety net, not the primary dedup mechanism.
--
-- Note: this schema has no `detected_at` column — `created_at` is used
-- as its equivalent (see migration 20260704000001 for the same note).
-- ============================================================

CREATE OR REPLACE FUNCTION public.list_deduplicated_insights(
  p_organization_id UUID,
  p_status TEXT[] DEFAULT NULL,
  p_insight_type TEXT[] DEFAULT NULL,
  p_priority TEXT[] DEFAULT NULL,
  p_account_id UUID DEFAULT NULL,
  p_limit INTEGER DEFAULT 20,
  p_offset INTEGER DEFAULT 0
) RETURNS SETOF public.ai_insights
LANGUAGE SQL
STABLE
AS $$
  WITH deduped AS (
    SELECT DISTINCT ON (i.account_id, i.insight_type, (i.created_at AT TIME ZONE 'UTC')::date) i.*
    FROM public.ai_insights i
    WHERE i.organization_id = p_organization_id
      AND (p_status IS NULL OR i.status = ANY(p_status))
      AND (p_insight_type IS NULL OR i.insight_type = ANY(p_insight_type))
      AND (p_priority IS NULL OR i.priority = ANY(p_priority))
      AND (p_account_id IS NULL OR i.account_id = p_account_id)
    ORDER BY
      i.account_id, i.insight_type, (i.created_at AT TIME ZONE 'UTC')::date,
      CASE i.priority
        WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3
      END,
      i.mrr_impact_cents DESC NULLS LAST,
      i.created_at DESC
  )
  SELECT *
  FROM deduped
  ORDER BY
    CASE priority
      WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3
    END,
    mrr_impact_cents DESC NULLS LAST,
    created_at DESC
  LIMIT p_limit OFFSET p_offset;
$$;

CREATE OR REPLACE FUNCTION public.count_deduplicated_insights(
  p_organization_id UUID,
  p_status TEXT[] DEFAULT NULL,
  p_insight_type TEXT[] DEFAULT NULL,
  p_priority TEXT[] DEFAULT NULL,
  p_account_id UUID DEFAULT NULL
) RETURNS BIGINT
LANGUAGE SQL
STABLE
AS $$
  SELECT COUNT(*)
  FROM (
    SELECT DISTINCT ON (i.account_id, i.insight_type, (i.created_at AT TIME ZONE 'UTC')::date) i.id
    FROM public.ai_insights i
    WHERE i.organization_id = p_organization_id
      AND (p_status IS NULL OR i.status = ANY(p_status))
      AND (p_insight_type IS NULL OR i.insight_type = ANY(p_insight_type))
      AND (p_priority IS NULL OR i.priority = ANY(p_priority))
      AND (p_account_id IS NULL OR i.account_id = p_account_id)
    ORDER BY i.account_id, i.insight_type, (i.created_at AT TIME ZONE 'UTC')::date
  ) deduped;
$$;
