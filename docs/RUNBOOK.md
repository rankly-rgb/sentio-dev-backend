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
