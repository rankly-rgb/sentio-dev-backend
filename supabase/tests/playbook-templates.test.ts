import { describe, it, expect } from 'vitest'
import {
  PLAYBOOK_TEMPLATES_V1,
  validatePlaybookActions,
} from '../functions/_shared/playbook-engine'

describe('PLAYBOOK_TEMPLATES_V1', () => {
  it('contient exactement 6 templates', () => {
    expect(PLAYBOOK_TEMPLATES_V1).toHaveLength(6)
  })

  it('tous les ids sont uniques', () => {
    const ids = PLAYBOOK_TEMPLATES_V1.map((t) => t.id)
    const unique = Array.from(new Map(ids.map((id) => [id, true])).keys())
    expect(unique).toHaveLength(6)
  })

  it('tous les templates ont des actions V1 valides', () => {
    for (const template of PLAYBOOK_TEMPLATES_V1) {
      expect(() => validatePlaybookActions(template.actions)).not.toThrow()
    }
  })

  it('les templates send_email ont subject et body', () => {
    for (const template of PLAYBOOK_TEMPLATES_V1) {
      for (const action of template.actions) {
        if (action.type === 'send_email') {
          expect(action.config.email_subject).toBeTruthy()
          expect(action.config.email_body_html).toBeTruthy()
        }
      }
    }
  })

  it('aucun template ne stocke de PII dans ses actions', () => {
    const configStr = JSON.stringify(PLAYBOOK_TEMPLATES_V1)
    expect(configStr).not.toMatch(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/)
  })
})
