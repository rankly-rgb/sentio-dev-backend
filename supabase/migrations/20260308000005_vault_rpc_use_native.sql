-- ============================================================
-- Fix : utiliser les fonctions natives vault.create_secret()
-- au lieu d'INSERT direct dans vault.secrets (qui require
-- les permissions pgsodium pour le chiffrement).
-- ============================================================

-- Stocker : utilise vault.create_secret() (native, gere le chiffrement)
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
  SELECT vault.create_secret(p_secret, p_name, p_description) INTO new_id;
  RETURN new_id;
END;
$$;

-- Mettre a jour : utilise vault.update_secret() (native)
CREATE OR REPLACE FUNCTION public.vault_update_secret(
  secret_id UUID,
  new_secret TEXT
)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM vault.update_secret(secret_id, new_secret);
END;
$$;
