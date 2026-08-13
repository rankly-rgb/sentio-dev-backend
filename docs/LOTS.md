# Lots en cours — specs versionnées

Ce fichier existe parce que la compaction de contexte a déjà fait perdre la
spec du Lot 6 une fois et régénérer une conception fausse sur son point le
plus sensible (source `score_history`, explicitement interdite). Une spec
qui n'existe que dans le contexte de conversation n'existe pas. Toute spec
d'un lot pas encore terminé DOIT être copiée ici, verbatim autant que
possible, avant de commencer l'implémentation — pas après.

Mettre à jour ce fichier au fur et à mesure (nouveau lot, changement de
spec, lot terminé → déplacer un résumé dans `CHANGELOG_STABILITY.md` et
retirer l'entrée d'ici).

---

## Lot V — Vérification rétroactive (2026-08-13, priorité absolue)

**Statut : EN COURS.** Bloque tout nouveau code (Lot 4bis, Lot 6, Lot 8)
jusqu'à complétion.

**Contexte** : cinq lots (1-5, 7) avaient été mergés sur la seule foi de
tests verts, avec la mention « non vérifié, reporté ». C'est le mode de
défaillance qui a produit les six incidents précédents du projet — tous
rattrapés par inspection des données, aucun par la suite de tests. Ce lot
vérifie ce qui est déjà mergé et live, répare ce qui est rouge, documente
ce qui était cassé et depuis quand.

### V.1 — Lot 1 (SECURITY DEFINER lockdown) — le plus urgent
1. Privilèges `anon` EXECUTE sur les fonctions `prosecdef` → attendu 0 ligne.
2. Même requête pour `PUBLIC` → attendu 0 ligne.
3. Même requête pour `authenticated` → attendu EXACTEMENT la matrice de
   fonctions documentée dans le Lot 1 (`CHANGELOG_STABILITY.md`) — coller
   la liste réelle et comparer explicitement à la matrice.
4. Cycle applicatif complet sous une vraie session `authenticated` (PAS
   `service_role`) : Login, Overview, Accounts, fiche compte, Segments,
   Playbooks — statut HTTP + extrait de payload prouvant que des lignes
   remontent. Une réponse 200 avec un tableau vide n'est pas une preuve de
   succès : une policy RLS cassée renvoie zéro ligne sans erreur. Comparer
   chaque comptage à un comptage `service_role` équivalent.
5. Chaque RPC de la matrice `authenticated` appelée avec un JWT
   `authenticated` → doit réussir.
6. Chaque fonction Vault + `cron_dispatch_via_vault` +
   `seed_default_playbooks` + `increment_webhook_failure` +
   `mark_playbook_executed` appelée avec un JWT `authenticated` → doit
   lever une exception.
7. Le point le plus suspect : la garde `request.jwt.claims`. Les 4 cron
   jobs réparés le 2026-08-10 passent par `cron_dispatch_via_vault`.
   Vérifier que pg_cron n'expose pas de `request.jwt.claims` — si la garde
   les a cassés silencieusement, c'est un correctif immédiat. Déclencher un
   cron job réel et prouver son exécution complète de bout en bout (log,
   effet en base), pas seulement l'absence d'erreur au déclenchement.
8. `on_playbook_activate` après passage à Vault : activer un playbook de
   test et prouver que `net.http_post` part effectivement avec la bonne
   clé.

Si un point est rouge : correctif immédiat (pas un lot séparé), re-preuve,
documenter ce qui était cassé et combien de temps.

### V.2 — Lot 3 (webhook Stripe)
Absent du rapport final précédent. Requis : conclusion (a) endpoint jamais
enregistré / signing secret / URL, ou (b) réception mais échec silencieux —
preuve à l'appui. Contenu de `webhook_dead_letter`. La trace persistée sur
rejet de signature (`webhook_receipts`) est-elle en place et testée par un
appel mal signé ? `last_webhook_received_at` est-il exposé ? Action Naima
avec procédure exacte si une config Stripe Dashboard est nécessaire.

