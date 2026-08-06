import { describe, it, expect } from 'vitest'
import {
  combineWeightedSignals,
  calcPaymentHealthDimension,
  calcRevenueDynamicsDimension,
  calcContractRenewalDimension,
  calcHealthScoreV3,
  validateScoringWeights,
  calcChurnRiskV2,
  buildChurnSignals,
  countPaymentFailures90d,
  calcExpansionScoreV2,
  calcExpansionSignals,
  gateBenchmark,
  determineSegmentTypesV3,
  buildScoreBreakdown,
  computeTrend30d,
  DEFAULT_SCORING_WEIGHTS,
  type InvoiceRecord,
  type MrrMovementRecord,
  type SegmentInputV3,
} from '../functions/_shared/scoring'

// ── combineWeightedSignals (S3 intra-dimension gate) ─────────

describe('combineWeightedSignals', () => {
  it('averages weighted signals when all available', () => {
    const result = combineWeightedSignals([
      { weight: 0.5, value: 100 },
      { weight: 0.5, value: 0 },
    ])
    expect(result.status).toBe('available')
    expect(result.score).toBe(50)
  })

  it('renormalizes among available signals when some are missing but >= 50% weight present', () => {
    const result = combineWeightedSignals([
      { weight: 0.6, value: 100 },
      { weight: 0.4, value: null },
    ])
    expect(result.status).toBe('available')
    expect(result.score).toBe(100)
  })

  it('returns unavailable when less than 50% of weight is present', () => {
    const result = combineWeightedSignals([
      { weight: 0.4, value: 100 },
      { weight: 0.6, value: null },
    ])
    expect(result.status).toBe('unavailable')
    expect(result.score).toBeNull()
  })

  it('is available at exactly the 50% boundary', () => {
    const result = combineWeightedSignals([
      { weight: 0.5, value: 80 },
      { weight: 0.5, value: null },
    ])
    expect(result.status).toBe('available')
    expect(result.score).toBe(80)
  })

  it('is unavailable when every signal is null', () => {
    const result = combineWeightedSignals([{ weight: 1, value: null }])
    expect(result.status).toBe('unavailable')
  })
})

// ── payment_health dimension (S3) ─────────────────────────────

function inv(overrides: Partial<InvoiceRecord>): InvoiceRecord {
  return { status: 'paid', due_date: null, paid_at: null, invoice_date: '2026-06-01', ...overrides }
}

describe('calcPaymentHealthDimension', () => {
  const now = new Date('2026-07-25T00:00:00Z').getTime()

  it('is unavailable when there are no invoices at all (all 3 signals unavailable)', () => {
    const result = calcPaymentHealthDimension({ invoices90d: [], invoices12mo: [] }, now)
    expect(result.status).toBe('unavailable')
    expect(result.score).toBeNull()
  })

  it('scores 100 when all 90d invoices are paid on time and no overdue', () => {
    const paidOnTime = inv({ status: 'paid', due_date: '2026-06-10', paid_at: '2026-06-09T00:00:00Z' })
    const invoices90d = [paidOnTime, paidOnTime]
    const invoices12mo = [paidOnTime, paidOnTime, paidOnTime]
    const result = calcPaymentHealthDimension({ invoices90d, invoices12mo }, now)
    expect(result.status).toBe('available')
    expect(result.score).toBeGreaterThan(80)
  })

  it('penalizes an uncollectible invoice to invoice_status_score=0', () => {
    const invoices90d = [inv({ status: 'uncollectible', due_date: '2026-07-01' })]
    const result = calcPaymentHealthDimension({ invoices90d, invoices12mo: invoices90d }, now)
    // invoice_status_score(0.40)=0 dominates; dunning also penalized (uncollectible=unrecovered failure)
    expect(result.score).toBeLessThan(50)
  })

  it('payment_history_score is unavailable with fewer than 3 invoices over 12mo (dimension may still be available via other signals)', () => {
    const invoices12mo = [inv({ status: 'paid' }), inv({ status: 'paid' })]
    const invoices90d = invoices12mo
    const result = calcPaymentHealthDimension({ invoices90d, invoices12mo }, now)
    // invoice_status(0.40) + dunning(0.25) = 0.65 >= 0.5 → still available
    expect(result.status).toBe('available')
  })
})

describe('countPaymentFailures90d', () => {
  it('counts uncollectible as unrecovered failure', () => {
    const result = countPaymentFailures90d([inv({ status: 'uncollectible' })])
    expect(result.total).toBe(1)
    expect(result.unrecovered).toBe(1)
  })

  it('counts a late-paid invoice (>5 days) as a recovered failure', () => {
    const result = countPaymentFailures90d([inv({ status: 'paid', due_date: '2026-07-01', paid_at: '2026-07-10T00:00:00Z' })])
    expect(result.total).toBe(1)
    expect(result.unrecovered).toBe(0)
  })

  it('does not count an on-time paid invoice as a failure', () => {
    const result = countPaymentFailures90d([inv({ status: 'paid', due_date: '2026-07-10', paid_at: '2026-07-09T00:00:00Z' })])
    expect(result.total).toBe(0)
  })
})

