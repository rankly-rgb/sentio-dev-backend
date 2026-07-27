// ============================================================
// Merge-tags — résolution pure + génération CSV RFC 4180
// Aucune dépendance Supabase (fonctions pures testables)
// Zero-PII : aucune des sources utilisées ici n'est une donnée
// personnelle (display_name = nom d'entreprise, pas de personne).
// ============================================================

export interface MergeTagAccountData {
  display_name: string | null
  mrr_cents: number | null
  days_since_last_activity: number | null
}

const FALLBACK_COMPANY = 'this account'
const FALLBACK_ACTIVITY = 'unknown'

/**
 * Formate un montant en cents vers une chaîne de devise en-US
 * (produit standardisé en-US, cf. API_CONTRACTS.md § Langue produit).
 */
export function formatAmountAtRisk(mrrCents: number | null): string {
  const cents = mrrCents ?? 0
  return `$${(cents / 100).toFixed(2)}`
}

/**
 * Résout les merge-tags `{company}`, `{amount_at_risk}`,
 * `{days_since_last_activity}` dans un corps de template.
 * Valeur de repli explicite si la donnée source est absente —
 * jamais de merge-tag brut laissé dans le message final.
 */
export function resolveMergeTags(template: string, data: MergeTagAccountData): string {
  const company = data.display_name && data.display_name.trim().length > 0
    ? data.display_name.trim()
    : FALLBACK_COMPANY

  const daysSinceLastActivity = data.days_since_last_activity !== null
    ? String(data.days_since_last_activity)
    : FALLBACK_ACTIVITY

  return template
    .replace(/\{company\}/g, company)
    .replace(/\{amount_at_risk\}/g, formatAmountAtRisk(data.mrr_cents))
    .replace(/\{days_since_last_activity\}/g, daysSinceLastActivity)
}

/**
 * Échappement RFC 4180 : entoure de guillemets et double les guillemets
 * internes si le champ contient une virgule, un guillemet ou un retour ligne.
 */
export function escapeCsvField(value: unknown): string {
  const str = String(value ?? '')
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`
  }
  return str
}

export interface ExportCsvRow {
  account_ref: string
  mrr_at_risk_cents: number | null
  message: string
}

const CSV_HEADER = ['account_ref', 'mrr_at_risk_cents', 'message']

/**
 * Génère un CSV RFC 4180 (en-tête + une ligne par compte).
 * Retourne toujours l'en-tête, même si `rows` est vide (Edge Case:
 * playbook actif sans compte éligible → CSV en-tête seul, cf. spec.md).
 */
export function generateExportCsv(rows: ExportCsvRow[]): string {
  const lines = rows.map((row) =>
    [row.account_ref, String(row.mrr_at_risk_cents ?? 0), row.message]
      .map(escapeCsvField)
      .join(','),
  )
  return [CSV_HEADER.join(','), ...lines].join('\n') + '\n'
}
