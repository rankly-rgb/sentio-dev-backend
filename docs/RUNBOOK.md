# Sentio AI — Operations Runbook

## Incident Response Procedures

### 1. Webhook Processing Failure

**Detect**: Slack alert "DLQ entries > threshold" or check `webhook_dead_letter` table.

**Diagnose**:
```sql
SELECT provider, event_type, error_message, COUNT(*), MAX(created_at)
FROM webhook_dead_letter
WHERE created_at > NOW() - INTERVAL '1 hour' AND resolved_at IS NULL
GROUP BY provider, event_type, error_message
ORDER BY count DESC;
```

**Fix**:
- If transient errors (timeout, 5xx) — events are preserved in DLQ for manual replay.
- If systematic (code bug) — fix code, redeploy Edge Function, then replay DLQ entries.

**Verify**:
```sql
SELECT COUNT(*) FROM webhook_dead_letter WHERE resolved_at IS NULL;
```

---

### 2. Sync Stripe Failure

**Detect**: Slack alert or check `data_syncs` table.

**Diagnose**:
```sql
SELECT id, sync_status, error_message, error_type, is_retryable, duration_seconds
FROM data_syncs WHERE sync_source = 'stripe'
ORDER BY created_at DESC LIMIT 5;
```

**Fix**:
- `rate_limit` — wait 60 seconds, then re-trigger sync.
- `api_error` + `is_retryable = true` — re-trigger sync.
- Persistent failure — check Stripe status page, verify `STRIPE_SECRET_KEY`.
- Circuit breaker OPEN — wait for `resetTimeoutMs` (60s) auto-reset.

**Re-trigger manually**:
```bash
curl -X POST https://upqakxuatlshhqiagbqw.supabase.co/functions/v1/sync-stripe \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"sync_type": "incremental", "is_manual": true}'
```

**Verify**: `data_syncs.sync_status = 'completed'` for the latest record.

---

### 3. Slow Database

**Detect**: Edge Function durations increasing, scoring timeouts.

**Diagnose**:
```sql
-- Top slow queries (requires pg_stat_statements extension)
SELECT query, calls, mean_exec_time, max_exec_time
FROM pg_stat_statements
ORDER BY mean_exec_time DESC LIMIT 20;

-- Tables with excessive sequential scans
SELECT schemaname, relname, seq_scan, idx_scan
FROM pg_stat_user_tables
WHERE seq_scan > idx_scan
ORDER BY seq_scan DESC;
```

**Fix**:
1. Check if new indexes from migration `20260302000001_stability_indexes.sql` are applied.
2. Run `VACUUM ANALYZE` on affected tables.
3. If connection saturation, reduce batch sizes in scoring.

**Verify**: Function durations return to baseline (< 30s for scoring, < 120s for sync).

---

### 4. Provider Down (Stripe / HubSpot)

**Detect**: Circuit breaker state = OPEN; Slack alerts; `data_syncs` filled with `rate_limit` or `api_error`.

**Diagnose**:
- Check Stripe status: https://status.stripe.com/
- Check HubSpot status: https://status.hubspot.com/
- Verify `data_syncs` errors match provider outage.

**Fix**:
1. Wait for provider recovery — circuit breaker auto-resets after 60 seconds.
2. Webhook events are preserved in `webhook_dead_letter` for replay.
3. After recovery, run a `full_sync` to catch up on missed data.

**Verify**: Circuit breaker returns to `closed`. Next sync completes.

---

### 5. Cron Stuck

**Detect**: Slack alert from `self-monitor` or check `cron_locks`.

**Diagnose**:
```sql
SELECT lock_key, locked_at, locked_by, expires_at,
  EXTRACT(EPOCH FROM NOW() - locked_at) AS age_seconds
FROM cron_locks;
```

**Fix**:
- If lock is expired — `self-monitor` auto-releases it every 15 minutes.
- If truly stuck, manually release:
```sql
DELETE FROM cron_locks WHERE lock_key = 'sync-stripe';
-- or
DELETE FROM cron_locks WHERE lock_key = 'calculate-scores';
```

**Verify**: Next cron run acquires lock and completes normally.

---

### 6. Scoring Stale

**Detect**: Slack alert from `self-monitor` ("scoring is stale").

**Diagnose**:
```sql
SELECT snapshot_date, COUNT(*) as accounts
FROM score_history
GROUP BY snapshot_date
ORDER BY snapshot_date DESC
LIMIT 5;
```

