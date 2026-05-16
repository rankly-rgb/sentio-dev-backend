-- ============================================================
-- Migration : Colonnes i18n sur playbooks
-- Ajoute title_en et description_en pour la traduction EN.
-- La colonne title reste la référence FR (langue par défaut).
-- ============================================================

ALTER TABLE public.playbooks
  ADD COLUMN IF NOT EXISTS title_en       TEXT NULL,
  ADD COLUMN IF NOT EXISTS description_en TEXT NULL;

COMMENT ON COLUMN public.playbooks.title_en IS
  'English title — retourné par l''API quand organizations.locale = ''en'' et non-null. Fallback sur title.';

COMMENT ON COLUMN public.playbooks.description_en IS
  'English description — retourné par l''API quand organizations.locale = ''en'' et non-null. Fallback sur description.';
