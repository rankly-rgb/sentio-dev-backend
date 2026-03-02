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
