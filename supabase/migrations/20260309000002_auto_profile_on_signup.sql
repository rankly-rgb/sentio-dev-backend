-- ============================================================
-- Migration : Auto-create profile on signup
-- Trigger AFTER INSERT on auth.users → creates profiles_ row
-- Links invitation (if any) to set organization_id + role
-- ============================================================

-- ------------------------------------------------------------
-- 1. Trigger function: handle_new_user
-- Called automatically when a new user signs up via Supabase Auth
-- Looks up invitations table to resolve organization_id + role
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  inv RECORD;
BEGIN
  -- Look for a valid, non-expired, non-accepted invitation for this email
  SELECT id, organization_id, role
  INTO inv
  FROM public.invitations
  WHERE email = NEW.email
    AND accepted_at IS NULL
    AND expires_at > NOW()
  ORDER BY created_at DESC
  LIMIT 1;

  -- Create profile with org from invitation (or NULL if no invitation)
  INSERT INTO public.profiles_ (auth_user_id, email, organization_id, role)
  VALUES (
    NEW.id,
    NEW.email,
    inv.organization_id,  -- NULL if no invitation found
    COALESCE(inv.role, 'member')
  );

  -- Mark invitation as accepted if one was found
  IF inv.id IS NOT NULL THEN
    UPDATE public.invitations
    SET accepted_at = NOW()
    WHERE id = inv.id;
  END IF;

  RETURN NEW;
END;
$$;

-- ------------------------------------------------------------
-- 2. Trigger on auth.users
-- ------------------------------------------------------------
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_user();

-- ------------------------------------------------------------
-- 3. Backfill: create missing profiles for existing auth users
-- Links existing invitations if available
-- ------------------------------------------------------------
DO $$
DECLARE
  auth_row RECORD;
  inv RECORD;
BEGIN
  FOR auth_row IN
    SELECT au.id, au.email
    FROM auth.users au
    LEFT JOIN public.profiles_ p ON p.auth_user_id = au.id
    WHERE p.id IS NULL
  LOOP
    -- Look for invitation
    SELECT id, organization_id, role
    INTO inv
    FROM public.invitations
    WHERE email = auth_row.email
      AND accepted_at IS NULL
      AND expires_at > NOW()
    ORDER BY created_at DESC
    LIMIT 1;

    INSERT INTO public.profiles_ (auth_user_id, email, organization_id, role)
    VALUES (
      auth_row.id,
      auth_row.email,
      inv.organization_id,
      COALESCE(inv.role, 'member')
    );

    IF inv.id IS NOT NULL THEN
      UPDATE public.invitations
      SET accepted_at = NOW()
      WHERE id = inv.id;
    END IF;
  END LOOP;
END;
$$;
