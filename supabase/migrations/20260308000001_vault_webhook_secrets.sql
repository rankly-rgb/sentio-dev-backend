-- ============================================================
-- Migration : Chiffrement des secrets webhook via Supabase Vault
--
-- 1. Active l'extension supabase_vault (si pas deja presente)
-- 2. Ajoute vault_secret_id a webhook_configs
-- 3. Migre les secrets existants vers vault.secrets
-- 4. Rend webhook_secret nullable (fallback temporaire)
-- ============================================================

-- 1. Activer Supabase Vault
CREATE EXTENSION IF NOT EXISTS supabase_vault WITH SCHEMA vault;

-- 2. Ajouter la colonne vault_secret_id
ALTER TABLE public.webhook_configs
  ADD COLUMN IF NOT EXISTS vault_secret_id UUID NULL;

-- 3. Migrer les secrets existants vers vault.secrets
-- Pour chaque config ayant un webhook_secret en clair, creer un secret dans vault
DO $$
DECLARE
  rec RECORD;
  v_secret_id UUID;
BEGIN
  FOR rec IN
    SELECT id, webhook_secret
    FROM public.webhook_configs
    WHERE webhook_secret IS NOT NULL
      AND vault_secret_id IS NULL
  LOOP
    INSERT INTO vault.secrets (secret, name, description)
    VALUES (
      rec.webhook_secret,
      'wh_' || rec.id::text,
      'Webhook HMAC secret for config ' || rec.id::text
    )
    RETURNING id INTO v_secret_id;

    UPDATE public.webhook_configs
    SET vault_secret_id = v_secret_id
    WHERE id = rec.id;
  END LOOP;
END;
$$;

-- 4. Rendre webhook_secret nullable (les nouveaux secrets iront dans Vault)
ALTER TABLE public.webhook_configs
  ALTER COLUMN webhook_secret DROP NOT NULL;

-- 5. Commentaire pour documenter la transition
COMMENT ON COLUMN public.webhook_configs.vault_secret_id IS
  'Reference vers vault.secrets — source de verite pour le secret HMAC. webhook_secret en clair sera supprime apres migration complete.';

COMMENT ON COLUMN public.webhook_configs.webhook_secret IS
  'DEPRECATED: secret en clair, conserve temporairement comme fallback. Utiliser vault_secret_id.';