// ── revenue_dynamics dimension (S3) ───────────────────────────

function mov(overrides: Partial<MrrMovementRecord>): MrrMovementRecord {
  return { movement_type: 'expansion', amount_cents: 1000, movement_date: '2026-06-01', ...overrides }
}

describe('calcRevenueDynamicsDimension', () => {
  it('mrr_trend is unavailable when there is no 3-month-ago snapshot (tenure < 3mo)', () => {
    const result = calcRevenueDynamicsDimension({ mrrCurrentCents: 10000, mrr3moAgoCents: null, movements6mo: [] })
    // mrr_trend(0.45) unavailable; contraction(0.35) + expansion(0.20) = 0.55 >= 0.5 → still available
    expect(result.status).toBe('available')
  })

  it('scores mrr_trend at 60 for flat MRR (0% change)', () => {
    const result = calcRevenueDynamicsDimension({ mrrCurrentCents: 10000, mrr3moAgoCents: 10000, movements6mo: [] })
    expect(result.score).toBeCloseTo(60 * 0.45 + 100 * 0.35 + 60 * 0.20, 0)
  })

  it('scores mrr_trend at 0 for a -20% or worse drop', () => {
    const result = calcRevenueDynamicsDimension({ mrrCurrentCents: 8000, mrr3moAgoCents: 10000, movements6mo: [] })
    // trend = -20% exactly → mrr_trend component = 0
    expect(result.score).toBeLessThan(60)
  })

  it('scores mrr_trend at 100 for +10% or better growth', () => {
    const result = calcRevenueDynamicsDimension({ mrrCurrentCents: 12000, mrr3moAgoCents: 10000, movements6mo: [] })
    expect(result.score).toBeGreaterThan(90)
  })

  it('contraction >= 10% of current MRR scores 0 on that signal', () => {
    const movements6mo = [mov({ movement_type: 'contraction', amount_cents: -2000 })]
    const result = calcRevenueDynamicsDimension({ mrrCurrentCents: 10000, mrr3moAgoCents: 10000, movements6mo })
    // contraction 20% of MRR → contraction_score=0, drags composite below flat-MRR baseline
    const flat = calcRevenueDynamicsDimension({ mrrCurrentCents: 10000, mrr3moAgoCents: 10000, movements6mo: [] })
    expect(result.score!).toBeLessThan(flat.score!)
  })

  it('absence of expansion is not penalized as strongly as absence of everything (score=60, not 0)', () => {
    const result = calcRevenueDynamicsDimension({ mrrCurrentCents: 10000, mrr3moAgoCents: 10000, movements6mo: [] })
    expect(result.score).toBeGreaterThan(0)
  })

  // Regression (audit 2026-08, Problème 3) : un compte à mrrCurrentCents=0
  // (churné via un mouvement `churn`, ou mrr_status='unavailable' par
  // exclusion de devise minoritaire) ne doit jamais scorer 100 sur
  // contraction_score — l'ancien code lisait "aucune contraction observée"
  // comme un signal positif alors que le mouvement `churn` qui a vidé le
  // MRR n'est jamais compté comme une `contraction`. mrr_trend(0.45,
  // unavailable sans historique) + contraction(0.35, désormais unavailable)
  // = 0.80 de poids indisponible → la dimension entière bascule unavailable
  // (< 50% de poids interne dispo), jamais un faux ~85/100.
  it('mrrCurrentCents=0 makes contraction_score unavailable, not a false-positive 100', () => {
    const churnedNoMovements = calcRevenueDynamicsDimension({ mrrCurrentCents: 0, mrr3moAgoCents: null, movements6mo: [] })
    expect(churnedNoMovements.status).toBe('unavailable')
    expect(churnedNoMovements.score).toBeNull()

    const churnedWithChurnMovement = calcRevenueDynamicsDimension({
      mrrCurrentCents: 0,
      mrr3moAgoCents: null,
      movements6mo: [mov({ movement_type: 'churn', amount_cents: -10000 })],
    })
    expect(churnedWithChurnMovement.status).toBe('unavailable')
    expect(churnedWithChurnMovement.score).toBeNull()

    const contractionSignal = churnedWithChurnMovement.signals.find((s) => s.code === 'contraction_score')
    expect(contractionSignal?.status).toBe('unavailable')
    expect(contractionSignal?.value).toBeNull()
  })
})

