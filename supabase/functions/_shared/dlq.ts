import { SupabaseClient } from 'jsr:@supabase/supabase-js@2'

export async function writeToDLQ(
  supabase: SupabaseClient,
  entry: {
    organization_id: string
    provider: 'stripe' | 'hubspot' | 'usage' | 'outbound'
    event_type: string
    payload: unknown
    error_message: string
    retry_count?: number
  }
): Promise<void> {
  try {
    await supabase.from('webhook_dead_letter').insert({
      organization_id: entry.organization_id,
      provider: entry.provider,
      event_type: entry.event_type,
      payload: entry.payload,
      error_message: entry.error_message,
      retry_count: entry.retry_count ?? 0,
      max_retries: 3,
    })
  } catch {
    // DLQ write failure must not crash the caller — log to console as last resort
    console.error(
      JSON.stringify({
        level: 'error',
        message: 'Failed to write to DLQ',
        provider: entry.provider,
        event_type: entry.event_type,
        error: entry.error_message,
      })
    )
  }
}
