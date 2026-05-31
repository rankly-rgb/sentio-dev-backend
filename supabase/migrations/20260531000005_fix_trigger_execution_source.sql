-- Fix : execution_source 'activation' n'est pas dans le CHECK constraint
-- CHECK (execution_source = ANY (ARRAY['manual','scheduled','threshold_triggered','insight_triggered']))
-- On utilise 'manual' pour les déclenchements via activation UI.

CREATE OR REPLACE FUNCTION public.on_playbook_activate()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
BEGIN
  IF NEW.status = 'active' AND (OLD.status IS DISTINCT FROM 'active') THEN

    IF NEW.segment_id IS NULL THEN
      RAISE NOTICE '[playbook_activate_trigger] Playbook % sans segment_id — exécution manuelle requise', NEW.id;
      RETURN NEW;
    END IF;

    PERFORM net.http_post(
      'https://upqakxuatlshhqiagbqw.supabase.co/functions/v1/playbook-execute',
      jsonb_build_object(
        'playbook_id',      NEW.id,
        'organization_id',  NEW.organization_id,
        'segment_id',       NEW.segment_id,
        'execution_source', 'manual'
      ),
      '{}'::jsonb,
      jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVwcWFreHVhdGxzaGhxaWFnYnF3Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MjMwODc3MSwiZXhwIjoyMDg3ODg0NzcxfQ.pBWrfqR_Wc7apcD4S6Cl0UbCkPwjbV1K3M0wDdFJkyk'
      ),
      5000
    );

    RAISE NOTICE '[playbook_activate_trigger] playbook-execute déclenché pour playbook % (org: %, segment: %)',
      NEW.id, NEW.organization_id, NEW.segment_id;
  END IF;

  RETURN NEW;
END;
$$;