// ── contract_renewal dimension (S3) ───────────────────────────

describe('calcContractRenewalDimension', () => {
  const now = new Date('2026-07-25T00:00:00Z').getTime()

  it('is unavailable when billing_interval, contract_end_date and contract_start_date are all null', () => {
    const result = calcContractRenewalDimension({ billingInterval: null, contractEndDate: null, contractStartDate: null }, now)
    expect(result.status).toBe('unavailable')
  })

  it('monthly billing scores lower than annual on billing_interval_score', () => {
    const monthly = calcContractRenewalDimension({ billingInterval: 'monthly', contractEndDate: null, contractStartDate: '2026-01-01' }, now)
    const annual = calcContractRenewalDimension({ billingInterval: 'annual', contractEndDate: '2027-01-01', contractStartDate: '2026-01-01' }, now)
    expect(monthly.score!).toBeLessThan(annual.score!)
  })

  it('renewal_proximity is a constant 70 for monthly regardless of contract_end_date', () => {
    const withEnd = calcContractRenewalDimension({ billingInterval: 'monthly', contractEndDate: '2026-08-01', contractStartDate: '2026-01-01' }, now)
    const withoutEnd = calcContractRenewalDimension({ billingInterval: 'monthly', contractEndDate: null, contractStartDate: '2026-01-01' }, now)
    expect(withEnd.score).toBe(withoutEnd.score)
  })

  it('annual renewal within 30 days scores lower than annual renewal far away', () => {
    const soon = calcContractRenewalDimension({ billingInterval: 'annual', contractEndDate: '2026-08-10', contractStartDate: '2025-01-01' }, now)
    const far = calcContractRenewalDimension({ billingInterval: 'annual', contractEndDate: '2027-06-01', contractStartDate: '2025-01-01' }, now)
    expect(soon.score!).toBeLessThan(far.score!)
  })

  it('tenure >= 24 months scores at the ceiling', () => {
    const result = calcContractRenewalDimension({ billingInterval: 'annual', contractEndDate: '2027-01-01', contractStartDate: '2023-01-01' }, now)
    expect(result.status).toBe('available')
  })
})

// ── Health Score composite v3 (S4 — no dynamic renormalization) ──

describe('calcHealthScoreV3', () => {
  const available = (score: number) => ({ score, status: 'available' as const })
  const unavailable = { score: null, status: 'unavailable' as const }

  it('is complete (max_points=100) when all 3 dimensions are available', () => {
    const result = calcHealthScoreV3({ paymentHealth: available(80), revenueDynamics: available(80), contractRenewal: available(80) })
    expect(result.health_score_status).toBe('complete')
    expect(result.health_score_max_points).toBe(100)
    expect(result.health_score_points).toBe(80)
  })

  it('is partial when exactly one dimension is unavailable (coverage 65 or 70)', () => {
    const result = calcHealthScoreV3({ paymentHealth: unavailable, revenueDynamics: available(80), contractRenewal: available(80) })
    expect(result.health_score_status).toBe('partial')
    expect(result.health_score_max_points).toBe(65) // revenue_dynamics(35) + contract_renewal(30)
  })

  it('is insufficient (points=null) when coverage < 50', () => {
    // Only contract_renewal (30) available — below 50
    const result = calcHealthScoreV3({ paymentHealth: unavailable, revenueDynamics: unavailable, contractRenewal: available(80) })
    expect(result.health_score_status).toBe('insufficient')
    expect(result.health_score_points).toBeNull()
    expect(result.health_score_band).toBeNull()
  })

  it('never renormalizes weights between dimensions — max_points reflects the raw weight sum, not 100', () => {
    const result = calcHealthScoreV3({ paymentHealth: available(100), revenueDynamics: unavailable, contractRenewal: available(100) })
    // payment_health(35) + contract_renewal(30) = 65, points = 100 (not renormalized to look like out-of-100 at full weight)
    expect(result.health_score_max_points).toBe(65)
    expect(result.health_score_points).toBe(65) // 100*0.35 + 100*0.30
  })

  it('bands: healthy >= 70%, watch 40-69%, at_risk < 40% of max_points', () => {
    const healthy = calcHealthScoreV3({ paymentHealth: available(70), revenueDynamics: available(70), contractRenewal: available(70) })
    const watch = calcHealthScoreV3({ paymentHealth: available(50), revenueDynamics: available(50), contractRenewal: available(50) })
    const atRisk = calcHealthScoreV3({ paymentHealth: available(10), revenueDynamics: available(10), contractRenewal: available(10) })
    expect(healthy.health_score_band).toBe('healthy')
    expect(watch.health_score_band).toBe('watch')
    expect(atRisk.health_score_band).toBe('at_risk')
  })

  it('respects custom org weights (S11)', () => {
    const weights = { payment_health: 60, revenue_dynamics: 20, contract_renewal: 20 }
    const result = calcHealthScoreV3(
      { paymentHealth: available(100), revenueDynamics: available(0), contractRenewal: available(0) },
      weights,
    )
    expect(result.health_score_points).toBe(60)
  })
})