### V.3 — Lot 2 (assertions CI data-truth)
Liste complète des assertions avec, pour chacune : numéro, ce qu'elle
prévient, mode (`hard`/`soft`), raison si `soft`. Une assertion `soft` ne
protège de rien — c'est un commentaire ; justifier chaque `soft` ou la
repasser en `hard`. Confirmer que le contrôle négatif a été exécuté (job
rouge avec l'assertion active, vert sans).

### V.4 — Lot 4 (movement_date/provenance)
Preuve qu'une subscription datée il y a des mois produit un mouvement
`new` daté du vrai mois. Non vérifiable tant que `stripe_created_at` est
vide — arrive après V.6.

### V.5 — Lot 5 (délinquence par durée)
Le « avant » est déjà documenté (`CHANGELOG_STABILITY.md`) — le « après »
manque. Après un `calculate-scores` complet (post V.6) :
```sql
select is_delinquent, delinquent_since is null as duree_inconnue,
       churn_risk_band, count(*)
from accounts group by 1,2,3 order by 1,2,3;
```
Delta « accounts at risk » / « MRR at risk ».

**Mesure de qualité de `delinquent_since` (obligatoire)** : `current_period_start`
peut précéder la première défaillance de paiement de plusieurs semaines →
surestime la durée → sur-escalade vers `critical`. Sur les comptes
délinquents avec au moins une facture impayée, comparer
`current_period_start` à la date réelle de la facture ; donner l'écart
médian et le 90e centile. **Si l'écart médian dépasse 7 jours** : le proxy
est trop grossier pour piloter un plancher `critical` → ouvrir une issue et
désactiver le palier `critical` (plafond à `high`) en attendant une source
plus fine. Sur-escalader détruit la confiance aussi sûrement que
sous-escalader.

### V.6 — Débloquer la vérification
Clarification : l'interdiction porte sur écrire en base de PRODUCTION et
faire des déploiements manuels (`db push`, `functions deploy`) — PAS sur
l'invocation normale d'une Edge Function sur le projet DEV. Déclencher
`sync-stripe` puis `calculate-scores` sur dev est une opération de routine,
lisible, réversible. Exploiter le résultat pour V.4, V.5 et le Lot 6.

**Root cause découverte pendant V.6** : `apply_migration` génère un
horodatage de version décorrélé du nom de fichier git → 10 entrées
fantômes dans `supabase_migrations.schema_migrations` → `supabase db push`
cassé en CI depuis 2026-08-09 → "Deploy Edge Functions" skippé sur CHAQUE
run depuis (Lots 1-5 inclus). Corrigé : entrées fantômes supprimées,
entrées correctes basées sur les vrais noms de fichiers insérées. Un
second bug réel (drift `accounts_with_priority`, Lot 5) trouvé au run
suivant, corrigé (migration `20260813000007`, PR #58, mergée).

### Rapport — format obligatoire
```
## Vérification rétroactive
Pour chaque lot déjà mergé (1 à 5, 7) :
- Critère : <libellé>
- Statut : VERT / ROUGE / NON VÉRIFIABLE
- Sortie brute : <...>
- Si ROUGE : ce qui était cassé, depuis quand, correctif appliqué, re-preuve
```
Un critère rouge sur un lot déjà mergé n'est pas un échec — c'est
exactement ce que cette vérification sert à trouver. Le laisser non
vérifié serait l'échec.

---

## Lot 4bis — Backfill `stripe_created_at` (bloqué par Lot V)

**Statut : PAS COMMENCÉ.** Débloqué dès que Lot V est terminé.

**Constat** : `stripe_created_at` (Lot 4) est à 0/585 lignes peuplées.
Attendre le cron quotidien ne suffit pas : `sync-stripe` ne remonte que les
subscriptions que Stripe retourne encore — les subscriptions **annulées**
ne sont plus retournées par l'API Stripe standard, elles resteront donc à
`NULL` indéfiniment sans backfill dédié. Ce sont précisément celles dont le
Lot 6 a besoin pour dater les mouvements `churn` historiques.

**Exigence** : script idempotent et rejouable, dans `scripts/`, suivant le
pattern des scripts existants (`scripts/seed-churn-validation.ts` pour le
SDK Stripe, `scripts/verify-portfolio-consistency.ts` pour le client
Supabase `.env.local`). Doit :
- Résoudre par org le mode d'accès Stripe (`organizations.stripe_api_key`
  ?? `STRIPE_SECRET_KEY`), même pattern que `sync-stripe/index.ts`.
- Pour chaque subscription en base avec `stripe_created_at IS NULL` :
  tenter de la refetcher depuis Stripe (`stripe.subscriptions.retrieve`,
  y compris les subscriptions annulées — Stripe les retourne toujours par
  ID direct, seule la liste paginée les exclut) et persister `sub.created`.
- **Jamais de date inventée** — `NULL` assumé pour ce que Stripe ne
  retourne plus (ex: subscription supprimée définitivement, pas seulement
  annulée). Distinguer les deux populations dans le rapport final : (a)
  backfillées avec succès, (b) toujours `NULL` car Stripe ne les retourne
  plus (avec la raison si disponible : 404, etc.).
- Idempotent : rejouable sans effet si déjà backfillé (skip les lignes non
  `NULL`).

---

## Lot 6 — Génération initiale de l'historique MRR (#49 recadré)

**Statut : PAS REPRIS.** Dépendance : V.6 (Edge Functions redéployées avec
le code Lot 4) ET Lot 4bis (backfill `stripe_created_at`) tous deux
terminés.

**Interdiction explicite, réaffirmée** : `score_history.mrr_cents` ne doit
JAMAIS être utilisé comme source. `score_history` est un upsert de l'état
COURANT réétiqueté par `snapshot_date` (`calculate-scores/index.ts:640,
647, 818, 927`), pas une série de snapshots historiques. En dériver des
deltas produirait des mouvements fabriqués présentés comme mesurés.

**Périmètre — reconstruire UNIQUEMENT** :
- `new` — depuis `subscriptions.stripe_created_at` (Lot 4 + Lot 4bis).
- `churn` — depuis `subscriptions.canceled_at` (déjà persisté).
- **Jamais** `expansion`/`contraction`/`reactivation` — indatables de
  manière fiable sur le chemin batch (confirmé Lot 4 : aucune colonne
  persistée ne capture un changement de MRR partiel à un instant donné).

**Colonne provenance** : `mrr_movements.provenance` déjà créée par le Lot 4
(`'live'|'backfill'|'estimated'`, défaut `'live'`) — ce lot écrit avec
`provenance='backfill'` (distinct de `'estimated'`, utilisé pour les
diffs batch non datables).

**Dédup** : au plus un mouvement `new`/`churn` par SUBSCRIPTION (pas par
compte — un compte peut avoir plusieurs subscriptions, chacune avec son
propre cycle new/churn).

**Frontière d'honnêteté temporelle** : `organizations.mrr_history_complete_since`
(à créer) — la date à partir de laquelle l'historique `mrr_movements` est
considéré complet et fiable pour cet org. Toute métrique dérivée
(`churn_rate`, `NRR`, `mrr_growth`) sur une fenêtre qui chevauche la zone
reconstruite doit porter `partial: true` dans le contrat API. Une fenêtre
entièrement HORS de la zone reconstructible → `null`, **jamais** `0` (S1 :
no data ≠ neutral data).

`hasThreeMonthsHistory` (`dashboard-api`) doit consommer cette borne de
fiabilité au lieu de `MIN(movement_date)` brut — sinon une fois des
mouvements `new` rétrodatés à leur vraie date de création, ce calcul peut
basculer à `true` d'un coup pour un compte ancien nouvellement backfillé,
sans que l'historique soit réellement complet sur toute la période.

**Exécution — dry-run obligatoire d'abord**. Auto-approbation UNIQUEMENT
si les 6 invariants suivants sont tous verts :
1. Zéro ligne d'un type autre que `new`/`churn` produite par ce lot.
2. Zéro `movement_date` NULL, future, ou incohérente (antérieure à la
   création de l'org, etc.).
3. Nombre de `new` ≤ nombre de subscriptions avec `stripe_created_at`
   connu.
4. Nombre de `churn` = nombre de subscriptions avec `canceled_at` dans la
   fenêtre traitée.
5. Zéro collision avec les 3 lignes déjà existantes en base (mouvements
   `new` du chemin live actuel).
6. Script de réversion testé en aller-retour — restauration exacte du
   compte de lignes ET du checksum d'avant l'exécution.

**Un seul invariant rouge → NE PAS EXÉCUTER**, marquer BLOQUÉ, documenter
lequel et pourquoi, passer à autre chose. Tous verts → exécuter, puis
RE-exécuter et prouver zéro ligne supplémentaire créée (idempotence).

---

## Lot 8 — Issue #55 remise sous contrôle de version (CRITIQUE)

**Statut : PAS COMMENCÉ.** Bloqué par Lot V (aucun nouveau code avant sa
fin).

**Contexte** : issue #55 documente `export-playbook-accounts` (table
`playbook_exports`, RPC `get_playbook_export_summary`) comme déployé et
appelé par `Today.tsx`, mais **absent du repo git** — aucun fichier
source, aucune migration versionnée. Classé à tort « aucune action
immédiate requise » dans un rapport précédent. Ce n'est pas une dette,
c'est une mine : un déploiement `functions deploy`/`db push` normal
pourrait écraser ou désynchroniser ce code sans que personne ne s'en
aperçoive avant que `Today.tsx` casse en prod.

**Plan en 5 étapes, dans l'ordre — chaque étape est un commit séparé :**
1. **Point de restauration d'abord.** Committer le code source déployé de
   `export-playbook-accounts` TEL QUEL, non modifié, dans un commit isolé.
   Récupérer la définition live exacte (`list_edge_functions`/
   `get_edge_function` côté Edge Function ; `pg_get_functiondef` côté RPC)
   avant toute autre action.
2. **Tests + migration idempotente.** Deuxième commit : tests couvrant le
   chemin appelé par `Today.tsx`, migration idempotente (`CREATE TABLE IF
   NOT EXISTS` / `CREATE OR REPLACE FUNCTION`) déclarant `playbook_exports`
   / `get_playbook_export_summary` si elles ne sont pas déjà dans les
   migrations versionnées.
3. **Vérifier le respect de la matrice de privilèges du Lot 1.**
   `get_playbook_export_summary` figurait dans la matrice `authenticated`
   du Lot 1 — mais si elle a été créée hors git, sa définition live peut
   différer de ce qui a été audité. Revérifier ses GRANTs réels contre la
   matrice.
4. **Corriger la dette devise `mrr_euros`/suffixe "€" littéral** —
   maintenant que ce code est sous contrôle de version, c'est un bug
   d'affichage visible par un client et il est enfin corrigeable.
5. **Nouvelle assertion CI** : aucune Edge Function déployée sans source
   correspondante dans le repo (comparer `list_edge_functions` au
   contenu de `supabase/functions/*/index.ts`). Cette classe de problème
   ne doit plus jamais être découverte par hasard.
