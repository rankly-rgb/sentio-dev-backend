-- Ajoute accounts.primary_segment (colonne physique), écrite par assignSegments
-- (calculate-scores) au même moment que segment_memberships — cache dénormalisé
-- du résultat de scoring, pas une donnée source (source de vérité =
-- determineSegmentTypesV3, _shared/scoring.ts).
--
-- Décision actée (Q1, cahier des charges 2026-08-02) : colonne physique plutôt
-- que vue/join, pour permettre un filtre SQL direct et indexé
-- (WHERE organization_id = ? AND primary_segment = ?), nécessaire au chantier A
-- (export CSV ciblé par segment).
--
-- NULL par défaut, PAS 'new' : un compte jamais encore scoré n'a pas de
-- primary_segment — comportement déjà documenté et consommé tel quel par
-- accounts-api (voir commentaire "null si jamais encore segmenté par le
-- cron", accounts-api/index.ts). Valeurs autorisées = exactement les segments
-- que determineSegmentTypesV3 peut retourner comme segment de santé exclusif :
-- ni 'nouveaux' (non-exclusif, additif — jamais primaire), ni 'en_expansion'
-- (retiré des critères actifs en V3, conservé uniquement pour compat CHECK
-- descendante sur account_segments/segment_memberships — jamais assigné par
-- cette fonction).
--
-- accounts-api n'est PAS modifié par cette migration : il continue de lire
-- primary_segment via segment_memberships (fetchPrimarySegments). Les deux
-- sources restent cohérentes car écrites par le même run de assignSegments
-- avec la même règle de priorité. Cette colonne existe pour permettre un
-- filtre SQL direct côté chantier A (get_playbook_targets), pas pour
-- remplacer le chemin de lecture existant.

ALTER TABLE public.accounts
  ADD COLUMN IF NOT EXISTS primary_segment TEXT NULL;

ALTER TABLE public.accounts
  DROP CONSTRAINT IF EXISTS accounts_primary_segment_check;

ALTER TABLE public.accounts
  ADD CONSTRAINT accounts_primary_segment_check CHECK (
    primary_segment IS NULL OR primary_segment IN (
      'en_churn', 'impayes', 'donnees_insuffisantes',
      'en_danger_critique', 'a_risque_leger', 'champions', 'stables'
    )
  );

CREATE INDEX IF NOT EXISTS idx_accounts_org_primary_segment
  ON public.accounts (organization_id, primary_segment);

-- Backfill : lit le dernier résultat déjà persisté dans segment_memberships
-- pour les comptes déjà scorés au moins une fois. Même règle de priorité que
-- accounts-api : premier segment actif non-'nouveaux' associé au compte.
-- Les runs suivants de calculate-scores tiendront la colonne à jour
-- directement (voir modification de assignSegments dans calculate-scores).
UPDATE public.accounts a
SET primary_segment = sub.segment_type
FROM (
  SELECT DISTINCT ON (sm.account_id)
    sm.account_id,
    seg.segment_type
  FROM public.segment_memberships sm
  JOIN public.account_segments seg ON seg.id = sm.segment_id
  WHERE sm.status = 'active'
    AND seg.segment_type <> 'nouveaux'
  ORDER BY sm.account_id, sm.last_evaluated_at DESC NULLS LAST
) sub
WHERE a.id = sub.account_id
  AND a.primary_segment IS NULL;
