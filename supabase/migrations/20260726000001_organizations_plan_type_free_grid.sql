-- Migration : grille tarifaire finale sur organizations.plan_type
-- Décision produit (2026-07-26) : 'starter' devient 'free'. Grille finale :
-- free / growth / scale / enterprise.
--
-- Audit préalable (vérifié en base au moment de l'écriture) : aucune
-- organisation n'utilise 'starter' (distribution réelle : free=9, growth=1,
-- enterprise=1) — l'UPDATE ci-dessous est un no-op sur les données actuelles,
-- conservé pour idempotence et pour couvrir toute ligne 'starter' future
-- (ex. restauration d'un backup antérieur).
--
-- Ne concerne QUE organizations.plan_type (facturation Sentio de ses
-- organisations clientes). Ne touche PAS accounts.plan_tier ni
-- stripe_product_mappings.plan_tier — ces deux colonnes décrivent le palier
-- des clients FINAUX de chaque organisation (domaine distinct et sans
-- rapport, cf. specs/003-pricing-billing-implementation/research.md).

UPDATE public.organizations
SET plan_type = 'free'
WHERE plan_type = 'starter';

ALTER TABLE public.organizations
  DROP CONSTRAINT IF EXISTS organizations_plan_type_check;

ALTER TABLE public.organizations
  ADD CONSTRAINT organizations_plan_type_check CHECK (
    plan_type = ANY (ARRAY['free','growth','scale','enterprise'])
  );
