import { describe, it, expect } from 'vitest'
import {
  getDefaultPlaybookTemplates,
  getTemplatesByCategory,
  getTemplateCategories,
  validateTemplates,
} from '../functions/_shared/playbook-seed-helpers'

// ── getDefaultPlaybookTemplates ─────────────────────────────

describe('getDefaultPlaybookTemplates', () => {
  const templates = getDefaultPlaybookTemplates()

  it('returns exactly 9 templates', () => {
    expect(templates).toHaveLength(9)
  })

  it('all templates have source=system and is_template=true', () => {
    for (const t of templates) {
      expect(t.source).toBe('system')
      expect(t.is_template).toBe(true)
    }
  })

  it('all templates have status=draft', () => {
    for (const t of templates) {
      expect(t.status).toBe('draft')
    }
  })

  it('all templates have at least one action', () => {
    for (const t of templates) {
      expect(t.actions.length).toBeGreaterThan(0)
    }
  })

  it('all templates have eligibility_criteria with at least one condition', () => {
    for (const t of templates) {
      expect(t.eligibility_criteria.operator).toBeDefined()
      expect(t.eligibility_criteria.conditions.length).toBeGreaterThan(0)
    }
  })

  it('all action orders are sequential starting from 1', () => {
    for (const t of templates) {
      const orders = t.actions.map((a) => a.order)
      for (let i = 0; i < orders.length; i++) {
        expect(orders[i]).toBe(i + 1)
      }
    }
  })

  it('all titles are unique', () => {
    const titles = templates.map((t) => t.title)
    const unique = Array.from(new Set(titles))
    expect(unique).toHaveLength(titles.length)
  })

  it('covers scoring-based eligibility criteria', () => {
    const allFields = templates.flatMap((t) =>
      t.eligibility_criteria.conditions.map((c) => c.field),
    )
    expect(allFields).toContain('churn_risk_score')
    expect(allFields).toContain('health_score')
    expect(allFields).toContain('expansion_score')
    expect(allFields).toContain('product_usage_score')
    expect(allFields).toContain('mrr_cents')
  })
})

// ── Scoring-based eligibility ───────────────────────────────

describe('scoring-based eligibility', () => {
  const templates = getDefaultPlaybookTemplates()

  it('churn prevention templates target churn_risk >= 70', () => {
    const churnTemplates = templates.filter(
      (t) => t.template_category === 'churn_prevention',
    )
    expect(churnTemplates.length).toBeGreaterThanOrEqual(2)
    for (const t of churnTemplates) {
      const churnCondition = t.eligibility_criteria.conditions.find(
        (c) => c.field === 'churn_risk_score',
      )
      if (churnCondition) {
        expect(churnCondition.operator).toBe('gte')
        expect(churnCondition.value).toBeGreaterThanOrEqual(50)
      }
    }
  })

  it('expansion templates target expansion >= 65 and health >= 55', () => {
    const expansionTemplates = templates.filter(
      (t) => t.template_category === 'expansion',
    )
    expect(expansionTemplates.length).toBeGreaterThanOrEqual(1)
    for (const t of expansionTemplates) {
      const expansionCondition = t.eligibility_criteria.conditions.find(
        (c) => c.field === 'expansion_score',
      )
      const healthCondition = t.eligibility_criteria.conditions.find(
        (c) => c.field === 'health_score',
      )
      expect(expansionCondition).toBeDefined()
      expect(healthCondition).toBeDefined()
    }
  })

  it('winback template targets churn_risk >= 90', () => {
    const winback = templates.find((t) => t.template_category === 'winback')
    expect(winback).toBeDefined()
    const condition = winback!.eligibility_criteria.conditions.find(
      (c) => c.field === 'churn_risk_score',
    )
    expect(condition).toBeDefined()
    expect(condition!.value).toBe(90)
  })

  it('reactivation template targets low usage and health', () => {
    const reactivation = templates.find((t) => t.template_category === 'reactivation')
    expect(reactivation).toBeDefined()
    const usageCondition = reactivation!.eligibility_criteria.conditions.find(
      (c) => c.field === 'product_usage_score',
    )
    expect(usageCondition).toBeDefined()
    expect(usageCondition!.operator).toBe('lte')
  })
})

// ── getTemplatesByCategory ──────────────────────────────────

describe('getTemplatesByCategory', () => {
  it('returns 3 churn_prevention templates', () => {
    expect(getTemplatesByCategory('churn_prevention')).toHaveLength(3)
  })

  it('returns 2 expansion templates', () => {
    expect(getTemplatesByCategory('expansion')).toHaveLength(2)
  })

  it('returns 1 onboarding template', () => {
    expect(getTemplatesByCategory('onboarding')).toHaveLength(1)
  })

  it('returns 1 renewal template', () => {
    expect(getTemplatesByCategory('renewal')).toHaveLength(1)
  })

  it('returns 1 winback template', () => {
    expect(getTemplatesByCategory('winback')).toHaveLength(1)
  })

  it('returns 1 reactivation template', () => {
    expect(getTemplatesByCategory('reactivation')).toHaveLength(1)
  })

  it('returns empty array for unknown category', () => {
    expect(getTemplatesByCategory('unknown')).toHaveLength(0)
  })
})

// ── getTemplateCategories ───────────────────────────────────

describe('getTemplateCategories', () => {
  it('returns 6 unique categories', () => {
    const categories = getTemplateCategories()
    expect(categories).toHaveLength(6)
    expect(categories).toContain('churn_prevention')
    expect(categories).toContain('reactivation')
    expect(categories).toContain('expansion')
    expect(categories).toContain('onboarding')
    expect(categories).toContain('renewal')
    expect(categories).toContain('winback')
  })
})

// ── validateTemplates ───────────────────────────────────────

describe('validateTemplates', () => {
  it('validates all default templates as valid', () => {
    const result = validateTemplates(getDefaultPlaybookTemplates())
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('detects missing title', () => {
    const templates = [{ ...getDefaultPlaybookTemplates()[0], title: '' }]
    const result = validateTemplates(templates)
    expect(result.valid).toBe(false)
    expect(result.errors[0]).toContain('missing title')
  })

  it('detects empty actions', () => {
    const templates = [{ ...getDefaultPlaybookTemplates()[0], actions: [] }]
    const result = validateTemplates(templates)
    expect(result.valid).toBe(false)
    expect(result.errors[0]).toContain('no actions')
  })

  it('detects non-sequential action orders', () => {
    const t = { ...getDefaultPlaybookTemplates()[0] }
    t.actions = [
      { type: 'slack_notify', order: 1, config: {} },
      { type: 'create_task', order: 3, config: {} },
    ]
    const result = validateTemplates([t])
    expect(result.valid).toBe(false)
    expect(result.errors[0]).toContain('order not sequential')
  })

  it('detects missing eligibility conditions', () => {
    const t = {
      ...getDefaultPlaybookTemplates()[0],
      eligibility_criteria: { operator: 'AND' as const, conditions: [] },
    }
    const result = validateTemplates([t])
    expect(result.valid).toBe(false)
    expect(result.errors[0]).toContain('no eligibility conditions')
  })
})
