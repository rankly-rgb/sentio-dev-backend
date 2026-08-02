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

### 3. Insufficient data — `donnees_insuffisantes` — **appears to be unreachable in practice (see bug callout below)**

```
healthScoreStatus === 'insufficient'
```
See "Health score availability" below for exactly when this triggers. Only reached if the account has real MRR and isn't overdue — i.e. this segment can **only** ever be populated by accounts that are otherwise financially healthy-looking but too thin on payment/contract history to score. An account with `mrr_cents = 0` can never appear here even if it has zero of every other signal too, because rule 1 already claimed it.

**Found while designing the part-2 seeding script, not in the first pass of this audit**: trying to actually construct a test case that lands here surfaces that the combination of rules elsewhere in this same file makes `insufficient` structurally very hard — quite possibly impossible — to reach at all. See the callout right after this list.

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

## ⚠️ Genuine bug found: `donnees_insuffisantes` (Insufficient data) is very likely unreachable

Unlike `en_expansion`/Expanding (deliberately retired, documented in a code
comment, not a bug), nothing in the code says `donnees_insuffisantes` is
meant to be dead. But tracing what it would actually take to reach
`healthScoreStatus === 'insufficient'` shows it structurally can't happen
under any normal Stripe-synced data:

1. **`revenue_dynamics` is unconditionally available, always**, regardless
   of how little data exists. Its two lowest-weight signals never return
   `null`: `calcContractionScore` returns `100` whenever there's no
   contraction movement (`scoring.ts:443` — `if (contractionTotal === 0)
   return 100`, true for an account with zero `mrr_movements` rows at all),
   and `calcExpansionSignalScore` returns `60` whenever there's no expansion
   movement (`scoring.ts:452-453`). Combined weight `0.35 + 0.20 = 0.55 ≥
   0.5` — so `revenue_dynamics` is `available` even on an account's very
   first scoring run, with zero movement history, zero MRR trend data.
   `mrr_trend_score` (the one signal that *can* be null) doesn't matter
   either way.

2. **`contract_renewal` is available whenever `mrr_cents !== 0`.** An
   account only has nonzero `mrr_cents` because `sync-stripe` summed it from
   subscriptions with `status IN ('active','trialing')`
   (`sync-stripe/index.ts:313`) — and that exact same code path
   (`accountSubMeta`, lines 312-330) is what sets `billing_interval` and
   `contract_start_date`/`contract_end_date` on the account, from the same
   `primary` subscription object, in the same batch update. There is no way
   for `mrr_cents` to be nonzero without `billing_interval` also being set.
   Once `billing_interval` is set, `calcBillingIntervalScore` is always
   non-null (weight 0.30), and `calcRenewalProximityScore` returns a constant
   `70` for `monthly` billing regardless of any date (weight 0.40) — `0.30 +
   0.40 = 0.70 ≥ 0.5`, so `contract_renewal` is available too.

3. Put together: **any account with `mrr_cents !== 0` has at least
   `revenue_dynamics` (org weight 35) + `contract_renewal` (org weight 30) =
   65% dimension coverage, comfortably above the 50% `insufficient`
   threshold** — so `partial` or `complete`, never `insufficient`. And any
   account with `mrr_cents === 0` gets claimed by rule 1 (`en_churn`) before
   `healthScoreStatus` is even checked (rule 3 in the priority chain, see
   above). There doesn't appear to be a path through the current logic that
   reaches `insufficient` at all.

**This means `donnees_insuffisantes` is very likely permanently empty on
every org, the same practical outcome as `en_expansion` — except this one
doesn't look intentional.** The schema, the UI segment, and the
`health_score_status` column all suggest this was meant to be reachable
(an account with real MRR but genuinely no payment/contract history — e.g.
a subscription created seconds ago, before any invoice or contract data
exists — is exactly the case this segment sounds like it should catch).

