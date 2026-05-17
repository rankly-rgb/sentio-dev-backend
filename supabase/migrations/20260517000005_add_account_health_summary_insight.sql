-- Add account_health_summary insight type
-- Fallback insight for paying accounts with no specific issue detected.
-- Guarantees at least 1 insight per paying account from Day 1 (onboarding).

ALTER TABLE public.ai_insights
  DROP CONSTRAINT IF EXISTS ai_insights_insight_type_check,
  ADD CONSTRAINT ai_insights_insight_type_check CHECK (
    insight_type = ANY (ARRAY[
      'churn_prediction','expansion_opportunity','renewal_alert',
      'payment_risk','usage_drop','account_health_summary'
    ])
  );
