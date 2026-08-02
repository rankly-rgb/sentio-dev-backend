-- Migration : RPCs Vault manquantes pour update-stripe-connection
--
-- vault_create_secret / vault_read_secret sont déjà appelées ailleurs dans le
-- code (verify-stripe-token, _shared/vault.ts) mais ne sont définies dans
-- aucune migration (créées hors bande, avant l'adoption de cette convention
-- de versioning — cf. le trigger on_playbook_activate qui documente le même
-- constat pour playbook_trigger_secret).
--
-- Premier essai de cette migration (nommé vault_update_secret/
-- vault_delete_secret) a échoué en déploiement : "ERROR: cannot change name
-- of input parameter secret_id (SQLSTATE 42P13)" — preuve qu'une fonction
-- public.vault_update_secret existe DÉJÀ hors bande (comme vault_create_secret/
-- vault_read_secret) avec des noms de paramètres qu'on ne connaît pas, et que
-- CREATE OR REPLACE ne peut pas renommer. On ne peut donc pas savoir si
-- vault_delete_secret existe aussi sans risquer la même collision. Solution :
-- des noms qui ne collisionnent avec rien d'existant, pour rester
-- additive-only et garder le contrôle total de la signature appelée par
-- update-stripe-connection/index.ts.

CREATE OR REPLACE FUNCTION public.vault_replace_secret(p_secret_id uuid, p_new_secret text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault
AS $$
BEGIN
  PERFORM vault.update_secret(p_secret_id, new_secret => p_new_secret);
END;
$$;

CREATE OR REPLACE FUNCTION public.vault_remove_secret(p_secret_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault
AS $$
BEGIN
  DELETE FROM vault.secrets WHERE id = p_secret_id;
END;
$$;

-- Service role uniquement (mêmes appelants que vault_create_secret/vault_read_secret :
-- les Edge Functions via createServiceClient(), jamais le client anon/authenticated).
GRANT EXECUTE ON FUNCTION public.vault_replace_secret(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.vault_remove_secret(uuid) TO service_role;

COMMENT ON FUNCTION public.vault_replace_secret IS
  'Remplace en place un secret Vault existant (même id) — utilisé par update-stripe-connection pour éviter d''accumuler un nouveau secret orphelin à chaque mise à jour de clé.';
COMMENT ON FUNCTION public.vault_remove_secret IS
  'Supprime un secret Vault — utilisé par update-stripe-connection sur déconnexion, pour ne pas laisser une clé Stripe désactivée traîner indéfiniment.';
