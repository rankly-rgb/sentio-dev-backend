-- ============================================================
-- Migration : Onboarding V2 — étapes comportementales + préférences org
-- Principes : re-motivation (Skrob), récompense variable (Eyal),
--             investissement utilisateur (Eyal/Hooked)
-- Compatible avec le schéma existant (ADD COLUMN IF NOT EXISTS)
-- ============================================================

-- ------------------------------------------------------------
-- 1. Nouvelles colonnes sur organizations
-- ------------------------------------------------------------

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS onboarding_step TEXT DEFAULT 'promise',
  ADD COLUMN IF NOT EXISTS promise_seen_at  TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS first_revelation_at TIMESTAMPTZ NULL;

-- CHECK constraint sur onboarding_step (idempotent via DO block)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'organizations_onboarding_step_check'
      AND conrelid = 'public.organizations'::regclass
  ) THEN
    ALTER TABLE public.organizations
      ADD CONSTRAINT organizations_onboarding_step_check
      CHECK (onboarding_step IN (
        'promise',
        'stripe',
        'revelation',
        'invested',
        'hubspot',
        'completed'
      ));
  END IF;
END$$;

-- ------------------------------------------------------------
-- 2. Ajouter 'owner' dans le CHECK de profiles_ (si absent)
-- ------------------------------------------------------------

DO $$
BEGIN
  -- Supprimer l'ancienne contrainte et la remplacer pour inclure 'owner'
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'profiles__role_check'
      AND conrelid = 'public.profiles_'::regclass
  ) THEN
    ALTER TABLE public.profiles_ DROP CONSTRAINT profiles__role_check;
  END IF;

  ALTER TABLE public.profiles_
    ADD CONSTRAINT profiles__role_check
    CHECK (role = ANY (ARRAY['owner','admin','member','viewer']));
END$$;

-- ------------------------------------------------------------
-- 3. Table org_preferences (investissement utilisateur)
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.org_preferences (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,

  -- Seuils de score personnalisés
  danger_threshold      INTEGER DEFAULT 40
    CHECK (danger_threshold BETWEEN 10 AND 60),
  at_risk_threshold     INTEGER DEFAULT 60
    CHECK (at_risk_threshold BETWEEN 30 AND 80),
  champion_threshold    INTEGER DEFAULT 80
    CHECK (champion_threshold BETWEEN 60 AND 100),

  -- Noms de segments personnalisés
  segment_name_champions TEXT DEFAULT 'Champions',
  segment_name_at_risk   TEXT DEFAULT 'À risque léger',
  segment_name_danger    TEXT DEFAULT 'En danger',
  segment_name_stable    TEXT DEFAULT 'Stables',

  -- Préférences d'alerte
  alert_channel TEXT DEFAULT 'none'
    CHECK (alert_channel IN ('none','slack','email','both')),

  -- Métadonnées
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (organization_id)
);

-- updated_at trigger
CREATE OR REPLACE FUNCTION public.update_org_preferences_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_org_preferences_updated_at ON public.org_preferences;
CREATE TRIGGER trg_org_preferences_updated_at
  BEFORE UPDATE ON public.org_preferences
  FOR EACH ROW EXECUTE FUNCTION public.update_org_preferences_updated_at();

-- ------------------------------------------------------------
-- 4. RLS sur org_preferences
-- ------------------------------------------------------------

ALTER TABLE public.org_preferences ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "org_preferences_org_isolation" ON public.org_preferences;
CREATE POLICY "org_preferences_org_isolation"
ON public.org_preferences FOR ALL
USING (
  organization_id = public.user_organization_id()
  OR public.user_role() = 'service_role'
)
WITH CHECK (
  organization_id = public.user_organization_id()
  OR public.user_role() = 'service_role'
);

-- ------------------------------------------------------------
-- 5. Index de performance
-- ------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_org_preferences_org
  ON public.org_preferences USING btree (organization_id);

CREATE INDEX IF NOT EXISTS idx_organizations_onboarding_step
  ON public.organizations USING btree (onboarding_step)
  WHERE onboarding_completed = FALSE;