describe('validateScoringWeights', () => {
  it('accepts the default weights', () => {
    expect(validateScoringWeights(DEFAULT_SCORING_WEIGHTS)).toBe(true)
  })

  it('rejects weights that do not sum to 100', () => {
    expect(validateScoringWeights({ payment_health: 40, revenue_dynamics: 40, contract_renewal: 40 })).toBe(false)
  })

  it('rejects a weight below 10', () => {
    expect(validateScoringWeights({ payment_health: 5, revenue_dynamics: 60, contract_renewal: 35 })).toBe(false)
  })

  it('rejects a weight above 60', () => {
    expect(validateScoringWeights({ payment_health: 65, revenue_dynamics: 20, contract_renewal: 15 })).toBe(false)
  })
})

// ── Churn Risk V2 — additive, deterministic (S5) ──────────────

describe('calcChurnRiskV2 / buildChurnSignals', () => {
  it('scores 0 with no triggered signals', () => {
    const signals = buildChurnSignals({
      hasInvoiceOverdue15Plus: false,
      contractionMrr20PctPlus3mo: false,
      paymentFailures2PlusIn90d: false,
      isMonthlyAndTenureUnder6mo: false,
      annualRenewal30dPlusWithContraction6mo: false,
      hasDowngrade6mo: false,
      hasInvoiceOverdueUnder15: false,
      isDelinquent: false,
    })
    const result = calcChurnRiskV2(signals)
    expect(result.churn_risk_score).toBe(0)
    expect(result.churn_risk_band).toBe('low')
    expect(result.risk_signals_triggered).toEqual([])
  })

  it('sums points additively across triggered signals', () => {
    const signals = buildChurnSignals({
      hasInvoiceOverdue15Plus: true, // 35
      contractionMrr20PctPlus3mo: false,
      paymentFailures2PlusIn90d: true, // 25
      isMonthlyAndTenureUnder6mo: false,
      annualRenewal30dPlusWithContraction6mo: false,
      hasDowngrade6mo: false,
      hasInvoiceOverdueUnder15: false,
      isDelinquent: false,
    })
    const result = calcChurnRiskV2(signals)
    expect(result.churn_risk_score).toBe(60)
    expect(result.churn_risk_band).toBe('high')
  })

  it('caps the score at 100 even if all signals fire', () => {
    const signals = buildChurnSignals({
      hasInvoiceOverdue15Plus: true,
      contractionMrr20PctPlus3mo: true,
      paymentFailures2PlusIn90d: true,
      isMonthlyAndTenureUnder6mo: true,
      annualRenewal30dPlusWithContraction6mo: true,
      hasDowngrade6mo: true,
      hasInvoiceOverdueUnder15: true,
      isDelinquent: true, // suppressed by mutual exclusion (hasInvoiceOverdue15Plus=true) — cap still holds via the other signals
    })
    const result = calcChurnRiskV2(signals)
    expect(result.churn_risk_score).toBe(100)
  })

  it('skips (does not count as false) a signal whose data is absent — S1', () => {
    const withNull = buildChurnSignals({
      hasInvoiceOverdue15Plus: null,
      contractionMrr20PctPlus3mo: false,
      paymentFailures2PlusIn90d: false,
      isMonthlyAndTenureUnder6mo: false,
      annualRenewal30dPlusWithContraction6mo: false,
      hasDowngrade6mo: false,
      hasInvoiceOverdueUnder15: false,
      isDelinquent: false,
    })
    const result = calcChurnRiskV2(withNull)
    expect(result.risk_signals_evaluated).toBe(7) // 8 total minus the 1 null
  })

  it('never includes a confidence or probability field', () => {
    const result = calcChurnRiskV2(buildChurnSignals({
      hasInvoiceOverdue15Plus: true,
      contractionMrr20PctPlus3mo: null,
      paymentFailures2PlusIn90d: null,
      isMonthlyAndTenureUnder6mo: null,
      annualRenewal30dPlusWithContraction6mo: null,
      hasDowngrade6mo: null,
      hasInvoiceOverdueUnder15: null,
      isDelinquent: false,
    }))
    expect(result).not.toHaveProperty('confidence_score')
    expect(result).not.toHaveProperty('probability')
    expect(result.risk_signals_triggered[0]).not.toHaveProperty('confidence_score')
  })

  it('bands: 0-24 low, 25-49 watch, 50-100 high', () => {
    const build = (triggerMajeur: boolean) => buildChurnSignals({
      hasInvoiceOverdue15Plus: false, contractionMrr20PctPlus3mo: false,
      paymentFailures2PlusIn90d: triggerMajeur, // 25 pts → watch
      isMonthlyAndTenureUnder6mo: false, annualRenewal30dPlusWithContraction6mo: false,
      hasDowngrade6mo: false, hasInvoiceOverdueUnder15: false, isDelinquent: false,
    })
    expect(calcChurnRiskV2(build(false)).churn_risk_band).toBe('low')
    expect(calcChurnRiskV2(build(true)).churn_risk_score).toBe(25)
    expect(calcChurnRiskV2(build(true)).churn_risk_band).toBe('watch')
    expect(calcChurnRiskV2(buildChurnSignals({
      hasInvoiceOverdue15Plus: true, contractionMrr20PctPlus3mo: true, paymentFailures2PlusIn90d: false,
      isMonthlyAndTenureUnder6mo: false, annualRenewal30dPlusWithContraction6mo: false,
      hasDowngrade6mo: false, hasInvoiceOverdueUnder15: false, isDelinquent: false,
    })).churn_risk_band).toBe('high') // 35 + 30 = 65 pts
  })

  it('risk_signals_evaluated counts 8 signals now that payment_delinquent is always evaluable', () => {
    const signals = buildChurnSignals({
      hasInvoiceOverdue15Plus: null, contractionMrr20PctPlus3mo: null, paymentFailures2PlusIn90d: null,
      isMonthlyAndTenureUnder6mo: null, annualRenewal30dPlusWithContraction6mo: null,
      hasDowngrade6mo: null, hasInvoiceOverdueUnder15: null, isDelinquent: false,
    })
    // payment_delinquent is the only evaluable signal — never null, unlike the other 7 invoice/movement-derived ones.
    const result = calcChurnRiskV2(signals)
    expect(result.risk_signals_evaluated).toBe(1)
  })

  // ── payment_delinquent (audit 2026-08-06) — mutual exclusion with invoice_overdue_15d ──

  it('payment_delinquent triggers on isDelinquent alone, independent of invoice data (invoice signal null)', () => {
    const signals = buildChurnSignals({
      hasInvoiceOverdue15Plus: null, contractionMrr20PctPlus3mo: null, paymentFailures2PlusIn90d: null,
      isMonthlyAndTenureUnder6mo: null, annualRenewal30dPlusWithContraction6mo: null,
      hasDowngrade6mo: null, hasInvoiceOverdueUnder15: null, isDelinquent: true,
    })
    const result = calcChurnRiskV2(signals)
    expect(result.churn_risk_score).toBe(35)
    expect(result.churn_risk_band).toBe('watch')
    expect(result.risk_signals_triggered.map((s) => s.code)).toEqual(['payment_delinquent'])
  })

  it('payment_delinquent stands down once invoice_overdue_15d is confirmed true — no double count', () => {
    const signals = buildChurnSignals({
      hasInvoiceOverdue15Plus: true, contractionMrr20PctPlus3mo: false, paymentFailures2PlusIn90d: false,
      isMonthlyAndTenureUnder6mo: false, annualRenewal30dPlusWithContraction6mo: false,
      hasDowngrade6mo: false, hasInvoiceOverdueUnder15: false, isDelinquent: true,
    })
    const result = calcChurnRiskV2(signals)
    // 35 (invoice_overdue_15d) only — payment_delinquent suppressed, not +35 more.
    expect(result.churn_risk_score).toBe(35)
    expect(result.risk_signals_triggered.map((s) => s.code)).toEqual(['invoice_overdue_15d'])
  })

  it('payment_failures_90d stays fully independent and compounds with payment_delinquent (ceiling 60, not 95)', () => {
    const signals = buildChurnSignals({
      hasInvoiceOverdue15Plus: null, contractionMrr20PctPlus3mo: null, paymentFailures2PlusIn90d: true,
      isMonthlyAndTenureUnder6mo: null, annualRenewal30dPlusWithContraction6mo: null,
      hasDowngrade6mo: null, hasInvoiceOverdueUnder15: null, isDelinquent: true,
    })
    const result = calcChurnRiskV2(signals)
    expect(result.churn_risk_score).toBe(60) // 35 (payment_delinquent) + 25 (payment_failures_90d)
    expect(result.churn_risk_band).toBe('high')
  })

  it('payment_delinquent does not fire when isDelinquent is false and no invoice data exists', () => {
    const signals = buildChurnSignals({
      hasInvoiceOverdue15Plus: null, contractionMrr20PctPlus3mo: null, paymentFailures2PlusIn90d: null,
      isMonthlyAndTenureUnder6mo: null, annualRenewal30dPlusWithContraction6mo: null,
      hasDowngrade6mo: null, hasInvoiceOverdueUnder15: null, isDelinquent: false,
    })
    const result = calcChurnRiskV2(signals)
    expect(result.churn_risk_score).toBe(0)
    expect(result.churn_risk_band).toBe('low')
  })
})

