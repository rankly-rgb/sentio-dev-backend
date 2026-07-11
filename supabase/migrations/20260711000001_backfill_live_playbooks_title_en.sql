-- ============================================================
-- Backfill title_en / description_en sur les playbooks LIVE
-- (is_template = FALSE) restés en français.
--
-- 20260514000002 et 20260516000002 ont déjà backfillé ces mêmes
-- libellés mais uniquement pour is_template = TRUE, ratant les
-- instances org (playbooks "screenshot"/seed manuel V1 créées
-- avant l'introduction de title_en/description_en). Idempotent :
-- ne touche que title_en IS NULL, ne DROP/DELETE rien.
-- ============================================================

UPDATE public.playbooks
SET
  title_en = CASE
    WHEN title ILIKE '%upsell%sièges%saturés%'      THEN 'Seat Upsell — Capacity-Maxed Accounts'
    WHEN title ILIKE '%upsell%sieges%satures%'       THEN 'Seat Upsell — Capacity-Maxed Accounts'
    WHEN title ILIKE '%suivi%santé%comptes%growth%'  THEN 'Growth Account Health Monitoring'
    WHEN title ILIKE '%suivi%sante%comptes%growth%'  THEN 'Growth Account Health Monitoring'
    WHEN title ILIKE '%alerte churn%risque%élevé%'   THEN 'High Churn Risk Alert'
    WHEN title ILIKE '%alerte churn%risque%eleve%'   THEN 'High Churn Risk Alert'
    ELSE title_en
  END,
  description_en = CASE
    WHEN title ILIKE '%upsell%sièges%saturés%'      THEN 'Detects accounts using more than 80% of their available seats.'
    WHEN title ILIKE '%upsell%sieges%satures%'       THEN 'Detects accounts using more than 80% of their available seats.'
    WHEN title ILIKE '%suivi%santé%comptes%growth%'  THEN 'Weekly review of growth accounts with a declining health score.'
    WHEN title ILIKE '%suivi%sante%comptes%growth%'  THEN 'Weekly review of growth accounts with a declining health score.'
    WHEN title ILIKE '%alerte churn%risque%élevé%'   THEN 'Automatic notification when an account exceeds 70% churn risk score. Runs continuously.'
    WHEN title ILIKE '%alerte churn%risque%eleve%'   THEN 'Automatic notification when an account exceeds 70% churn risk score. Runs continuously.'
    ELSE description_en
  END,
  updated_at = NOW()
WHERE title_en IS NULL
  AND (
    title ILIKE '%upsell%sièges%saturés%'
    OR title ILIKE '%upsell%sieges%satures%'
    OR title ILIKE '%suivi%santé%comptes%growth%'
    OR title ILIKE '%suivi%sante%comptes%growth%'
    OR title ILIKE '%alerte churn%risque%élevé%'
    OR title ILIKE '%alerte churn%risque%eleve%'
  );
