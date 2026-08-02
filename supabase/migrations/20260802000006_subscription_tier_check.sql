-- Chantier C — réaligne organizations.plan_type sur les 4 tiers V1 réels
-- (Free/Growth/Scale/Enterprise). La colonne existait déjà
-- (20260301000002_phase1_infrastructure.sql) mais n'était câblée nulle
-- part (aucun Edge Function ne la lisait ni ne l'écrivait) et son CHECK
-- listait 'starter', un nom de tier qui n'a jamais existé côté produit
-- — remplacé par 'scale' pour matcher le catalogue réel
-- (_shared/subscription-tiers.ts).
--
-- Pas de migration de données : aucune ligne n'utilise 'starter'
-- aujourd'hui (colonne jamais écrite), donc pas de backfill nécessaire.

ALTER TABLE public.organizations
  DROP CONSTRAINT IF EXISTS organizations_plan_type_check;

ALTER TABLE public.organizations
  ADD CONSTRAINT organizations_plan_type_check CHECK (
    plan_type = ANY (ARRAY['free','growth','scale','enterprise'])
  );
