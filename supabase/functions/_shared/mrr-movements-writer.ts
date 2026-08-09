// ============================================================
// mrr-movements-writer.ts — écriture des mrr_movements générés par le
// chemin batch (sync-stripe), via le RPC upsert_mrr_movements_sync
// (migration 20260808000001) plutôt qu'un .upsert() PostgREST direct.
//
// Root cause du bug corrigé (docs/CHANGELOG_STABILITY.md, 2026-08-08) :
// .upsert(rows, { onConflict: 'organization_id,account_id,movement_date,
// movement_type' }) génère un ON CONFLICT sans prédicat, qui ne peut
// jamais cibler l'index partiel mrr_movements_sync_idempotency (WHERE
// stripe_event_id IS NULL) — chaque écriture échouait avec 42P10, jamais
// remonté à l'appelant (jeté via console.error seul). Ce module isole le
// correctif dans un fichier testable en Vitest (comme _shared/cron-lock.ts
// et _shared/data-sync-logger.ts — import SupabaseClient depuis jsr: en
// tant que TYPE seulement, effacé à la compilation, donc résolvable par
// Node/Vitest) — sync-stripe/index.ts lui-même reste non-importable
// (imports jsr: runtime réels).
//
// Dédoublonnage intra-batch (dedupeMovementRows) : customerToAccount
// (sync-stripe/index.ts) est un Map<stripe_customer_id, account_id> — si
// deux stripe_customer_id distincts pointent vers le même account_id
// (doublon de données historique, cf. commit 4325aa6 "fix(data):
// supprimer doublons display_name dans accounts"), la boucle de
// génération des mouvements peut pousser deux lignes identiques dans le
// même run, avant tout aller-retour DB — le RPC ne protège que contre les
// lignes déjà persistées, pas contre deux lignes en conflit l'une avec
// l'autre dans le même appel. Dédoublonner ici lève toute ambiguïté.
// ============================================================
import { SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import type { WriteError } from './data-sync-logger.ts'

export interface MrrMovementSyncRow {
  organization_id: string
  account_id: string
  movement_type: string
  amount_cents: number
  movement_date: string
}

export function dedupeMovementRows(rows: MrrMovementSyncRow[]): MrrMovementSyncRow[] {
  const seen = new Map<string, MrrMovementSyncRow>()
  for (const row of rows) {
    const key = `${row.organization_id}|${row.account_id}|${row.movement_date}|${row.movement_type}`
    seen.set(key, row)
  }
  return Array.from(seen.values())
}

export interface WriteMrrMovementsResult {
  processed: number
  failed: number
  writeError: WriteError | null
}

export async function writeMrrMovementsSync(
  supabase: SupabaseClient,
  rows: MrrMovementSyncRow[],
): Promise<WriteMrrMovementsResult> {
  if (rows.length === 0) return { processed: 0, failed: 0, writeError: null }

  const { error } = await supabase.rpc('upsert_mrr_movements_sync', { rows })

  if (error) {
    return {
      processed: 0,
      failed: rows.length,
      writeError: { table: 'mrr_movements', message: error.message, code: error.code ?? null },
    }
  }
  return { processed: rows.length, failed: 0, writeError: null }
}
