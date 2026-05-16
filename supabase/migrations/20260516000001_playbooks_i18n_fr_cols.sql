-- ============================================================
-- Migration : Colonnes FR explicites sur playbooks
-- Ajoute title_fr et description_fr en complément de title_en /
-- description_en (ajoutés en 20260514000001).
-- La colonne title reste la source legacy / fallback ultime.
-- ============================================================

ALTER TABLE public.playbooks
  ADD COLUMN IF NOT EXISTS title_fr       TEXT NULL,
  ADD COLUMN IF NOT EXISTS description_fr TEXT NULL;

COMMENT ON COLUMN public.playbooks.title_fr IS
  'Titre français explicite. Fallback sur title si NULL.';

COMMENT ON COLUMN public.playbooks.description_fr IS
  'Description française explicite. Fallback sur description si NULL.';

-- Backfill : copier title → title_fr et description → description_fr
-- pour toutes les lignes existantes (idempotent : ne touche que les NULL).
UPDATE public.playbooks
SET
  title_fr       = title
WHERE title_fr IS NULL
  AND title IS NOT NULL;

UPDATE public.playbooks
SET
  description_fr = description
WHERE description_fr IS NULL
  AND description IS NOT NULL;
