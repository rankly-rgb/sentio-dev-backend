-- ============================================================
-- Lot 8 — capture des 3 derniers objets base créés hors migration
-- ============================================================
--
-- Inventaire exhaustif des objets du schéma `public` sur le projet
-- (2026-08-15) croisé avec `supabase/migrations/` : 74 objets, 3 sans
-- aucune déclaration versionnée une fois `playbook_exports` traité par
-- 20260815000002.
--
--   - public.account_notes                (table, 1602 lignes en base)
--   - public.handle_new_user()            (fonction trigger)
--   - public.on_organization_created()    (fonction trigger)
--
-- `on_organization_created` est référencée nommément par le Lot 1
-- (20260813000003) comme faisant partie des 24 fonctions SECURITY
-- DEFINER verrouillées, et le trigger `seed_playbooks_on_org_created`
-- qui l'appelle est un maillon du parcours de création d'organisation —
-- mais sa définition n'existait nulle part en git.
--
-- Repris **à l'identique de la définition live** (pg_get_functiondef,
-- information_schema, pg_policies, pg_indexes, pg_get_triggerdef).
-- Entièrement idempotent : no-op sur le projet tel quel.
-- ============================================================

-- ── Table account_notes ────────────────────────────────────
-- Écrite par l'action playbook `log_note`. Contient du texte rédigé
-- côté produit (title/body) — aucune colonne PII au sens Zero-PII
-- (pas d'email/nom/téléphone), uniquement des identifiants internes.
CREATE TABLE IF NOT EXISTS public.account_notes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  account_id      UUID NOT NULL,
  note_type       TEXT NOT NULL DEFAULT 'playbook_action',
  title           TEXT NOT NULL,
  body            TEXT NOT NULL DEFAULT ''::text,
  source          TEXT NOT NULL DEFAULT 'playbook',
  playbook_id     UUID,
  execution_id    UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Les FK live portent des noms non standard (`_fk` et non `_fkey`) :
-- reproduits tels quels pour qu'un diff futur ne les signale pas.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'account_notes_org_fk') THEN
    ALTER TABLE public.account_notes
      ADD CONSTRAINT account_notes_org_fk
      FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'account_notes_account_fk') THEN
    ALTER TABLE public.account_notes
      ADD CONSTRAINT account_notes_account_fk
      FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'account_notes_note_type_check') THEN
    ALTER TABLE public.account_notes
      ADD CONSTRAINT account_notes_note_type_check
      CHECK (note_type = ANY (ARRAY['playbook_action'::text, 'manual'::text, 'system'::text]));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_account_notes_account
  ON public.account_notes USING btree (account_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_account_notes_org
  ON public.account_notes USING btree (organization_id);

ALTER TABLE public.account_notes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS org_isolation ON public.account_notes;
CREATE POLICY org_isolation ON public.account_notes
  FOR ALL
  USING (organization_id = (SELECT public.user_organization_id()))
  WITH CHECK (organization_id = (SELECT public.user_organization_id()));

DROP TRIGGER IF EXISTS update_account_notes_updated_at ON public.account_notes;
CREATE TRIGGER update_account_notes_updated_at
  BEFORE UPDATE ON public.account_notes
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ── Fonctions trigger ──────────────────────────────────────

CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION public.on_organization_created()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM public.seed_default_playbooks(NEW.id);
  RETURN NEW;
END;
$function$;

-- Matrice du Lot 1 : les fonctions trigger ne reçoivent aucun GRANT
-- (une fonction RETURNS trigger n'est pas invocable en RPC), mais le
-- lockdown a bien révoqué l'EXECUTE par défaut de PUBLIC. Sur une base
-- neuve, 20260813000003 s'exécute avant ce fichier et ne verrait donc
-- pas ces deux fonctions : sans les REVOKE ci-dessous, elles naîtraient
-- avec PUBLIC EXECUTE et déclencheraient l'assertion CI a1.
REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.on_organization_created() FROM PUBLIC, anon, authenticated;

-- ── Triggers non déclarés ──────────────────────────────────
-- Recensement de tous les triggers non-internes du schéma `public`
-- (36) croisé avec `CREATE TRIGGER` dans supabase/migrations/ : 3 sans
-- déclaration. Le troisième (update_playbook_exports_updated_at) est
-- traité par 20260815000002, avec sa table.

DROP TRIGGER IF EXISTS seed_playbooks_on_org_created ON public.organizations;
CREATE TRIGGER seed_playbooks_on_org_created
  AFTER INSERT ON public.organizations
  FOR EACH ROW EXECUTE FUNCTION public.on_organization_created();

DROP TRIGGER IF EXISTS update_organization_integrations_updated_at ON public.organization_integrations;
CREATE TRIGGER update_organization_integrations_updated_at
  BEFORE UPDATE ON public.organization_integrations
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- `handle_new_user` n'est rattachée à AUCUN trigger sur ce projet — ni sur
-- auth.users, ni ailleurs (pg_trigger, vérifié). C'est
-- `handle_new_user_signup` (20260503000004) qui est la fonction active.
-- Sa définition est capturée ici parce qu'elle existe en base et qu'elle
-- figure dans la matrice du Lot 1 ; aucun trigger n'est créé pour elle,
-- ce serait inventer un câblage qui n'existe pas. Voir PARKING_LOT.md.
