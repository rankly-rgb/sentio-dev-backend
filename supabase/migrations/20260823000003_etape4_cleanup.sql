-- Étape 4 du chantier de remédiation (2026-08-23) — nettoyage technique sans
-- risque, deux items indépendants.

-- 1) `handle_new_user()` — fonction trigger orpheline, jamais rattachée à
-- aucun trigger sur ce projet (vérifié en direct, pg_trigger, 0 ligne).
-- `handle_new_user_signup` (20260503000004) est la fonction réellement
-- câblée : trigger `on_auth_user_created` sur `auth.users` (vérifié en
-- direct). Capturée telle quelle par 20260815000003 (Lot 8, "rapatriement
-- fidèle") avec une note explicite disant que la décision restait à
-- prendre — tranchée ici : supprimée. Protection structurelle déjà en place
-- (RETURNS trigger, jamais invocable en RPC) donc rien d'autre à retirer
-- (pas de GRANT à révoquer, 20260815000003 l'avait déjà REVOKE ALL).
DROP FUNCTION IF EXISTS public.handle_new_user();

-- 2) `get_playbook_eligible_accounts` — réimplémente en SQL le moteur
-- d'éligibilité playbook et a régressé sur la décision C2.5 (2026-08-02,
-- "eligibility_criteria vide/absent ne matche plus rien" côté TypeScript) :
-- cette RPC traite toujours un groupe vide comme "matche tout". Zéro
-- appelant confirmé (grep sur les deux repos, 2026-08-23) — le GRANT
-- `authenticated` posé par le Lot 1 (20260815000004) reste néanmoins une
-- surface d'attaque inutile tant qu'il existe : n'importe quel utilisateur
-- connecté peut l'invoquer directement via PostgREST et obtenir un résultat
-- différent de ce que l'UI montre. `service_role` conservé (pas de
-- confirmation qu'aucun usage interne futur n'en dépendra, et il n'est pas
-- exposé au navigateur).
REVOKE EXECUTE ON FUNCTION public.get_playbook_eligible_accounts(uuid, integer, integer) FROM authenticated;
