-- Ajoute organizations.currency — devise d'affichage par défaut de l'org,
-- dérivée du compte Stripe connecté (voir sync-stripe : mise à jour depuis
-- la devise des invoices synchronisées). DEFAULT 'usd' pour les nouvelles
-- orgs (pivot marché US) — pas 'eur', contrairement à l'ancienne
-- convention de ce projet.
--
-- Pas de CHECK restrictif sur la liste de devises : Stripe supporte 135+
-- devises ISO 4217, une liste blanche figée serait une contrainte
-- artificielle à maintenir. Contrainte de forme seulement (3 lettres
-- minuscules, format ISO 4217 tel que retourné par l'API Stripe).

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'usd';

ALTER TABLE public.organizations
  DROP CONSTRAINT IF EXISTS organizations_currency_format_check;

ALTER TABLE public.organizations
  ADD CONSTRAINT organizations_currency_format_check CHECK (currency ~ '^[a-z]{3}$');
