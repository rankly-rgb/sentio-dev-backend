/**
 * Account type matching the Supabase `accounts` table.
 * Used across dashboard, segments, accounts pages.
 */
export interface Account {
  id: string
  organization_id: string
  stripe_customer_id: string | null
  hubspot_company_id: string | null
  plan_tier: string | null
  billing_interval: string | null
  mrr_cents: number | null
  seat_count: number | null
  seat_limit: number | null
  contract_start_date: string | null
  contract_end_date: string | null
  health_score: number | null
  churn_risk_score: number | null
  expansion_score: number | null
  product_usage_score: number | null
  financial_score: number | null
  engagement_score: number | null
  contract_score: number | null
  usage_tracker_connected: boolean
  created_at: string
  updated_at: string
}

/** Columns selected for list views (lighter than full Account) */
export const ACCOUNT_LIST_SELECT = [
  'id',
  'stripe_customer_id',
  'hubspot_company_id',
  'plan_tier',
  'billing_interval',
  'mrr_cents',
  'seat_count',
  'seat_limit',
  'contract_end_date',
  'health_score',
  'churn_risk_score',
  'expansion_score',
  'product_usage_score',
  'created_at',
].join(',')
