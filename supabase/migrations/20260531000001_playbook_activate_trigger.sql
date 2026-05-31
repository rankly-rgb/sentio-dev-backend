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

-- 2. Stocker la clé service_role comme paramètre DB pour les triggers
--    (seul moyen d'authentifier les appels HTTP depuis PostgreSQL)
ALTER DATABASE postgres
  SET "app.supabase_url" TO 'https://upqakxuatlshhqiagbqw.supabase.co';

ALTER DATABASE postgres
  SET "app.service_role_key" TO 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVwcWFreHVhdGxzaGhxaWFnYnF3Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MjMwODc3MSwiZXhwIjoyMDg3ODg0NzcxfQ.pBWrfqR_Wc7apcD4S6Cl0UbCkPwjbV1K3M0wDdFJkyk';

-- 3. Recharger la configuration pour que les settings soient actifs immédiatement
SELECT pg_reload_conf();

-- 4. Fonction trigger : appelle playbook-execute via HTTP (fire-and-forget)
CREATE OR REPLACE FUNCTION public.on_playbook_activate()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_url        text;
  v_key        text;
  v_segment_id text;
  v_body       text;
BEGIN
  -- Uniquement sur transition vers 'active' (pas sur création ni re-save sans changement)
  IF NEW.status = 'active' AND (OLD.status IS DISTINCT FROM 'active') THEN
    v_url := current_setting('app.supabase_url', true);
    v_key := current_setting('app.service_role_key', true);

    -- Sécurité : ne pas déclencher si la config est absente
    IF v_url IS NULL OR v_url = '' OR v_key IS NULL OR v_key = '' THEN
      RAISE WARNING '[playbook_activate_trigger] app.supabase_url ou app.service_role_key non configuré — exécution ignorée pour playbook %', NEW.id;
      RETURN NEW;
    END IF;

    -- Construire le body (segment_id peut être NULL : playbook-execute gère le cas)
    IF NEW.segment_id IS NOT NULL THEN
      v_body := json_build_object(
        'playbook_id',    NEW.id,
        'organization_id', NEW.organization_id,
        'segment_id',     NEW.segment_id,
        'execution_source', 'activation'
      )::text;
    ELSE
      -- Pas de segment : l'exécution ne peut pas être automatisée sans account_ids
      RAISE NOTICE '[playbook_activate_trigger] Playbook % sans segment_id — exécution manuelle requise', NEW.id;
      RETURN NEW;
    END IF;

    -- Appel HTTP fire-and-forget vers playbook-execute
    PERFORM net.http_post(
      url                 := v_url || '/functions/v1/playbook-execute',
      headers             := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || v_key
      ),
      body                := v_body,
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
