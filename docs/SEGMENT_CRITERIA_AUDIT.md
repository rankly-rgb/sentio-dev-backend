# Segment Criteria Audit — Scoring Engine V3

Audit of the exact logic behind `primary_segment` and the 9 segments visible in
the UI. No code changes made — this is documentation only, per the request
that triggered it. Where the audit surfaces something that looks like a bug,
it's called out explicitly rather than silently fixed.

## Source of truth

| Concern | File / function |
|---|---|
| Segment assignment rules | `supabase/functions/_shared/scoring.ts` → `determineSegmentTypesV3()` (line 781) |
| Inputs to those rules, derived from raw account/invoice/subscription data | `supabase/functions/calculate-scores/index.ts` → `scoreAccountPure()` (line 356) and the per-account loop (line 739) |
| Health score dimensions (payment_health / revenue_dynamics / contract_renewal) | `scoring.ts` → `calcPaymentHealthDimension`, `calcRevenueDynamicsDimension`, `calcContractRenewalDimension`, combined by `calcHealthScoreV3` |
| Churn risk (additive signals) | `scoring.ts` → `calcChurnRiskV2` / `buildChurnSignals` |
| Segment display names shown in the UI | `sentio-dev-frontend/src/i18n/en.ts` (`segments.*` keys, e.g. `impayes: 'Overdue'`) — **note the DB's own `segment_name` column uses different wording** (`'Unpaid'` for `impayes`, `'Critical Danger'` for `en_danger_critique`, `'Slightly at Risk'` for `a_risque_leger` — see `SEGMENT_DEFINITIONS` in `calculate-scores/index.ts`); the frontend never renders those DB strings, it has its own dictionary, so this is cosmetic drift, not a bug.
| Physical persistence | `segment_memberships` (many-to-many, includes `nouveaux` even though non-exclusive) + `accounts.primary_segment` (T0.2, one exclusive value per account, `nouveaux` excluded) |

## The 9 segments, in priority order

`determineSegmentTypesV3()` returns an array. `nouveaux` is pushed first and is
**additive** — it can coexist with exactly one of the other 8, which are
**mutually exclusive** and evaluated as an if/else-if chain (first match wins,
no fallthrough).

### 0. New (<90d) — `nouveaux` — additive, not exclusive

```
daysSinceCreation < 90
```

`daysSinceCreation = floor((now - accounts.created_at) / 86400000)`. This is
the row's creation date in Sentio's own database (when the account was first
synced), not the Stripe customer's creation date. Checked unconditionally,
independent of every other rule below — an account can be `Churned` **and**
`New` at the same time, `Champions` **and** `New`, etc.

### 1. Churned — `en_churn` — highest-priority exclusive branch

```
mrrCents === 0  OR  subscriptionCanceled === true
```

- `mrrCents` = `accounts.mrr_cents`, itself the sum of `mrr_cents` across the
  account's subscriptions **that are `status IN ('active', 'trialing')`** at
  sync time (`sync-stripe/index.ts:313`, `calculate-scores` just reads the
  already-aggregated column). Any subscription in any other status
  (`incomplete`, `past_due`, `unpaid`, `canceled`, `incomplete_expired`) is
  excluded from this sum.
- `subscriptionCanceled` = `subscriptions.length > 0 && subscriptions.every(s => s.status === 'canceled')` (`calculate-scores/index.ts:427`) — true only if the account has at least one synced subscription row and **all** of them are `canceled`. An account with zero subscription rows at all does *not* satisfy this condition (only the `mrrCents === 0` half of the OR can catch it).

Checked **before** every other exclusive rule, including `donnees_insuffisantes`. An account with `mrr_cents = 0` lands here regardless of how much or how little other data is available — insufficient-data status never gets evaluated for it.

### 2. Overdue — `impayes`

```
hasOverdueInvoices === true
```
= at least one invoice in the last 90 days with `status IN ('open', 'uncollectible')` and `due_date` in the past (`calculate-scores/index.ts:377-381`). Only reached if `mrrCents !== 0` and no subscription is fully canceled.