// ── Expansion Score V2 — never a silent cap (S6) ──────────────

describe('calcExpansionScoreV2', () => {
  it('is unavailable with a default reason when seatUsagePct is null', () => {
    const result = calcExpansionScoreV2(null)
    expect(result.expansion_score).toBeNull()
    expect(result.expansion_score_status).toBe('unavailable')
    expect(result.expansion_unavailable_reason).toBe('seat_data_not_configured')
  })

  it('propagates a custom unavailable reason from the caller', () => {
    const result = calcExpansionScoreV2(null, 'unlimited_plan_no_ceiling')
    expect(result.expansion_unavailable_reason).toBe('unlimited_plan_no_ceiling')
  })

  it('is available and equals seatUsagePct when provided (no artificial cap)', () => {
    const result = calcExpansionScoreV2(85)
    expect(result.expansion_score).toBe(85)
    expect(result.expansion_score_status).toBe('available')
    expect(result.expansion_unavailable_reason).toBeNull()
  })

  it('clamps to [0, 100] for out-of-range input', () => {
    expect(calcExpansionScoreV2(150).expansion_score).toBe(100)
    expect(calcExpansionScoreV2(-10).expansion_score).toBe(0)
  })
})

describe('calcExpansionSignals', () => {
  it('detects an expansion movement independent of expansion_score availability', () => {
    const result = calcExpansionSignals([mov({ movement_type: 'expansion', amount_cents: 500 })], 10000, 9000)
    expect(result.has_upgrade_event).toBe(true)
    expect(result.has_expansion_mrr_event).toBe(true)
    expect(result.invoice_growth_detected).toBe(true)
  })

  it('is all-false with no movements and flat/unknown MRR history', () => {
    const result = calcExpansionSignals([], 10000, null)
    expect(result.has_upgrade_event).toBe(false)
    expect(result.invoice_growth_detected).toBe(false)
  })
})

