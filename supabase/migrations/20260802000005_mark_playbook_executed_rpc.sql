-- RPC : transition atomique playbook_runs 'exported' -> 'executed'.
-- Appelée uniquement depuis export-playbook-csv (service_role client,
-- org_id déjà vérifié par verifyUserAuth côté Edge Function avant
-- l'appel RPC) — pas exposée directement au navigateur, même
-- convention que increment_playbook_kpis (20260528000001).
-- No-op silencieux si le run n'existe pas / n'appartient pas à l'org /
-- n'est pas au statut 'exported' (évite une double transition et une
-- fuite d'information cross-tenant via le code d'erreur).

CREATE OR REPLACE FUNCTION public.mark_playbook_executed(
  p_run_id UUID,
  p_organization_id UUID,
  p_executed_by UUID DEFAULT NULL
)
RETURNS TABLE (updated BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_updated_count INTEGER;
BEGIN
  UPDATE public.playbook_runs
  SET status = 'executed',
      executed_at = NOW(),
      executed_by = p_executed_by
  WHERE id = p_run_id
    AND organization_id = p_organization_id
    AND status = 'exported';

  GET DIAGNOSTICS v_updated_count = ROW_COUNT;
  RETURN QUERY SELECT (v_updated_count > 0);
END;
$$;
