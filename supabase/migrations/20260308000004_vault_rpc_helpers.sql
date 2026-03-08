-- ============================================================
-- Migration : RPC helpers pour acceder au schema vault
-- Le client Supabase JS .from() cible le schema public par defaut.
-- Ces fonctions SECURITY DEFINER permettent d'acceder a vault.secrets
-- depuis les Edge Functions via .rpc().
-- ============================================================

-- Lire un secret dechiffre par ID
CREATE OR REPLACE FUNCTION public.vault_read_secret(secret_id UUID)
RETURNS TABLE(decrypted_secret TEXT) LANGUAGE sql SECURITY DEFINER
SET search_path = public
AS $$
  SELECT decrypted_secret
  FROM vault.decrypted_secrets
  WHERE id = secret_id;
$$;

-- Stocker un nouveau secret, retourne l'UUID
CREATE OR REPLACE FUNCTION public.vault_store_secret(
  p_secret TEXT,
  p_name TEXT,
  p_description TEXT DEFAULT ''
)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  new_id UUID;
BEGIN
  INSERT INTO vault.secrets (secret, name, description)
  VALUES (p_secret, p_name, p_description)
  RETURNING id INTO new_id;
  RETURN new_id;
END;
$$;

-- Mettre a jour un secret existant
CREATE OR REPLACE FUNCTION public.vault_update_secret(
  secret_id UUID,
  new_secret TEXT
)
RETURNS VOID LANGUAGE sql SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE vault.secrets
  SET secret = new_secret, updated_at = now()
  WHERE id = secret_id;
$$;

-- Supprimer un secret
CREATE OR REPLACE FUNCTION public.vault_delete_secret(secret_id UUID)
RETURNS VOID LANGUAGE sql SECURITY DEFINER
SET search_path = public
AS $$
  DELETE FROM vault.secrets WHERE id = secret_id;
$$;

-- Seul le service_role peut appeler ces fonctions
REVOKE ALL ON FUNCTION public.vault_read_secret(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.vault_read_secret(UUID) TO service_role;

REVOKE ALL ON FUNCTION public.vault_store_secret(TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.vault_store_secret(TEXT, TEXT, TEXT) TO service_role;

REVOKE ALL ON FUNCTION public.vault_update_secret(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.vault_update_secret(UUID, TEXT) TO service_role;

REVOKE ALL ON FUNCTION public.vault_delete_secret(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.vault_delete_secret(UUID) TO service_role;
