-- ============================================================
-- accounts_with_priority : translate priority_label to English
-- Product decision: American English (en-US) is the sole display
-- language. CREATE OR REPLACE keeps the view definition idempotent.
-- ============================================================
--
-- priority_label (decreasing priority, mutually exclusive):
--   1. 'critical'   : churn_risk_score >= 80 OR health_score <= 30
--   2. 'watch'      : churn_risk_score >= 50 OR health_score <= 55
--   3. 'new'        : created_at within the last 90 days AND churn_risk_score < 50
--   4. 'stable'     : all other cases

CREATE OR REPLACE VIEW public.accounts_with_priority
WITH (security_invoker = true) AS
SELECT
  a.*,
  CASE
    WHEN a.churn_risk_score >= 80 OR a.health_score <= 30 THEN 'critical'
    WHEN a.churn_risk_score >= 50 OR a.health_score <= 55 THEN 'watch'
    WHEN a.created_at >= (now() - interval '90 days') AND a.churn_risk_score < 50 THEN 'new'
    ELSE 'stable'
  END AS priority_label
FROM public.accounts a;

GRANT SELECT ON public.accounts_with_priority TO authenticated, service_role;