**Fix**: Manually trigger scoring:
```bash
curl -X POST https://upqakxuatlshhqiagbqw.supabase.co/functions/v1/calculate-scores \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  -d '{}'
```

**Verify**: New `score_history` rows for today's date.

---

### 7. Scoring Engine V2 — segment invariant & model validation

**Segment invariant (S12)**: every active account must belong to exactly one
health segment (`champions`/`stables`/`a_risque_leger`/`en_danger_critique`/
`impayes`/`en_churn`/`donnees_insuffisantes`) — never zero, never more than
one. `nouveaux` is the only non-exclusive segment and is excluded from this
check. This is what closes out the "zero accounts displayed" investigation
from the V1 audit: if this query returns 0 rows, the assignment logic is
sound and any empty-segment symptom in the frontend is a read-path issue
(RLS, query filter), not a backend scoring bug.

**Run monthly, or immediately after any `calculate-scores` deploy**:
```sql
-- Accounts with != 1 health segment (excluding the non-exclusive 'nouveaux')
SELECT a.id, a.organization_id, COUNT(*) AS health_segment_count,
       array_agg(seg.segment_type) AS segments
FROM accounts a
JOIN segment_memberships sm ON sm.account_id = a.id AND sm.status = 'active'
JOIN account_segments seg ON seg.id = sm.segment_id AND seg.segment_type <> 'nouveaux'
GROUP BY a.id, a.organization_id
HAVING COUNT(*) <> 1;
```
**Expected**: 0 rows. If any row appears, check `assignSegments()` in
`calculate-scores/index.ts` — the stale-membership cleanup step may have
failed for that org (see error logs for `stale membership cleanup error`).

**Also verify no account is simultaneously in `donnees_insuffisantes` and
another health segment** (should already be impossible given the query
above, but useful as a targeted check):
```sql
SELECT a.id, array_agg(seg.segment_type)
FROM accounts a
JOIN segment_memberships sm ON sm.account_id = a.id AND sm.status = 'active'
JOIN account_segments seg ON seg.id = sm.segment_id
WHERE seg.segment_type <> 'nouveaux'
GROUP BY a.id
HAVING 'donnees_insuffisantes' = ANY(array_agg(seg.segment_type))
   AND COUNT(*) > 1;
```
**Expected**: 0 rows.

**Model validation report (S10)** — recall of the churn model: for accounts
that churned (subscription canceled) in the last 90 days, what was their
`churn_risk_band` 30 and 60 days before churn? Run monthly, no UI in V1.
```sql
WITH churned AS (
  SELECT s.account_id, s.organization_id, MAX(s.canceled_at) AS churned_at
  FROM subscriptions s
  WHERE s.status = 'canceled'
    AND s.canceled_at > NOW() - INTERVAL '90 days'
  GROUP BY s.account_id, s.organization_id
)
SELECT
  c.account_id,
  c.churned_at,
  sh30.churn_risk_band AS band_at_j_minus_30,
  sh60.churn_risk_band AS band_at_j_minus_60
FROM churned c
LEFT JOIN LATERAL (
  SELECT churn_risk_band FROM score_history
  WHERE account_id = c.account_id AND snapshot_date <= (c.churned_at::date - 30)
  ORDER BY snapshot_date DESC LIMIT 1
) sh30 ON true
LEFT JOIN LATERAL (
  SELECT churn_risk_band FROM score_history
  WHERE account_id = c.account_id AND snapshot_date <= (c.churned_at::date - 60)
  ORDER BY snapshot_date DESC LIMIT 1
) sh60 ON true
ORDER BY c.churned_at DESC;
```
**Interpretation**: recall_30 = (rows where `band_at_j_minus_30` IN
('high','watch')) / (total rows). A recall well below ~70% signals the
7 deterministic churn signals (S5) are missing a real-world pattern — feed
this back into Phase 3's planned logistic regression over historical churn.

---

### 8. Deploying backend ahead of its matching frontend

