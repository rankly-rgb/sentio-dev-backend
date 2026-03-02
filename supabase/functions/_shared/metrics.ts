import { SupabaseClient } from 'jsr:@supabase/supabase-js@2'

export async function recordMetric(
  supabase: SupabaseClient,
  metric: {
    organization_id: string
    provider: 'stripe' | 'hubspot' | 'usage'
    sync_type: string
    duration_ms?: number
    records_processed?: number
    records_created?: number
    records_updated?: number
    records_failed?: number
    success: boolean
    error_message?: string
  }
): Promise<void> {
  try {
    await supabase.from('sync_metrics').insert({
      organization_id: metric.organization_id,
      provider: metric.provider,
      sync_type: metric.sync_type,
      duration_ms: metric.duration_ms ?? null,
      records_processed: metric.records_processed ?? 0,
      records_created: metric.records_created ?? 0,
      records_updated: metric.records_updated ?? 0,
      records_failed: metric.records_failed ?? 0,
      success: metric.success,
      error_message: metric.error_message ?? null,
    })
  } catch {
    // Fire-and-forget: metrics recording must never crash the caller
  }
}
