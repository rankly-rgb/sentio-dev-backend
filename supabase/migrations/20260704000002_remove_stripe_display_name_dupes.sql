-- ============================================================
-- Migration : Suppression des comptes doublons par display_name
--
-- Contexte : le Stripe test account contient plusieurs customers
-- ayant le même nom (display_name) mais des stripe_customer_id
-- distincts au sein de la même organisation. Ces doublons ont
-- été seedés directement en DB et n'existent pas dans Stripe.
--
-- Stratégie keeper : par groupe (organization_id, display_name),
-- on garde le customer avec le plus de subscriptions,
-- tie-break : plus de factures, tie-break : stripe_customer_id ASC.
-- Les autres sont supprimés (CASCADE sur subscriptions, invoices,
-- mrr_movements, usage_events, score_history, segment_memberships,
-- ai_insights, playbook_executions, etc.)
--
-- Idempotent : le DO block ne fait rien si aucun doublon n'existe.
-- ============================================================

DO $$
DECLARE
  dup_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO dup_count
  FROM (
    SELECT 1
    FROM public.accounts
    WHERE stripe_customer_id IS NOT NULL
      AND display_name IS NOT NULL
    GROUP BY organization_id, display_name
    HAVING COUNT(DISTINCT stripe_customer_id) > 1
  ) t;

  IF dup_count = 0 THEN
    RAISE NOTICE 'No display_name duplicates found — skipping.';
    RETURN;
  END IF;

  RAISE NOTICE 'Found % duplicate (org, display_name) groups — starting cleanup.', dup_count;

  DELETE FROM public.accounts
  WHERE id IN (
    SELECT id FROM (
      SELECT
        a.id,
        ROW_NUMBER() OVER (
          PARTITION BY a.organization_id, a.display_name
          ORDER BY
            (SELECT COUNT(*) FROM public.subscriptions s WHERE s.account_id = a.id) DESC,
            (SELECT COUNT(*) FROM public.invoices i    WHERE i.account_id = a.id) DESC,
            a.stripe_customer_id ASC
        ) AS rn
      FROM public.accounts a
      WHERE a.stripe_customer_id IS NOT NULL
        AND a.display_name IS NOT NULL
        AND (a.organization_id, a.display_name) IN (
          SELECT organization_id, display_name
          FROM public.accounts
          WHERE stripe_customer_id IS NOT NULL AND display_name IS NOT NULL
          GROUP BY organization_id, display_name
          HAVING COUNT(DISTINCT stripe_customer_id) > 1
        )
    ) ranked
    WHERE rn > 1
  );

  RAISE NOTICE 'Duplicate display_name accounts removed (CASCADE applied).';
END;
$$;