**No code changed here** — per the instruction that triggered this audit,
scoring-logic changes need explicit sign-off (also consistent with
CLAUDE.md's existing rule that scoring formulas aren't modified without
explicit instruction). Flagging for a decision:
- **If this is intentional** (maybe `revenue_dynamics`'s always-on defaults were a deliberate design choice and `insufficient` is meant to be rare/near-impossible by design), no action needed beyond this note.
- **If not**, the fix is a scoring-weight/threshold decision, not a mechanical bug fix — e.g. lowering the "available" threshold on `revenue_dynamics`'s inherently-defaulted signals, or excluding contraction/expansion-signal defaults from counting toward availability when there's zero underlying movement data, or moving the `donnees_insuffisantes` check earlier in the priority chain. Each has real tradeoffs on the existing "no renormalization" (S4) and "no data ≠ neutral data" (S1) decisions already documented in CLAUDE.md, so this needs a product decision, not a unilateral change.

**Practical consequence for the part-2 seeding script**: it isn't possible to
reliably land 50 test accounts in this segment via Stripe configuration
alone, for the same reason it isn't possible for `Expanding` — both are
excluded from that script (`scripts/seed-segment-test-data.ts`), which
targets the 6 *exclusive* segments that are actually reachable: `en_churn`,
`impayes`, `en_danger_critique`, `a_risque_leger`, `champions`, `stables`
(50 customers each, 300 total). `nouveaux` (New <90d) is deliberately **not**
a 7th dedicated cohort: it's non-exclusive and satisfied automatically by
every freshly-synced test account regardless of Stripe configuration, so a
dedicated 50-account cohort for it would just double-count against whichever
exclusive segment those same 50 accounts also land in — the same mechanism
behind the anomaly investigated above (100 accounts in `en_churn` all showing
up in `nouveaux` too). Once this script's 300 accounts are synced, `nouveaux`
is expected to show ~300 (all of them), not 50 — that's correct, not a bug.

**Two more reachability findings surfaced while building the script, resolved
by design rather than by touching scoring code:**

- **Champions requires an expansion signal**
  (`hasExpansionSignal`, scoring.ts:734-744) — an `expansion`-type
  `mrr_movements` row, or `mrr3moAgoCents` history showing growth. Both are
  generated by **`sync-stripe` comparing the account's MRR across two
  separate sync runs** (`sync-stripe/index.ts:417-450`), never from Stripe
  data alone — a subscription's first-ever sync always yields `'new'`,
  not `'expansion'`. So Champions cannot be reached in a single
  create-then-sync pass no matter how the Stripe objects are configured.
- **Critical, reached without any overdue invoice, needs a two-sync setup
  too** — the only two churn signals achievable from static Stripe data in a
  single sync (`payment_failures_90d`=25 + `monthly_young_account`=20) sum to
  45, short of the 50-point `'high'` band threshold, and adding an overdue
  invoice to close the gap would instead redirect the account to `Overdue`
  (checked earlier in the priority chain, see rule 2 above). The signal that
  *does* close the gap cleanly — `mrr_contraction_20pct_3mo`=30 — is, like
  Champions' expansion signal, only ever produced by comparing MRR across two
  `sync-stripe` runs.

Both are solved the same way, without any scoring-formula change: the script
runs in **two phases**. Phase 1 creates all 300 customers (Champions and
Critical cohorts start on a baseline price). After a first Sentio sync
establishes each account's baseline `mrr_cents`, phase 2 raises the price on
the Champions cohort's subscriptions and lowers it on the Critical cohort's
(≥20%, well past the contraction threshold) — a second sync then compares
against that baseline and generates real `expansion`/`contraction` movements,
landing both cohorts in their target segment with the full 50/segment count,
no gap left undocumented and no scoring code touched.

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

**The reported anomaly (7/9 at zero, 100/100 identical) is not a bug in the
segmentation or scoring logic.** The 7-zero / 2-hundred pattern is the
deterministic, correct consequence of (a) `Expanding` being permanently
retired in V3, and (b) all 100 test accounts sharing `mrr_cents = 0`, which
is itself fully explained by `sync-stripe` only aggregating MRR/contract
fields from `active`/`trialing` subscriptions — most likely because these
Stripe test subscriptions never left `incomplete` status. The identical `40`
health score is very plausibly a legitimate, low, uniform score computed
from identically-shaped thin test data — but confirming it isn't a
null-defaulting-to-40 frontend display bug requires the query above, which
needs live database access this environment doesn't have.

**Separately, while designing the seeding script that depends on this audit,
a genuine, likely-unintentional bug did surface**: `donnees_insuffisantes`
(Insufficient data) appears to be structurally unreachable through any
normal Stripe-synced data, for reasons unrelated to the anomaly above (see
the callout after the segment list). That one **is** worth a product
decision on whether/how to fix — flagged, not fixed, since it's a scoring-
logic change outside this audit's authorization.
