-- ============================================================
-- Migration 001 : Fonctions prérequises (triggers & helpers RLS)
-- Doit être exécutée EN PREMIER avant toute table
-- ============================================================

-- ------------------------------------------------------------
-- 1. Trigger partagé : mise à jour automatique de updated_at
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

-- ------------------------------------------------------------
-- 2. Helper RLS : retourne l'organization_id de l'utilisateur
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.user_organization_id()
RETURNS UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT organization_id
  FROM public.profiles_
  WHERE auth_user_id = auth.uid()
  LIMIT 1
$$;

-- ------------------------------------------------------------
-- 3. Helper RLS : retourne le rôle JWT de l'utilisateur
--    Retourne 'service_role', 'authenticated' ou 'anon'
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.user_role()
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT COALESCE(
    current_setting('request.jwt.claims', true)::json->>'role',
    'anon'
  )
$$;
