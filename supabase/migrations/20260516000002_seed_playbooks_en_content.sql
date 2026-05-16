-- ============================================================
-- Migration : Seed contenu EN pour les 9 playbooks par défaut
-- Idempotent : UPDATE ciblé par ILIKE sur le titre FR.
-- Ne touche que is_template = TRUE.
-- ============================================================

UPDATE public.playbooks
SET
  title_en = CASE
    WHEN title ILIKE '%alerte churn%risque%élevé%'            THEN 'High Churn Risk Alert'
    WHEN title ILIKE '%alerte churn%risque%eleve%'            THEN 'High Churn Risk Alert'
    WHEN title ILIKE '%prévention churn%enterprise%'          THEN 'Churn Prevention — Enterprise Accounts'
    WHEN title ILIKE '%prevention churn%enterprise%'          THEN 'Churn Prevention — Enterprise Accounts'
    WHEN title ILIKE '%relance%comptes%inactifs%'             THEN 'Re-engagement of Inactive Accounts'
    WHEN title ILIKE '%re-engagement%inactive%'               THEN 'Re-engagement of Inactive Accounts'
    WHEN title ILIKE '%détection%opportunité%expansion%'      THEN 'Expansion Opportunity Detection'
    WHEN title ILIKE '%detection%opportunite%expansion%'      THEN 'Expansion Opportunity Detection'
    WHEN title ILIKE '%expansion opportunity%detection%'      THEN 'Expansion Opportunity Detection'
    WHEN title ILIKE '%onboarding%nouveaux%comptes%'          THEN 'New Accounts Onboarding'
    WHEN title ILIKE '%new%accounts%onboarding%'              THEN 'New Accounts Onboarding'
    WHEN title ILIKE '%suivi%renouvellement%contrat%'         THEN 'Contract Renewal Follow-up'
    WHEN title ILIKE '%contract renewal%follow%'              THEN 'Contract Renewal Follow-up'
    WHEN title ILIKE '%récupération%comptes%perdus%'          THEN 'Lost Accounts Recovery'
    WHEN title ILIKE '%recuperation%comptes%perdus%'          THEN 'Lost Accounts Recovery'
    WHEN title ILIKE '%lost%accounts%recovery%'               THEN 'Lost Accounts Recovery'
    WHEN title ILIKE '%suivi%santé%comptes%growth%'           THEN 'Growth Accounts Health Monitoring'
    WHEN title ILIKE '%suivi%sante%comptes%growth%'           THEN 'Growth Accounts Health Monitoring'
    WHEN title ILIKE '%upsell%sièges%saturés%'                THEN 'Seat Upsell — At-Capacity Accounts'
    WHEN title ILIKE '%upsell%sieges%satures%'                THEN 'Seat Upsell — At-Capacity Accounts'
    ELSE title_en  -- conserver la valeur existante
  END,
  description_en = CASE
    WHEN title ILIKE '%alerte churn%risque%élevé%'            THEN 'Automatic notification when an account exceeds 70% churn risk. Runs continuously.'
    WHEN title ILIKE '%alerte churn%risque%eleve%'            THEN 'Automatic notification when an account exceeds 70% churn risk. Runs continuously.'
    WHEN title ILIKE '%prévention churn%enterprise%'          THEN 'Retention playbook targeting enterprise accounts with high churn risk. Triggers a Slack alert and creates a task.'
    WHEN title ILIKE '%prevention churn%enterprise%'          THEN 'Retention playbook targeting enterprise accounts with high churn risk. Triggers a Slack alert and creates a task.'
    WHEN title ILIKE '%relance%comptes%inactifs%'             THEN 'Re-activates dormant accounts before inactivity leads to churn.'
    WHEN title ILIKE '%re-engagement%inactive%'               THEN 'Re-activates dormant accounts before inactivity leads to churn.'
    WHEN title ILIKE '%détection%opportunité%expansion%'      THEN 'Identifies accounts with high seat usage and a strong health score. Creates an upsell opportunity.'
    WHEN title ILIKE '%detection%opportunite%expansion%'      THEN 'Identifies accounts with high seat usage and a strong health score. Creates an upsell opportunity.'
    WHEN title ILIKE '%expansion opportunity%detection%'      THEN 'Identifies accounts with high seat usage and a strong health score. Creates an upsell opportunity.'
    WHEN title ILIKE '%onboarding%nouveaux%comptes%'          THEN 'Accompanies accounts created less than 30 days ago. Assigns a CSM, schedules a check-in and sends a welcome sequence.'
    WHEN title ILIKE '%new%accounts%onboarding%'              THEN 'Accompanies accounts created less than 30 days ago. Assigns a CSM, schedules a check-in and sends a welcome sequence.'
    WHEN title ILIKE '%suivi%renouvellement%contrat%'         THEN 'Alerts 60 days before contract expiry. Prepares the renewal file and schedules a review meeting.'
    WHEN title ILIKE '%contract renewal%follow%'              THEN 'Alerts 60 days before contract expiry. Prepares the renewal file and schedules a review meeting.'
    WHEN title ILIKE '%récupération%comptes%perdus%'          THEN 'Targets recently churned accounts with significant MRR. Triggers a winback campaign.'
    WHEN title ILIKE '%recuperation%comptes%perdus%'          THEN 'Targets recently churned accounts with significant MRR. Triggers a winback campaign.'
    WHEN title ILIKE '%lost%accounts%recovery%'               THEN 'Targets recently churned accounts with significant MRR. Triggers a winback campaign.'
    WHEN title ILIKE '%suivi%santé%comptes%growth%'           THEN 'Weekly review of growth accounts with a declining health score.'
    WHEN title ILIKE '%suivi%sante%comptes%growth%'           THEN 'Weekly review of growth accounts with a declining health score.'
    WHEN title ILIKE '%upsell%sièges%saturés%'                THEN 'Detects accounts using more than 80% of their available seats.'
    WHEN title ILIKE '%upsell%sieges%satures%'                THEN 'Detects accounts using more than 80% of their available seats.'
    ELSE description_en  -- conserver la valeur existante
  END
WHERE is_template = TRUE;
