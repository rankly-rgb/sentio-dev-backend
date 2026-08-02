-- Fix : suppression de la clé service_role hardcodée dans on_playbook_activate.
--
-- La clé était dupliquée en clair dans 3 migrations précédentes
-- (20260531000001, 20260531000003, 20260531000005) — un secret service_role
-- committé dans l'historique git est un secret compromis, indépendamment de
-- ce correctif.
--
-- playbook-execute (index.ts) possède déjà un chemin d'auth interne dédié
-- via la variable d'env PLAYBOOK_TRIGGER_SECRET (comparaison exacte de
-- token, distincte du service_role JWT) — jamais branché côté trigger
-- jusqu'ici. On le branche ici : le trigger lit le secret depuis Supabase
-- Vault (jamais en clair dans le SQL) et l'envoie tel quel en Authorization.
--
-- Action manuelle requise après merge (ne peut pas être automatisée depuis
-- une migration sans re-hardcoder un secret dans git) :
--   1. Dashboard Supabase → SQL Editor, exécuter avec une valeur aléatoire forte :
--        select vault.create_secret(
--          '<valeur aléatoire forte, ex: openssl rand -hex 32>',
--          'playbook_trigger_secret',
--          'Secret partagé on_playbook_activate -> playbook-execute (auth interne trigger)'
--        );
--   2. Dashboard Supabase → Edge Functions → Secrets, définir avec LA MÊME valeur :
--        PLAYBOOK_TRIGGER_SECRET=<la même valeur aléatoire qu'à l'étape 1>
--   3. Rotation de l'ancienne clé service_role (exposée en clair dans l'historique git
--      des migrations 20260531000001/3/5) — obligatoire indépendamment des étapes 1-2.
--
-- Tant que le secret Vault n'existe pas encore, le trigger no-op proprement
-- (RAISE NOTICE, RETURN NEW) — même comportement dégradé que le cas
-- segment_id IS NULL déjà géré ci-dessous. Pas de régression bloquante
-- pendant la fenêtre entre le merge de cette migration et l'étape manuelle 1-2.

CREATE OR REPLACE FUNCTION public.on_playbook_activate()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  trigger_secret TEXT;
BEGIN
  IF NEW.status = 'active' AND (OLD.status IS DISTINCT FROM 'active') THEN

    IF NEW.segment_id IS NULL THEN
      RAISE NOTICE '[playbook_activate_trigger] Playbook % sans segment_id — exécution manuelle requise', NEW.id;
      RETURN NEW;
    END IF;

    SELECT decrypted_secret INTO trigger_secret
    FROM vault.decrypted_secrets
    WHERE name = 'playbook_trigger_secret'
    LIMIT 1;

    IF trigger_secret IS NULL THEN
      RAISE NOTICE '[playbook_activate_trigger] Secret Vault playbook_trigger_secret absent — exécution manuelle requise pour playbook %', NEW.id;
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
        'Authorization', 'Bearer ' || trigger_secret
      ),
      5000
    );

    RAISE NOTICE '[playbook_activate_trigger] playbook-execute déclenché pour playbook % (org: %, segment: %)',
      NEW.id, NEW.organization_id, NEW.segment_id;
  END IF;

  RETURN NEW;
END;
$$;
