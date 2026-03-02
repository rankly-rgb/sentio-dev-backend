-- ============================================================
-- Migration : Scoring & Segmentation Fixes
-- - Widen subscriptions.status CHECK (incomplete_expired, unpaid)
-- - Add 'scoring' to data_syncs.sync_source CHECK
-- - Seed 8 system segments per existing organization
-- ============================================================

-- 1. Widen subscriptions.status CHECK constraint
ALTER TABLE public.subscriptions DROP CONSTRAINT IF EXISTS subscriptions_status_check;
ALTER TABLE public.subscriptions ADD CONSTRAINT subscriptions_status_check CHECK (
  status = ANY (ARRAY['active','past_due','canceled','trialing','paused','incomplete','incomplete_expired','unpaid'])
);

-- 2. Add 'scoring' to data_syncs sync_source
ALTER TABLE public.data_syncs DROP CONSTRAINT IF EXISTS data_syncs_sync_source_check;
ALTER TABLE public.data_syncs ADD CONSTRAINT data_syncs_sync_source_check CHECK (
  sync_source = ANY (ARRAY['stripe','hubspot','usage','manual','scoring'])
);

-- 3. Partial unique index for system segments (one per org per type)
CREATE UNIQUE INDEX IF NOT EXISTS idx_account_segments_org_type_system
  ON public.account_segments (organization_id, segment_type)
  WHERE is_system_generated = TRUE;

-- 4. Seed 8 system segments for every existing organization
INSERT INTO public.account_segments
  (organization_id, segment_name, segment_type, priority, criteria, description, is_system_generated, is_active)
SELECT
  o.id,
  s.segment_name,
  s.segment_type,
  s.priority,
  s.criteria::jsonb,
  s.description,
  TRUE,
  TRUE
FROM public.organizations o
CROSS JOIN (VALUES
  ('Champions',            'champions',           'high',     '{"health_score_gte": 80}',                                  'Comptes en excellente sante'),
  ('En expansion',         'en_expansion',        'medium',   '{"expansion_score_gte": 70, "health_score_gte": 60}',       'Comptes avec potentiel d''expansion'),
  ('Stables',              'stables',             'low',      '{"health_score_gte": 40, "churn_risk_lt": 50}',             'Comptes stables sans risque'),
  ('A risque leger',       'a_risque_leger',      'medium',   '{"churn_risk_gte": 50, "churn_risk_lt": 70}',              'Comptes montrant des signes de risque'),
  ('En danger critique',   'en_danger_critique',  'critical', '{"churn_risk_gte": 70}',                                    'Comptes en danger imminent de churn'),
  ('Impayes',              'impayes',             'critical', '{"has_overdue_invoices": true}',                            'Comptes avec factures impayees'),
  ('En churn',             'en_churn',            'critical', '{"mrr_cents_eq": 0}',                                       'Comptes ayant churne'),
  ('Nouveaux (< 90j)',     'nouveaux',            'low',      '{"days_since_creation_lt": 90}',                            'Comptes crees il y a moins de 90 jours')
) AS s(segment_name, segment_type, priority, criteria, description)
WHERE NOT EXISTS (
  SELECT 1 FROM public.account_segments existing
  WHERE existing.organization_id = o.id
    AND existing.segment_type = s.segment_type
    AND existing.is_system_generated = TRUE
);
