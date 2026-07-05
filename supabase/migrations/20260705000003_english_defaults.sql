-- ============================================================
-- Migration : Standardize display defaults on American English
-- Product decision: American English (en-US) is now the sole
-- display language. Updates default column values and backfills
-- rows still holding the old French defaults (dev phase — no
-- customer-entered data is overwritten, only untouched defaults).
-- ============================================================

ALTER TABLE public.org_preferences
  ALTER COLUMN segment_name_champions SET DEFAULT 'Champions',
  ALTER COLUMN segment_name_at_risk   SET DEFAULT 'Slightly at Risk',
  ALTER COLUMN segment_name_danger    SET DEFAULT 'At Risk',
  ALTER COLUMN segment_name_stable    SET DEFAULT 'Stable';

UPDATE public.org_preferences
SET segment_name_at_risk = 'Slightly at Risk'
WHERE segment_name_at_risk = 'À risque léger';

UPDATE public.org_preferences
SET segment_name_danger = 'At Risk'
WHERE segment_name_danger = 'En danger';

UPDATE public.org_preferences
SET segment_name_stable = 'Stable'
WHERE segment_name_stable = 'Stables';

-- System-generated segments seeded in French by earlier migrations
UPDATE public.account_segments
SET segment_name = CASE segment_type
      WHEN 'en_expansion'       THEN 'Expanding'
      WHEN 'stables'            THEN 'Stable'
      WHEN 'a_risque_leger'     THEN 'Slightly at Risk'
      WHEN 'en_danger_critique' THEN 'Critical Danger'
      WHEN 'impayes'            THEN 'Unpaid'
      WHEN 'en_churn'           THEN 'Churned'
      WHEN 'nouveaux'           THEN 'New (< 90d)'
      ELSE segment_name
    END,
    description = CASE segment_type
      WHEN 'champions'          THEN 'Accounts in excellent health'
      WHEN 'en_expansion'       THEN 'Accounts with expansion potential'
      WHEN 'stables'            THEN 'Stable accounts with no risk'
      WHEN 'a_risque_leger'     THEN 'Accounts showing signs of risk'
      WHEN 'en_danger_critique' THEN 'Accounts in imminent danger of churning'
      WHEN 'impayes'            THEN 'Accounts with overdue invoices'
      WHEN 'en_churn'           THEN 'Accounts that have churned'
      WHEN 'nouveaux'           THEN 'Accounts created less than 90 days ago'
      ELSE description
    END
WHERE is_system_generated = true;
