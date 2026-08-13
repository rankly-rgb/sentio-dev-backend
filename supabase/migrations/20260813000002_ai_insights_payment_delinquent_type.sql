-- Add payment_delinquent insight type (issue #36)
-- Dedicated insight for accounts.is_delinquent, pendant of payment_risk for
-- the subscription-status proxy (Stripe past_due/unpaid) rather than the
-- invoice-based one. See _shared/insight-rules.ts::evaluatePaymentDelinquent.

ALTER TABLE public.ai_insights
  DROP CONSTRAINT IF EXISTS ai_insights_insight_type_check,
  ADD CONSTRAINT ai_insights_insight_type_check CHECK (
    insight_type = ANY (ARRAY[
      'churn_prediction','expansion_opportunity','renewal_alert',
      'payment_risk','payment_delinquent','usage_drop','account_health_summary'
    ])
  );
