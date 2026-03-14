-- ============================================================
-- Migration : Fix profiles with NULL organization_id
--
-- Root cause : users created without a valid invitation get
-- organization_id = NULL in profiles_, which causes:
--   - user_organization_id() returns NULL
--   - RLS blocks ALL table access (ai_insights, accounts, etc.)
--   - verifyUserAuth() throws 403
--   - Frontend redirects to login or shows empty data
--
-- Fix 1: Backfill existing NULL profiles → first active org
-- Fix 2: Update handle_new_user trigger to fallback to first
--         active org instead of NULL (beta/single-org mode)
-- ============================================================

-- ------------------------------------------------------------
-- 1. Backfill: assign NULL org_id profiles to the first active org
-- ------------------------------------------------------------
DO $$
DECLARE
  default_org_id UUID;
  fixed_count INTEGER := 0;
BEGIN
  -- Find the first active organization (admin's org in single-org beta)
  SELECT id INTO default_org_id
  FROM public.organizations
  WHERE is_active = true
  ORDER BY created_at ASC
  LIMIT 1;

  IF default_org_id IS NULL THEN
    RAISE NOTICE 'No active organization found — skipping backfill';
    RETURN;
  END IF;

  -- Update profiles with NULL organization_id
  UPDATE public.profiles_
  SET organization_id = default_org_id
  WHERE organization_id IS NULL;

  GET DIAGNOSTICS fixed_count = ROW_COUNT;

  IF fixed_count > 0 THEN
    RAISE NOTICE 'Fixed % profile(s) with NULL organization_id → %', fixed_count, default_org_id;
  ELSE
    RAISE NOTICE 'No profiles with NULL organization_id found';
  END IF;
END;
$$;

-- ------------------------------------------------------------
-- 2. Update handle_new_user trigger: fallback to first active org
--    when no invitation exists (beta single-org mode)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  inv RECORD;
  resolved_org_id UUID;
  resolved_role TEXT := 'member';
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

  IF inv.organization_id IS NOT NULL THEN
    -- Invitation found: use its org + role
    resolved_org_id := inv.organization_id;
    resolved_role := COALESCE(inv.role, 'member');
  ELSE
    -- No invitation: fallback to first active organization (beta mode)
    SELECT id INTO resolved_org_id
    FROM public.organizations
    WHERE is_active = true
    ORDER BY created_at ASC
    LIMIT 1;
  END IF;

  -- Create profile
  INSERT INTO public.profiles_ (auth_user_id, email, organization_id, role)
  VALUES (
    NEW.id,
    NEW.email,
    resolved_org_id,
    resolved_role
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