### 3. Insufficient data — `donnees_insuffisantes`

```
healthScoreStatus === 'insufficient'
```
See "Health score availability" below for exactly when this triggers. Only reached if the account has real MRR and isn't overdue — i.e. this segment can **only** ever be populated by accounts that are otherwise financially healthy-looking but too thin on payment/contract history to score. An account with `mrr_cents = 0` can never appear here even if it has zero of every other signal too, because rule 1 already claimed it.

### 4. Critical — `en_danger_critique`

```
churnRiskBand === 'high'   (churn_risk_score >= 50)
```

### 5. At risk — `a_risque_leger`

```
churnRiskBand === 'watch'   (25 <= churn_risk_score < 50)
```
`churn_risk_score` is the **additive** signal-based score (`calcChurnRiskV2`), not `100 - health_score` — see "Churn risk" below.

### 6. Champions — `champions`

```
healthScoreBand === 'healthy'   (>= 70% of available health points)
AND hasExpansionSignal === true
```
`hasExpansionSignal` = any of: an `expansion`-type MRR movement in the last 6 months, that same movement having `amount_cents > 0`, or `mrr3moAgoCents !== null && mrr3moAgoCents > 0 && currentMrr > mrr3moAgoCents` (`calculate-scores/index.ts:766`). An account can be perfectly healthy and still land in `Stable` instead of `Champions` if it has no expansion signal at all — this is a deliberate V3 change (see below).

### 7. Stable — `stables` — default

Falls through here if none of the above matched: healthy-or-watch churn band already excluded above, so this is specifically `churnRiskBand === 'low'` accounts that aren't Champions (either not `healthy` band, or `healthy` but no expansion signal).

### 8. Expanding — `en_expansion` — **retired, structurally always 0**

`SEGMENT_DEFINITIONS` in `calculate-scores/index.ts:127` still creates this
segment row (for backward compatibility with any existing `segment_memberships`
linking to it) but `determineSegmentTypesV3()` **never assigns it** — the V3
comment block (`scoring.ts:764-767`) documents that expansion was merged into
the `Champions` criteria (`hasExpansionSignal` is now a *requirement* for
Champions rather than its own segment). This is intentional, documented, and
not a bug — but it does mean this tile in the UI will show **0 accounts
forever**, on every org, regardless of real data. Worth knowing so nobody
"fixes" it as a bug later without checking this doc first.

## Health score availability (`insufficient` / `partial` / `complete`)

Three dimensions, each independently `available` or `unavailable`
(`combineWeightedSignals`, `scoring.ts:308`): a dimension is `unavailable` if
less than 50% of its **internal** signal weight has real data.

| Dimension | Org weight (default) | Internal signals (weight) | Unavailable when |
|---|---|---|---|
| `payment_health` | 35 | invoice_status_score (0.40), payment_history_score (0.35), dunning_score (0.25) | invoice_status_score needs ≥1 invoice in 90d; payment_history_score needs ≥3 invoices in 12mo; dunning_score needs ≥1 invoice in 90d. **If the account has zero invoices synced at all, all three are null → dimension unavailable** (0% < 50%). |
| `revenue_dynamics` | 35 | mrr_trend_score (0.45), contraction_score (0.35), expansion_signal_score (0.20) | mrr_trend_score needs a 3-months-ago MRR snapshot (`score_history`) — null for any account without ≥3 months of scoring history. contraction_score and expansion_signal_score **always** return a value (100/60 defaults when no movements exist — see below) — so this dimension is available (55% ≥ 50%) as soon as the account has been scored at least once, even brand new. |
| `contract_renewal` | 30 | billing_interval_score (0.30), renewal_proximity_score (0.40), tenure_score (0.30) | billing_interval_score/renewal_proximity_score need `accounts.billing_interval` to be non-null; tenure_score needs `contract_start_date`. **Both are only ever written by `sync-stripe` from subscriptions with `status IN ('active','trialing')`** — an account whose only subscription is stuck in e.g. `incomplete` never gets `billing_interval`/`contract_start_date`/`contract_end_date` populated at all, making this dimension unavailable too. |