**Incident (2026-08-05)**: #27+#31 were merged and deployed alone, without their
matching frontend PR (#10). The deployed app broke immediately in production:
Overview, Accounts list, and Segments all failed with a real Postgres error
(`column "mrr_status" does not exist`) — not a frontend/backend contract
mismatch, but a **view left stale by migration ordering**. `accounts_with_priority`
is defined as `SELECT a.* ... FROM accounts a`. Postgres freezes a `SELECT *`
view into an explicit column list **at the moment the view is created** — a
column added to the base table afterward does NOT appear in the view's output
until the view is dropped/recreated. The migration adding `mrr_status`
(`20260804000001`) ran one day after the view's last recreation
(`20260803000002`), so the column was invisible to the view even though it
existed on `accounts`. The very next PR (`8ac3223`) started selecting
`mrr_status` from that view — and broke on first use, in production, the
moment it deployed.

**Rules going forward**:

1. **Any migration that adds a column consumed by a `SELECT *` view must
   recreate that view in the same migration series.** Grep
   `supabase/migrations/` for `SELECT a\.\*|SELECT \*` before adding a column
   to a table that has one or more views defined over it, and add a
   `DROP VIEW` / `CREATE VIEW` for each one in the same PR — never assume a
   view "just picks up" new columns.
2. **A backend PR that changes a contract the frontend consumes (new
   response fields another endpoint now emits, new enum values written to a
   table the frontend reads) should not be deployed alone to a shared
   environment** unless the currently-deployed frontend is verified to
   tolerate the change (e.g. by reading its actual query/type code, not by
   assuming). If the matching frontend PR exists, deploy both together, or
   get explicit confirmation the gap is safe before merging the backend PR
   on its own.
3. **After any deploy that touches SQL views, sanity-check by replaying the
   exact `SELECT` your Edge Function handlers issue** against the view/table
   via `execute_sql` (or an equivalent SQL client) before declaring the
   deploy verified — a green CI/migration-apply run does not catch a stale
   view, since `CREATE OR REPLACE VIEW` errors would surface at migration
   time, but a `DROP`-less oversight (forgetting to touch the view at all)
   produces no error anywhere until a query actually asks for the missing
   column.

---

## One-Time Migration Procedures

### MRR Engine v2 — Restatement (Phase 2.4, docs/openspec.md)

The MRR derivation formula changed (`_shared/mrr-engine.ts`): all subscription
items are now summed instead of only `items.data[0]`, `interval_count` is
respected (quarterly/weekly no longer miscounted as monthly), active
discounts are applied, and trials are excluded from `mrr_cents`. Existing
`accounts.mrr_cents` values were computed with the old formula and must be
restated **before** relying on `mrr_movements`/NRR for any org synced prior
to this deploy — otherwise the very next normal sync would generate a wave
of fake `contraction`/`expansion`/`churn` movements purely from the formula
change, permanently polluting NRR.

**Run once per org, before/immediately after deploying this change**:

```bash
curl -X POST "$SUPABASE_URL/functions/v1/sync-stripe" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"organization_id": "<org-uuid>", "restatement_mode": true}'
```

Omit `organization_id` to restate all active organizations in one call
(sequential dispatch, same as a normal multi-org sync run).

**If you don't have shell/curl access and must trigger this from the SQL
Editor instead** (`net.http_post`, e.g. reusing a cron job's stored
`url`/`headers`): set `timeout_milliseconds` explicitly, generously — the
existing cron jobs use `25000` for a normal per-org sync, but a multi-org
`restatement_mode` call fans out sequentially across every active org
inside ONE invocation (up to `AbortSignal.timeout(280000)` per the code) and
can legitimately run for minutes. `net.http_post`'s own default timeout is
**5000ms**, far shorter — hit in practice on 2026-08-04 (`error_msg:
"Timeout of 5000 ms reached..."`, `status_code: null`, `content: null` in
`net._http_response`). The function itself was *not* killed by this — it
kept running server-side and completed real work for every org — but the
caller got zero visibility into the outcome, exactly the wrong moment to be
flying blind on a run that mutates every account's MRR. Prefer the `curl`
above, which has no such default; if you must use `net.http_post`, add
`timeout_milliseconds := 290000` to the call.

Either way, **do not trust `net._http_response`/a client-side timeout as a
signal of success or failure** — verify against `mrr_restatements` and
`data_syncs.sync_status` (see below) regardless of what the calling client
observed.

**What it does**: recomputes `accounts.mrr_cents`/`arr_cents` with the new
formula, generates **zero** `mrr_movements` rows, and logs every account
whose value actually changed into `mrr_restatements` (`old_mrr_cents`,
`new_mrr_cents`, `reason`). The MRR-collapse anomaly guard
(`sync-anomaly-guard.ts`) is explicitly bypassed for this run — a formula
change legitimately shifts many accounts at once, which is not the
regression that guard exists to catch.

**Verify — check `data_syncs` FIRST, before looking at deltas at all**
(2026-08-04 incident, IMPLEMENTATION_LOG.md — a run can return HTTP 200 and
still have written nothing):
```sql
SELECT organization_id, sync_status, records_processed, records_failed, error_message, sync_summary
FROM data_syncs
WHERE sync_source = 'stripe'
ORDER BY started_at DESC
LIMIT <number of orgs restated>;
```
`sync_status` must be `completed` for every row (`sync_summary.restatement_mode`
confirms the mode actually ran, `sync_summary.accounts_restated` is the count
that changed). `completed_with_errors` or `failed` means some/all accounts
in that org were **not** written — `error_message` now carries the real
Postgres error (see `_shared/data-sync-logger.ts`) — fix that before trusting
`mrr_restatements` for the affected org(s) at all; a partial write there is
worse than no write, not a rounding error to shrug off.

Only once every row above shows `sync_status='completed'`:
```sql
SELECT organization_id, COUNT(*), SUM(new_mrr_cents - old_mrr_cents) AS net_delta_cents
FROM mrr_restatements
WHERE reason = 'mrr_engine_v2_migration'
GROUP BY organization_id
ORDER BY ABS(SUM(new_mrr_cents - old_mrr_cents)) DESC;
```
Review orgs with the largest deltas manually before trusting their NRR
going forward. Confirm zero `mrr_movements` were written for this run:
```sql
SELECT COUNT(*) FROM mrr_movements WHERE created_at > '<restatement run timestamp>';
-- expect 0, or only rows from unrelated concurrent webhook activity
```

**After running**: the normal cron/webhook sync resumes automatically (no
flag to unset) — the next scheduled `sync-stripe` run will see
`prevMrr ≈ newMrr` for every restated account and generate no spurious
movements.

**Concurrency**: `sync-stripe` locks per-org (`cron_locks`, key
`sync-stripe-<org_id>`) — a normal cron/webhook-triggered sync for the same
org cannot run while a restatement is in progress for it, and vice versa; one
of the two gets a clean `409 Sync already in progress` rather than
interleaving writes. The lock TTL is 600s in `restatement_mode` (vs 300s for
a normal sync) since a full recompute can legitimately take longer on a
large org.

`restatement_mode` additionally holds a second, dedicated lock
(`restatement-<org_id>`, same 600s TTL) for the duration of the run. This is
the lock `stripe-webhook` checks (read-only, `isCronLockHeld`) before writing
`accounts.mrr_cents`/classifying a movement for an incoming event — **only**
while an actual restatement is running for that org, never during a normal
daily sync. A webhook arriving in that window still upserts the
`subscriptions` row immediately (always safe); only the account-level MRR
write and movement generation are deferred until the next normal sync
reconciles them (see `docs/openspec.md` §10bis for the full rationale, and
why checking the shared `sync-stripe-<org_id>` lock instead — an earlier
draft did this — would have wrongly deferred webhooks during every normal
daily sync too, up to a 24h real-time-latency regression that was never an
intended tradeoff).

**If interrupted mid-run** (crash, timeout, dropped connection): re-run the
exact same curl command. The restatement is idempotent — `mrr_restatements`
is written before `accounts` on each account and upserted on
`(account_id, reason)` (migration `20260804000006`), so a replay recomputes
and safely re-confirms the same audit row for any account whose delta wasn't
fully persisted yet, then finishes writing `accounts`. Accounts that
completed on the first pass are unaffected (delta is 0 on replay, both
writes are skipped for them).

## Monitoring Endpoints

| Endpoint | Purpose | Frequency |
|----------|---------|-----------|
| `GET /functions/v1/health-check` | System health status | Every 5 min (external monitor) |
| `POST /functions/v1/self-monitor` | Auto-recovery + alerting | Every 15 min (Supabase cron) |

## Alert Thresholds

| Metric | Warning | Critical |
|--------|---------|----------|
| Sync duration | > 120s | > 240s |
| Sync failures (1h) | > 2 | > 5 |
| DLQ entries (1h) | > 5 | > 20 |
| Scoring staleness | > 26h | > 48h |
| Stuck cron lock | expired | > 30 min past expiry |

## Key Tables for Debugging

| Table | Purpose |
|-------|---------|
| `data_syncs` | Audit log of all sync/scoring operations |
| `webhook_dead_letter` | Failed webhook events for replay |
| `cron_locks` | Distributed lock state |
| `sync_metrics` | Performance metrics time-series |
| `score_history` | Daily scoring snapshots |