// ── Benchmark gate (S7) ────────────────────────────────────────

describe('gateBenchmark', () => {
  it('masks the value below the minimum sample size', () => {
    const result = gateBenchmark(5, () => 42, 20)
    expect(result.value).toBeNull()
    expect(result.benchmark_status).toBe('insufficient_sample')
    expect(result.benchmark_sample_size).toBe(5)
  })

  it('computes the value at or above the minimum sample size', () => {
    const result = gateBenchmark(20, () => 42, 20)
    expect(result.value).toBe(42)
    expect(result.benchmark_status).toBe('ok')
  })
})

// ── Segmentation v3 invariant (S12) ────────────────────────────
// Chaque compte actif doit recevoir EXACTEMENT un segment de santé
// (hors 'nouveaux', non-exclusif). C'est l'invariant qui clôt l'enquête
// "zéro comptes affichés" côté backend — voir RUNBOOK.md §7.

describe('determineSegmentTypesV3 — exactly-one-health-segment invariant', () => {
  const baseInput: SegmentInputV3 = {
    healthScoreStatus: 'complete',
    healthScoreBand: 'healthy',
    churnRiskBand: 'low',
    hasExpansionSignal: false,
    mrrCents: 10000,
    hasOverdueInvoices: false,
    subscriptionCanceled: false,
    accountCreatedAt: '2020-01-01T00:00:00Z', // old enough to not be 'nouveaux'
    isDelinquent: false,
  }

  const healthSegments = ['champions', 'stables', 'a_risque_leger', 'en_danger_critique', 'impayes', 'en_churn', 'donnees_insuffisantes']

  const scenarios: Array<[string, Partial<SegmentInputV3>]> = [
    ['healthy, low churn, no expansion signal', {}],
    ['healthy, low churn, with expansion signal (champions)', { hasExpansionSignal: true }],
    ['watch churn band', { churnRiskBand: 'watch' }],
    ['high churn band', { churnRiskBand: 'high' }],
    ['overdue invoices', { hasOverdueInvoices: true }],
    // mrr=0 alone (churnRiskBand not 'churned') is the D-NEXT invoice-only/
    // usage-based case — must NOT resolve to en_churn (see bug fix below).
    ['mrr=0 without churned band (D-NEXT: invoice-only/usage-based, not churned)', { mrrCents: 0 }],
    ['subscription canceled flag alone, without churned band (superseded by churnRiskBand — D-NEXT)', { subscriptionCanceled: true }],
    ['churned band (D-NEXT source of truth for en_churn)', { churnRiskBand: 'churned' }],
    ['insufficient health data', { healthScoreStatus: 'insufficient', healthScoreBand: null }],
    ['insufficient health data + high churn (churn signals still computable — S5 decoupled)', { healthScoreStatus: 'insufficient', healthScoreBand: null, churnRiskBand: 'high' }],
    ['insufficient health data + overdue invoice', { healthScoreStatus: 'insufficient', healthScoreBand: null, hasOverdueInvoices: true }],
    ['overdue invoice + high churn (impayes wins)', { hasOverdueInvoices: true, churnRiskBand: 'high' }],
    ['overdue invoice + churned band (en_churn wins)', { churnRiskBand: 'churned', hasOverdueInvoices: true }],
    // Décision 2026-08-06 (audit délinquence, décision 2) : is_delinquent seul suffit pour impayes.
    ['delinquent, no overdue invoice', { isDelinquent: true }],
    ['delinquent + high churn (impayes wins, same as overdue invoice)', { isDelinquent: true, churnRiskBand: 'high' }],
    ['delinquent + churned band (en_churn wins)', { churnRiskBand: 'churned', isDelinquent: true }],
    ['partial health, watch churn', { healthScoreStatus: 'partial', churnRiskBand: 'watch' }],
    ['at_risk health band, low churn (no expansion signal → stables)', { healthScoreBand: 'at_risk' }],
  ]

  it.each(scenarios)('assigns exactly one health segment: %s', (_label, overrides) => {
    const segments = determineSegmentTypesV3({ ...baseInput, ...overrides })
    const health = segments.filter((s) => healthSegments.includes(s))
    expect(health).toHaveLength(1)
  })

  it('never assigns donnees_insuffisantes alongside another health segment', () => {
    for (const [, overrides] of scenarios) {
      const segments = determineSegmentTypesV3({ ...baseInput, ...overrides })
      if (segments.includes('donnees_insuffisantes' as never)) {
        const health = segments.filter((s) => healthSegments.includes(s))
        expect(health).toEqual(['donnees_insuffisantes'])
      }
    }
  })

  it('never assigns the retired en_expansion segment type', () => {
    for (const [, overrides] of scenarios) {
      const segments = determineSegmentTypesV3({ ...baseInput, ...overrides })
      expect(segments).not.toContain('en_expansion')
    }
  })

  it('nouveaux is additive and does not replace the health segment', () => {
    const segments = determineSegmentTypesV3({ ...baseInput, accountCreatedAt: new Date().toISOString() })
    expect(segments).toContain('nouveaux')
    const health = segments.filter((s) => healthSegments.includes(s))
    expect(health).toHaveLength(1)
  })

  // ── en_churn gated on churnRiskBand, not mrrCents (D-NEXT) ──────────
  // Bug found in the 2026-08-04 adversarial self-review of D-NEXT's isChurned
  // consumers (IMPLEMENTATION_LOG.md): this function still assigned en_churn
  // on `mrrCents === 0 || subscriptionCanceled` (the old D1 predicate),
  // independently of `churnRiskBand`, even though churnRiskBand is already
  // the D-NEXT-reconciled value (isAccountChurned()) passed in by
  // calculate-scores/index.ts for this exact purpose.
  it('REGRESSION: mrr_cents=0 alone (invoice-only/usage-based, not churned) no longer assigns en_churn', () => {
    const segments = determineSegmentTypesV3({ ...baseInput, mrrCents: 0, churnRiskBand: 'low' })
    expect(segments).not.toContain('en_churn')
  })

  it('REGRESSION: subscriptionCanceled=true alone (churnRiskBand not churned) no longer assigns en_churn', () => {
    const segments = determineSegmentTypesV3({ ...baseInput, subscriptionCanceled: true, churnRiskBand: 'low' })
    expect(segments).not.toContain('en_churn')
  })

  // ── impayes widened to is_delinquent (audit 2026-08-06, decision 2) ────
  // A delinquent account IS an unpaid account — invoice-confirmed or
  // subscription-status-reported is an implementation detail, not something
  // the user should see reflected as two different segments. impayes
  // outranks en_danger_critique/a_risque_leger in priority (already true for
  // hasOverdueInvoices, unchanged) — a delinquent account that would
  // otherwise land in en_danger_critique/a_risque_leger now resolves to
  // impayes instead, deliberately (more actionable label).
  it('is_delinquent alone (no overdue invoice) resolves to impayes', () => {
    const segments = determineSegmentTypesV3({ ...baseInput, isDelinquent: true })
    expect(segments).toContain('impayes')
    expect(segments).not.toContain('en_danger_critique')
    expect(segments).not.toContain('a_risque_leger')
  })

  it('is_delinquent outranks en_danger_critique (high churn band) — impayes wins, same as an overdue invoice', () => {
    const segments = determineSegmentTypesV3({ ...baseInput, isDelinquent: true, churnRiskBand: 'high' })
    expect(segments).toContain('impayes')
    expect(segments).not.toContain('en_danger_critique')
  })

  it('is_delinquent outranks a_risque_leger (watch churn band) — impayes wins', () => {
    const segments = determineSegmentTypesV3({ ...baseInput, isDelinquent: true, churnRiskBand: 'watch' })
    expect(segments).toContain('impayes')
    expect(segments).not.toContain('a_risque_leger')
  })

  it('churnRiskBand=churned still outranks is_delinquent (en_churn wins, D1 intact)', () => {
    const segments = determineSegmentTypesV3({ ...baseInput, isDelinquent: true, churnRiskBand: 'churned' })
    expect(segments).toContain('en_churn')
    expect(segments).not.toContain('impayes')
  })

  it('churnRiskBand=churned assigns en_churn regardless of mrrCents/subscriptionCanceled', () => {
    const segments = determineSegmentTypesV3({ ...baseInput, churnRiskBand: 'churned', mrrCents: 50000, subscriptionCanceled: false })
    expect(segments).toContain('en_churn')
  })
})