Then, at the composite level (`calcHealthScoreV3`, `scoring.ts:536`):
`coveragePct` = sum of the *org weights* of the available dimensions only.
- `coveragePct >= 100` → `status: 'complete'`
- `50 <= coveragePct < 100` → `status: 'partial'` (health_score_points is a real number, computed only from available dimensions, org weights unchanged — no renormalization, per the "no renormalization" decision already documented in CLAUDE.md)
- `coveragePct < 50` → `status: 'insufficient'` → **`health_score_points` is `null`**, not a number, not a default like 50 or 40.

This last point matters directly for the anomaly below: **a genuinely "insufficient" account has a `null` health score, never a numeric one.** If only `revenue_dynamics` (weight 35) is available and both `payment_health` (35) and `contract_renewal` (30) are unavailable, `coveragePct = 35 < 50` → `insufficient` → `health_score = null`.

## Churn risk (additive, not `100 - health`)

`calcChurnRiskV2` sums points from up to 7 independent boolean signals
(`buildChurnSignals`, `scoring.ts:690-699`), each **skipped (not counted as
false)** if its underlying data is absent:

| Signal | Points | Severity |
|---|---|---|
| Invoice overdue 15+ days | 35 | CRITIQUE |
| MRR contraction ≥20% over 3 months | 30 | CRITIQUE |
| ≥2 payment failures in 90 days | 25 | MAJEUR |
| Monthly billing + account <6 months old | 20 | MAJEUR |
| Annual renewal within 30 days with recent contraction | 20 | MAJEUR |
| Plan downgrade in the last 6 months | 10 | MINEUR |
| Invoice overdue under 15 days | 10 | MINEUR |

`churn_risk_score = sum(points of triggered signals)`, capped [0, 100].
Band: `>= 50` high (→ Critical), `25-49` watch (→ At risk), `< 25` low.
An account with **no signals evaluable at all** (no invoices, no movements,
no contract dates) scores **0** — `low` band — by construction (nothing was
triggered, because nothing could be evaluated), which is why a thin-data
account still ends up `stables`/Stable rather than any risk band, *unless*
rule 1 (`en_churn`) or rule 3 (`donnees_insuffisantes`) already claimed it first.

## The observed anomaly: 100 accounts in Churned, 100 in New (<90d), 7 segments at 0, identical health_score=40

### What's fully explained by the code (high confidence, no live data needed)

**"7 of 9 segments show 0" is exactly what the priority chain guarantees, not
a bug, given that all 100 accounts share `mrr_cents = 0`:**

- `Expanding` is 0 on every org, forever (retired in V3, see above) — 1 of the 7.
- Rule 1 (`en_churn`) is checked **before** every other exclusive rule. If all
  100 accounts have `mrr_cents === 0`, every single one of them gets claimed
  by `en_churn` unconditionally — `Overdue`, `Insufficient data`, `Critical`,
  `At risk`, `Champions`, and `Stable` are **structurally unreachable** for
  this specific cohort, because the if/else-if chain never even evaluates
  those conditions once rule 1 matches. That's the other 6 of the 7.

This is not "two segments silently falling back to the same default
classification instead of their real criteria" — it's the opposite: `en_churn`
and `nouveaux` are each firing on their own, real, distinct criteria
(`mrr_cents === 0`, and `created_at` within 90 days), which both happen to be
true for the same 100 accounts simultaneously. `nouveaux` is additive by
design, so it doubles up rather than competing with `en_churn` for the same
slot.

