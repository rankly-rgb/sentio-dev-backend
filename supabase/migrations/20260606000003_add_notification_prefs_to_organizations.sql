-- ============================================================
-- Préférences de notification email par organisation
-- Utilisées par churn-alert et weekly-digest
-- ============================================================

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS notification_email TEXT,
  ADD COLUMN IF NOT EXISTS churn_alert_enabled BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS weekly_digest_enabled BOOLEAN NOT NULL DEFAULT true;

COMMENT ON COLUMN public.organizations.notification_email IS
  'Email de notification Sentio — destinataire des alertes churn et digest';
COMMENT ON COLUMN public.organizations.churn_alert_enabled IS
  'Activer les alertes email immédiates quand churn_risk_score >= 70';
COMMENT ON COLUMN public.organizations.weekly_digest_enabled IS
  'Activer le digest hebdomadaire chaque lundi matin';
