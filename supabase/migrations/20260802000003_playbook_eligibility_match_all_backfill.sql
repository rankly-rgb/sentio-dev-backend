-- C2.5 (2026-08-02) : evaluateConditions (_shared/playbook-engine.ts) ne
-- matche plus aucun compte par défaut pour un eligibility_criteria vide ou
-- absent — avant ce chantier, un playbook sans critères s'exécutait
-- silencieusement sur tous les comptes de l'org (voir playbook-scheduler,
-- cas sans segment_id : plus aucun garde-fou dans ce cas). Un ciblage
-- volontaire "tous les comptes" doit désormais passer par un flag explicite
-- `match_all: true` dans le JSONB.
--
-- Backfill : préserve exactement le comportement actuel des playbooks
-- existants qui reposaient (volontairement ou par oubli) sur ce défaut
-- implicite, pour qu'aucun ne s'arrête silencieusement de s'exécuter après
-- ce chantier. Idempotent — ne touche que les lignes sans match_all déjà
-- posé, un deuxième run est un no-op.

-- Cas 1 : eligibility_criteria NULL → objet explicite match_all:true.
UPDATE public.playbooks
SET eligibility_criteria = jsonb_build_object(
  'operator', 'AND',
  'conditions', '[]'::jsonb,
  'match_all', true
)
WHERE eligibility_criteria IS NULL;

-- Cas 2 : eligibility_criteria présent mais conditions vide, sans match_all.
UPDATE public.playbooks
SET eligibility_criteria = eligibility_criteria || jsonb_build_object('match_all', true)
WHERE eligibility_criteria IS NOT NULL
  AND jsonb_typeof(eligibility_criteria->'conditions') = 'array'
  AND jsonb_array_length(eligibility_criteria->'conditions') = 0
  AND (eligibility_criteria->'match_all') IS DISTINCT FROM 'true'::jsonb;
