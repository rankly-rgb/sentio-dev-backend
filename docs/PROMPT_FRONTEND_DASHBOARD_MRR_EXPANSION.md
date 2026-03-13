# Prompt Frontend — Tendance MRR + Opportunités d'expansion

## Contexte

Le dashboard (`/dashboard`) a deux widgets incomplets :
- **Tendance MRR** : affiche "Aucune donnée MRR disponible" — il manque l'appel backend et le graphique
- **Opportunités d'expansion** : affiche "0 opportunités d'expansion" — le filtrage fonctionne mais le widget n'affiche pas les détails d'expansion (sièges, plan)

Le backend vient d'être mis à jour avec 2 nouvelles RPCs et les données nécessaires sont disponibles.

---

## Tâche 1 — Widget Tendance MRR (graphique)

### API Backend disponible

Deux RPCs Supabase à appeler côté client (pas d'Edge Function nécessaire) :

```ts
// 1. Série temporelle MRR total par jour
const { data: mrrTrend } = await supabase.rpc('get_mrr_trend', {
  p_start_date: '2026-02-11',  // 30 jours par défaut
  p_end_date: '2026-03-13',
})
// Retour : { snapshot_date: string, total_mrr_cents: number, account_count: number }[]

// 2. Ventilation mouvements MRR par jour (optionnel, pour vue détaillée)
const { data: mrrMovements } = await supabase.rpc('get_mrr_movements_summary', {
  p_start_date: '2026-02-11',
  p_end_date: '2026-03-13',
})
// Retour : { movement_date: string, new_mrr_cents: number, expansion_mrr_cents: number,
//            contraction_mrr_cents: number, churn_mrr_cents: number,
//            reactivation_mrr_cents: number, net_mrr_cents: number }[]
```

### Spécifications UI

**Composant `MrrTrendChart`** (client component, `'use client'`) :

1. **Graphique ligne** (recharts `<LineChart>` ou `<AreaChart>` — recharts est déjà une dépendance standard Next.js) :
   - Axe X : dates (format `DD/MM` en français)
   - Axe Y : MRR en euros (diviser cents par 100, formater `XX XXX €`)
   - Ligne principale : `total_mrr_cents` (couleur indigo-500)
   - Aire sous la courbe semi-transparente (indigo-50)
   - Tooltip au survol : date complète + MRR formaté + nombre de comptes

2. **Bandeau résumé** au-dessus du graphique :
   - MRR actuel (dernier point)
   - Delta sur la période : `+X XXX €` ou `-X XXX €` (vert si positif, rouge si négatif)
   - Variation en % : `+X.X %` (ou `—` si MRR initial = 0)

3. **Sélecteur de période** (boutons pill) : `7j` | `30j` | `90j` (défaut 30j)
   - Recalculer `p_start_date` = aujourd'hui - N jours

4. **Empty state** : si `data` est vide ou null, afficher "Aucune donnée MRR disponible — les tendances apparaîtront après la première synchronisation Stripe" avec lien vers `/dashboard/settings`

5. **Loading** : skeleton rectangle gris pulsé (h-64) pendant le fetch

### Calcul du résumé (côté client)

```ts
// Réutilisable depuis le backend (copier les types, pas les imports)
interface MrrTrendPoint {
  snapshot_date: string
  total_mrr_cents: number
  account_count: number
}

function computeSummary(points: MrrTrendPoint[]) {
  if (points.length === 0) return null
  const start = points[0].total_mrr_cents
  const end = points[points.length - 1].total_mrr_cents
  const delta = end - start
  const deltaPct = start > 0 ? Math.round((delta / start) * 10000) / 100 : null
  return { start, end, delta, deltaPct }
}
```

### Placement dans le dashboard

Remplacer le bloc "Tendance MRR" existant (actuellement un `<div>` statique avec le message vide) par le nouveau composant `<MrrTrendChart />`. Le placer **après** la grille "Comptes à risque / Opportunités d'expansion" et **avant** "Synchronisations récentes".

### Installation recharts

```bash
npm install recharts
```

Si recharts est déjà installé, ne pas réinstaller. Vérifier avec `npm ls recharts`.

---

## Tâche 2 — Widget Opportunités d'expansion enrichi

### Données déjà disponibles

Le widget actuel filtre correctement (`expansion_score >= 70 && health_score >= 60`) mais n'affiche que le `stripe_customer_id` + MRR + score. Il manque les informations d'expansion concrètes.

Les champs suivants sont **déjà dans la table `accounts`** (type `Account`) et chargés par la query existante :

```ts
interface Account {
  // Déjà affiché :
  stripe_customer_id: string | null
  mrr_cents: number | null
  expansion_score: number | null

  // À afficher en plus :
  seat_count: number | null       // Sièges occupés
  seat_limit: number | null       // Sièges max du plan
  plan_tier: string | null        // Plan actuel (starter, growth, enterprise)
  health_score: number | null     // Santé globale
}
```

### Spécifications UI

**Enrichir le widget existant** (pas de nouveau composant) :

1. **Chaque ligne** de la liste doit afficher :
   - `stripe_customer_id` (existant, inchangé)
   - **Sièges** : `{seat_count}/{seat_limit}` (ex: "45/50") — ou `—` si null
     - Barre de progression miniature (h-1, largeur proportionnelle) : vert < 70%, ambre 70-89%, rouge >= 90%
   - **Plan** : badge pill avec le `plan_tier` (ex: "growth", "enterprise")
   - **MRR** : formaté en euros (existant, inchangé)
   - **Score expansion** : `ScoreBadge` existant (inchangé)

2. **Header enrichi** :
   - Ajouter sous le titre "Opportunités d'expansion" une ligne de contexte :
     - `{count} opportunités · {totalMrr} MRR potentiel`
     - Où `count` = nombre total d'opportunités (pas seulement top 5)
     - Où `totalMrr` = somme MRR des comptes éligibles

3. **Lien "Voir tout"** : pointer vers `/dashboard/segments/en_expansion` (existant, inchangé)

4. **Empty state amélioré** :
   - Avant : "Aucune opportunité détectée"
   - Après : "Aucune opportunité détectée — les scores d'expansion se calculent à partir de l'utilisation des sièges et des fonctionnalités"

### Pas de nouvel appel API

Tout est déjà dans la variable `accounts` chargée server-side. Le filtrage et l'enrichissement sont purement côté composant.

---

## Contraintes techniques

- **Stack** : Next.js 14 App Router, TypeScript, Tailwind CSS 3
- **Supabase client** : `createSupabaseServerClient()` pour les server components, `createSupabaseBrowserClient()` pour les client components
- **Zero-PII** : ne jamais afficher d'email, nom, téléphone. Uniquement `stripe_customer_id` et scores
- **Pas de `[...new Set()]`** : le target est ES5 (utiliser `Array.from(new Set(...))` si nécessaire)
- **Responsive** : grille 1 colonne mobile, 2 colonnes desktop pour les widgets
- **Couleurs** : rester dans la palette existante (indigo comme accent principal, slate pour le texte, emerald/amber/red pour les statuts)
- **Locale** : tout en français (labels, nombres, dates)

## Fichiers à modifier

| Fichier | Action |
|---------|--------|
| `src/app/dashboard/page.tsx` | Enrichir widget expansion + ajouter `<MrrTrendChart />` |
| `src/components/MrrTrendChart.tsx` | **CRÉER** — composant client avec recharts |
| `package.json` | Ajouter `recharts` si absent |

## Critères d'acceptation

- [ ] Le graphique MRR affiche une courbe avec les données de `get_mrr_trend`
- [ ] Le sélecteur 7j/30j/90j fonctionne et recharge les données
- [ ] Le résumé (MRR actuel, delta, %) est correct et coloré
- [ ] L'empty state s'affiche quand il n'y a pas de données
- [ ] Le widget expansion affiche sièges, plan, barre de progression
- [ ] Le compteur total d'opportunités est affiché dans le header
- [ ] Aucun PII n'est affiché
- [ ] `npm run build` passe sans erreur
- [ ] Le dashboard reste responsive sur mobile