**Why would `mrr_cents` be exactly `0` for all 100 accounts** is itself fully
explained by `sync-stripe`'s aggregation rule: only subscriptions with
`status IN ('active', 'trialing')` contribute to `accounts.mrr_cents`
(`sync-stripe/index.ts:313`). If the 100 Stripe test-mode customers connected
to this org have subscriptions that never reached `active` — most commonly
because they were created via the API without a confirmed default payment
method attached, which leaves a Stripe subscription in `status: incomplete`
indefinitely in test mode — `sync-stripe` would correctly compute
`mrr_cents = 0` for every one of them. **Recommend checking subscription
status directly in the Stripe dashboard for a sample of these customers as
the first diagnostic step** — this is the single most likely explanation and
is directly checkable without touching Sentio at all.

The same `status IN ('active','trialing')` gate (`sync-stripe/index.ts:313`)
is also what writes `billing_interval`/`contract_start_date`/`contract_end_date`
onto `accounts` (line 381-384) — if no subscription ever reached
`active`/`trialing`, these three fields stay `null`, which independently
explains why `contract_renewal` would be `unavailable` for these accounts too.

### What needs live-data confirmation (cannot be settled from code alone)

**The specific numeric value `40`, identical across all 100 accounts, does not
have a single obvious derivation from the formulas above** — and one thing
looks worth checking rather than assuming benign:

If `payment_health` is unavailable (no invoices — plausible if subscriptions
never activated, since Stripe often doesn't generate invoices for
`incomplete` subscriptions) **and** `contract_renewal` is unavailable (no
billing_interval/contract dates, per the mechanism above), only
`revenue_dynamics` (org weight 35) would remain available —
`coveragePct = 35 < 50` → **`health_score_status` should be `'insufficient'`
and `health_score` should be `null`**, not a defined number like 40.

A **defined, identical 40 across 100 accounts is only consistent with the code
if at least one more dimension is actually available** — e.g. if these test
subscriptions *did* generate at least one invoice each (uncollectible or
otherwise) despite not reaching `active` status, `payment_health` could
become available with a low, identical score across all 100 (since they'd
all share the same invoice shape), pushing `coveragePct` to `partial` and
producing a real, low, uniform number.

**The uniformity itself (identical 40 for 100 different accounts) is not
surprising or suspicious on its own** — it's exactly what you'd expect if all
100 were created by the same seeding script stamping every customer with an
identical subscription/invoice shape, feeding a deterministic formula. That
part requires no further explanation. What's worth verifying with real data
is specifically **whether `health_score_status` for these accounts is
`'insufficient'` (in which case the persisted `health_score` column should be
`NULL`, and if the UI is showing `40` anyway, that number is coming from
somewhere other than `accounts.health_score` — worth checking the frontend
display path for a null-coalescing fallback) or `'partial'` (in which case 40
is a real, low, legitimately-computed score and there's nothing to fix).**

**Recommended verification query**, directly against the connected org:
```sql
select health_score, health_score_status, health_score_max_points,
       payment_health_score, revenue_dynamics_score, contract_renewal_score,
       mrr_cents, created_at
from accounts
where organization_id = '<org_id>'
limit 5;
```
If `health_score_status = 'insufficient'` and `health_score` is `NULL` here
but the UI shows `40`, that's a real frontend bug (rendering a fallback
number instead of "N/A"/"Insufficient data"), not a backend scoring issue —
worth a follow-up ticket, not fixed in this pass since no code change was
authorized beyond documenting a genuine bug if found, and this one still
needs the query above to confirm either way.

## Summary verdict

**Not a bug in the segmentation or scoring logic.** The 7-zero / 2-hundred
pattern is the deterministic, correct consequence of (a) `Expanding` being
permanently retired in V3, and (b) all 100 test accounts sharing
`mrr_cents = 0`, which is itself fully explained by `sync-stripe` only
aggregating MRR/contract fields from `active`/`trialing` subscriptions — most
likely because these Stripe test subscriptions never left `incomplete`
status. The identical `40` health score is very plausibly a legitimate,
low, uniform score computed from identically-shaped thin test data — but
confirming it isn't a null-defaulting-to-40 frontend display bug requires
the query above, which needs live database access this environment doesn't
have.
