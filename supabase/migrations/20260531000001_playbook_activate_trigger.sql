-- ============================================================
-- Migration : Trigger d'exécution automatique des playbooks
--
-- Quand un playbook passe en statut 'active' (via transition_playbook_status),
-- appelle playbook-execute en fire-and-forget via pg_net pour que les
-- actions (HubSpot sequences, etc.) soient déclenchées immédiatement.
--
-- Architecture :
--   transition_playbook_status (RPC) → UPDATE playbooks.status
--   → trigger on_playbook_activate → net.http_post(playbook-execute)
--   → playbook-execute → dispatchAction → HubSpot enrollInSequence
-- ============================================================

-- 1. Activer pg_net (disponible sur tous les projets Supabase)
CREATE EXTENSION IF NOT EXISTS pg_net;

-- 2. Fonction trigger : appelle playbook-execute via HTTP (fire-and-forget)
--    URL et clé hardcodées car ALTER DATABASE SET requiert superuser sur Supabase.
--    La service_role_key est project-specific, non-rotative sauf action explicite.
CREATE OR REPLACE FUNCTION public.on_playbook_activate()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_body text;
BEGIN
  -- Uniquement sur transition vers 'active' (pas sur création ni re-save sans changement)
  IF NEW.status = 'active' AND (OLD.status IS DISTINCT FROM 'active') THEN

    IF NEW.segment_id IS NULL THEN
      -- Pas de segment : impossible de déterminer les comptes sans account_ids
      RAISE NOTICE '[playbook_activate_trigger] Playbook % sans segment_id — exécution manuelle requise', NEW.id;
      RETURN NEW;
    END IF;

    v_body := json_build_object(
      'playbook_id',      NEW.id,
      'organization_id',  NEW.organization_id,
      'segment_id',       NEW.segment_id,
      'execution_source', 'activation'
    )::text;

    -- Appel HTTP fire-and-forget vers playbook-execute
    PERFORM net.http_post(
      url                  := 'https://upqakxuatlshhqiagbqw.supabase.co/functions/v1/playbook-execute',
      headers              := jsonb_build_object(
        'Content-Type',   'application/json',
        'Authorization',  'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVwcWFreHVhdGxzaGhxaWFnYnF3Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MjMwODc3MSwiZXhwIjoyMDg3ODg0NzcxfQ.pBWrfqR_Wc7apcD4S6Cl0UbCkPwjbV1K3M0wDdFJkyk'
      ),
      body                 := v_body,
      timeout_milliseconds := 5000
    );

    RAISE NOTICE '[playbook_activate_trigger] playbook-execute déclenché pour playbook % (org: %, segment: %)',
      NEW.id, NEW.organization_id, NEW.segment_id;
  END IF;

  RETURN NEW;
END;
$$;

-- 5. Attacher le trigger sur la table playbooks
DROP TRIGGER IF EXISTS on_playbook_activate ON public.playbooks;

CREATE TRIGGER on_playbook_activate
  AFTER UPDATE OF status ON public.playbooks
  FOR EACH ROW
  EXECUTE FUNCTION public.on_playbook_activate();

-- 6. Commentaires
COMMENT ON FUNCTION public.on_playbook_activate() IS
  'Déclenche playbook-execute via pg_net quand un playbook passe en statut active.';
