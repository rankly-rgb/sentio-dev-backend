// ============================================================
// Connecteurs Playbook — Types communs
//
// Zero-PII : customer_email_transit est récupéré depuis l'API Stripe
// en mémoire uniquement. Il n'est JAMAIS persisté, loggé ou inclus
// dans un payload stocké. Durée de vie : < 500ms par exécution.
// ============================================================

export interface ConnectorPayload {
  // Données de l'account — Zero-PII : pas d'email dans cette struct
  stripe_customer_id: string
  segment: string
  segment_previous?: string
  health_score: number
  churn_risk_score: number
  expansion_score: number
  mrr_cents: number
  mrr_eur: number
  organization_id: string
  trigger_reason: string
  // Email récupéré en transit depuis Stripe — JAMAIS persisté
  customer_email_transit: string
}

export interface ConnectorResult {
  success: boolean
  http_status?: number
  // Tronqué à 500 chars, sans PII
  error_message?: string
  // Tronqué à 500 chars, sans PII
  connector_response?: string
}

export interface ConnectorConfig {
  api_key: string
  api_endpoint?: string
  template_id?: string
  message_template?: string
}

export function truncate(str: string, maxLen = 500): string {
  return str.length > maxLen ? str.slice(0, maxLen) : str
}
