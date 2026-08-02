-- Migration : RPCs Vault manquantes pour update-stripe-connection
--
-- vault_create_secret / vault_read_secret sont déjà appelées ailleurs dans le
-- code (verify-stripe-token, _shared/vault.ts) mais ne sont définies dans
-- aucune migration (créées hors bande, avant l'adoption de cette convention
-- de versioning — cf. le trigger on_playbook_activate qui documente le même
-- constat pour playbook_trigger_secret). On ne les touche pas ici : leur
-- comportement actuel est inconnu et les redéfinir à l'aveugle risquerait de
-- casser un flux qui fonctionne déjà (onboarding Stripe/HubSpot).
--
-- Cette migration ajoute uniquement les deux RPCs manquantes nécessaires pour
-- que "mettre à jour la clé Stripe depuis Settings" remplace réellement le
-- secret existant au lieu d'en accumuler un nouveau à chaque appel :
--   - vault_update_secret : réécrit un secret existant en place (même id)
--   - vault_delete_secret : purge un secret (utilisé sur déconnexion)
-- Additive uniquement — aucune fonction existante n'est modifiée ou supprimée.

CREATE OR REPLACE FUNCTION public.vault_update_secret(p_secret_id uuid, p_new_secret text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault
AS $$
BEGIN
  PERFORM vault.update_secret(p_secret_id, new_secret => p_new_secret);
END;
$$;

CREATE OR REPLACE FUNCTION public.vault_delete_secret(p_secret_id uuid)
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
GRANT EXECUTE ON FUNCTION public.vault_update_secret(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.vault_delete_secret(uuid) TO service_role;

COMMENT ON FUNCTION public.vault_update_secret IS
  'Remplace en place un secret Vault existant (même id) — utilisé par update-stripe-connection pour éviter d''accumuler un nouveau secret orphelin à chaque mise à jour de clé.';
COMMENT ON FUNCTION public.vault_delete_secret IS
  'Supprime un secret Vault — utilisé par update-stripe-connection sur déconnexion, pour ne pas laisser une clé Stripe désactivée traîner indéfiniment.';