// ── score_breakdown (S8 — explicabilité) ────────────────────────

describe('buildScoreBreakdown', () => {
  const now = new Date('2026-07-25T00:00:00Z').getTime()

  it('exposes score, status, weight and per-signal detail for every dimension', () => {
    const paymentHealth = calcPaymentHealthDimension({ invoices90d: [], invoices12mo: [] }, now)
    const revenueDynamics = calcRevenueDynamicsDimension({ mrrCurrentCents: 10000, mrr3moAgoCents: 10000, movements6mo: [] })
    const contractRenewal = calcContractRenewalDimension({ billingInterval: 'annual', contractEndDate: '2027-01-01', contractStartDate: '2025-01-01' }, now)

    const breakdown = buildScoreBreakdown({ paymentHealth, revenueDynamics, contractRenewal })

    expect(breakdown.payment_health.status).toBe('unavailable')
    expect(breakdown.payment_health.weight).toBe(DEFAULT_SCORING_WEIGHTS.payment_health)
    expect(breakdown.payment_health.signals).toHaveLength(3)
    expect(breakdown.payment_health.signals[0]).toMatchObject({ code: 'invoice_status_score', status: 'unavailable', value: null })

    expect(breakdown.revenue_dynamics.status).toBe('available')
    expect(breakdown.revenue_dynamics.signals.some((s) => s.code === 'mrr_trend_score')).toBe(true)

    expect(breakdown.contract_renewal.status).toBe('available')
    expect(breakdown.contract_renewal.signals.map((s) => s.code)).toEqual(
      expect.arrayContaining(['billing_interval_score', 'renewal_proximity_score', 'tenure_score']),
    )
  })

  it('respects custom org weights in the weight field', () => {
    const paymentHealth = calcPaymentHealthDimension({ invoices90d: [], invoices12mo: [] }, now)
    const revenueDynamics = calcRevenueDynamicsDimension({ mrrCurrentCents: 10000, mrr3moAgoCents: 10000, movements6mo: [] })
    const contractRenewal = calcContractRenewalDimension({ billingInterval: 'monthly', contractEndDate: null, contractStartDate: '2025-01-01' }, now)
    const weights = { payment_health: 60, revenue_dynamics: 20, contract_renewal: 20 }

    const breakdown = buildScoreBreakdown({ paymentHealth, revenueDynamics, contractRenewal }, weights)
    expect(breakdown.payment_health.weight).toBe(60)
  })
})

describe('computeTrend30d', () => {
  it('is flat when either endpoint is null (no fabricated delta — S1)', () => {
    expect(computeTrend30d(null, 70)).toBe('flat')
    expect(computeTrend30d(70, null)).toBe('flat')
    expect(computeTrend30d(null, null)).toBe('flat')
  })

  it('is up when the delta is >= +5 points', () => {
    expect(computeTrend30d(75, 70)).toBe('up')
    expect(computeTrend30d(80, 70)).toBe('up')
  })

  it('is down when the delta is <= -5 points', () => {
    expect(computeTrend30d(65, 70)).toBe('down')
  })

  it('is flat for small moves under the +-5 threshold', () => {
    expect(computeTrend30d(72, 70)).toBe('flat')
    expect(computeTrend30d(68, 70)).toBe('flat')
  })
})
