-- ============================================================
-- Migration: signup trigger + trial_ends_at
-- Crée l'organisation et le profil automatiquement à chaque
-- inscription via Supabase Auth.
-- ============================================================

-- 1. Colonne trial_ends_at sur organizations
ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMPTZ NULL;

-- 2. Fonction trigger SECURITY DEFINER
CREATE OR REPLACE FUNCTION public.handle_new_user_signup()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  new_org_id UUID;
  org_name   TEXT;
BEGIN
  org_name := split_part(NEW.email, '@', 1);
  IF org_name IS NULL OR trim(org_name) = '' THEN
    org_name := 'Mon Organisation';
  END IF;

  INSERT INTO public.organizations (name, plan_type, trial_ends_at)
  VALUES (org_name, 'free', NOW() + INTERVAL '14 days')
  RETURNING id INTO new_org_id;

  INSERT INTO public.profiles_ (auth_user_id, organization_id, email, role)
  VALUES (NEW.id, new_org_id, NEW.email, 'admin');

  RETURN NEW;
END;
$$;

-- 3. Trigger sur auth.users
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user_signup();
