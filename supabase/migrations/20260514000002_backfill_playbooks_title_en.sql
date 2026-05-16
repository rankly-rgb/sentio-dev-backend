-- ============================================================
-- Migration : Backfill title_en / description_en sur les
-- templates de playbooks existants.
-- Couvre les titres issus du seed script V1 et V2.
-- ============================================================

UPDATE public.playbooks
SET
  title_en = CASE
    -- Screenshot titles (V1 seed / manual)
    WHEN title ILIKE '%prévention churn%enterprise%'       THEN 'Churn Prevention — Enterprise Accounts'
    WHEN title ILIKE '%relance%comptes%inactifs%'          THEN 'Re-engagement of Inactive Accounts'
    WHEN title ILIKE '%détection%opportunité%expansion%'   THEN 'Expansion Opportunity Detection'
    WHEN title ILIKE '%onboarding%nouveaux%comptes%'       THEN 'New Accounts Onboarding'
    WHEN title ILIKE '%suivi%renouvellement%contrat%'      THEN 'Contract Renewal Follow-up'
    WHEN title ILIKE '%récupération%comptes%perdus%'       THEN 'Lost Accounts Recovery'
    -- Seed script V2 titles (15 templates)
    WHEN title ILIKE '%alerte churn critique%'             THEN 'Critical Churn Alert'
    WHEN title ILIKE '%onboarding accelere%'               THEN 'Fast-track Onboarding'
    WHEN title ILIKE '%expansion upsell sieges%'           THEN 'Seat Expansion Upsell'
    WHEN title ILIKE '%relance comptes inactifs%'          THEN 'Re-engagement of Inactive Accounts'
    WHEN title ILIKE '%renouvellement contrat%'            THEN 'Contract Renewal Sequence'
    WHEN title ILIKE '%prevention churn enterprise%'       THEN 'Enterprise Churn Prevention'
    WHEN title ILIKE '%adoption progressive feature%'      THEN 'Progressive Feature Adoption'
    WHEN title ILIKE '%nps detracteurs recovery%'          THEN 'NPS Detractors Recovery'
    WHEN title ILIKE '%champions advocacy%'                THEN 'Champions Advocacy'
    WHEN title ILIKE '%multi-touch growth nurturing%'      THEN 'Multi-touch Growth Nurturing'
    WHEN title ILIKE '%downgrade prevention%'              THEN 'Downgrade Prevention'
    WHEN title ILIKE '%success planning strategique%'      THEN 'Strategic Success Planning'
    WHEN title ILIKE '%payment failure recovery%'          THEN 'Payment Failure Recovery'
    WHEN title ILIKE '%health monitoring weekly%'          THEN 'Weekly Health Monitoring'
    WHEN title ILIKE '%customer education certification%'  THEN 'Customer Education Certification'
    ELSE NULL
  END,
  description_en = CASE
    -- Screenshot titles (V1 seed / manual)
    WHEN title ILIKE '%prévention churn%enterprise%'       THEN 'Retention playbook targeting enterprise accounts with high churn risk.'
    WHEN title ILIKE '%relance%comptes%inactifs%'          THEN 'Re-activates dormant accounts before inactivity leads to churn.'
    WHEN title ILIKE '%détection%opportunité%expansion%'   THEN 'Identifies accounts with high seat usage and a strong health score. Creates an upsell opportunity.'
    WHEN title ILIKE '%onboarding%nouveaux%comptes%'       THEN 'Accompanies accounts created less than 30 days ago. Assigns a CSM, schedules a check-in and sends a welcome sequence.'
    WHEN title ILIKE '%suivi%renouvellement%contrat%'      THEN 'Alerts 60 days before contract expiry. Prepares the renewal file and schedules a review meeting.'
    WHEN title ILIKE '%récupération%comptes%perdus%'       THEN 'Targets recently churned accounts with significant MRR. Triggers a winback campaign.'
    -- Seed script V2 titles (15 templates)
    WHEN title ILIKE '%alerte churn critique%'             THEN 'Immediate escalation to save accounts in critical danger. 4 steps over 10 days.'
    WHEN title ILIKE '%onboarding accelere%'               THEN 'Guides new accounts (< 90 days) to First Value within 14 days. 6 steps over 60 days.'
    WHEN title ILIKE '%expansion upsell sieges%'           THEN 'Converts seat saturation into license expansion. 4 steps over 14 days.'
    WHEN title ILIKE '%relance comptes inactifs%'          THEN 'Re-activates dormant accounts before inactivity leads to churn. 4 steps over 20 days.'
    WHEN title ILIKE '%renouvellement contrat%'            THEN 'Anticipatory renewal sequence over 90 days for annual contracts. 6 steps.'
    WHEN title ILIKE '%prevention churn enterprise%'       THEN 'Ultra-priority protection for strategic accounts (ARR > 50K EUR). 5 steps over 14 days.'
    WHEN title ILIKE '%adoption progressive feature%'      THEN 'Maximise feature adoption to increase stickiness. 4 steps over 14 days.'
    WHEN title ILIKE '%nps detracteurs recovery%'          THEN 'Turn a negative experience into a loyalty opportunity (Service Recovery Paradox). 5 steps over 30 days.'
    WHEN title ILIKE '%champions advocacy%'                THEN 'Transform satisfied customers into active brand ambassadors. 4 steps over 14 days.'
    WHEN title ILIKE '%multi-touch growth nurturing%'      THEN 'Maximise retention and expansion with a scalable model for Growth accounts (MRR 2K–10K EUR). 5 steps over 90 days.'
    WHEN title ILIKE '%downgrade prevention%'              THEN 'Understand reasons and propose alternatives to a full downgrade. 5 steps over 3 days.'
    WHEN title ILIKE '%success planning strategique%'      THEN 'Co-build a success plan aligned with customer OKRs. 5 steps over 90 days.'
    WHEN title ILIKE '%payment failure recovery%'          THEN 'Recover failed payments without friction. Smart dunning in 8 steps over 30 days.'
    WHEN title ILIKE '%health monitoring weekly%'          THEN 'Early detection of degradation before it becomes critical. Automated weekly analysis.'
    WHEN title ILIKE '%customer education certification%'  THEN 'Increase adoption and stickiness through structured training. Certification programme in 6 steps over 60 days.'
    ELSE NULL
  END
WHERE is_template = TRUE
  AND title_en IS NULL;
