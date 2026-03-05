---
name: edge-function
description: Create or modify a Supabase Edge Function following Sentio patterns
---

# Edge Function Pattern (Sentio)

When creating or modifying an Edge Function, follow this mandatory pattern:

## REST/Webhook Functions

1. CORS check via `handleCors(req)` — return early if OPTIONS
2. Auth: `verifyUserAuth(req)` for JWT, or HMAC verification for webhooks
3. `createServiceClient()` wrapped in try/catch
4. Parse + validate request body/params
5. Resolve tenant via `organization_id` from auth result
6. Business logic (pure functions preferred, testable)
7. Persist to database
8. Return JSON response (< 5s for webhooks)

## Cron Functions

1. `acquireCronLock(supabase, 'function-name')` — return 409 if locked
2. try: business logic + `DataSyncLogger`
3. catch: `logger.fail()` + `alertSlack()`
4. finally: `releaseCronLock()` wrapped in try/catch

## External API Calls

Always use: `fetchWithTimeout(8s)` + `retryWithBackoff(3x)` + `CircuitBreaker`

## Non-Negotiable Rules

- EVERY query must be scoped by `organization_id`
- Use `.maybeSingle()` instead of `.single()` everywhere
- No PII: never store email, name, phone, IP
- `verify_jwt = false` in config.toml for functions using ES256 JWT auth (verify via `supabase.auth.getUser()`)
- `verify_jwt = true` only for cron functions using service_role HS256

## Files to Reference

- `supabase/functions/_shared/auth.ts` — JWT verification
- `supabase/functions/_shared/supabase-client.ts` — client creation + CORS
- `supabase/functions/_shared/cron-lock.ts` — distributed locking
- `supabase/functions/_shared/fetch-with-timeout.ts` — timeout wrapper
- `supabase/functions/_shared/retry-with-backoff.ts` — retry logic
- `supabase/functions/_shared/circuit-breaker.ts` — circuit breaker
- `supabase/functions/_shared/dlq.ts` — dead letter queue
- `supabase/functions/_shared/slack-alert.ts` — Slack alerting
- `supabase/functions/_shared/structured-logger.ts` — JSON logging
