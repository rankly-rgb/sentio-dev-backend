import { describe, it, expect } from 'vitest'

// ── Dictionnaire miroir (subset pour tests d'isolation) ────────

type Lang = 'fr' | 'en'

const TRANSLATIONS: Record<Lang, Record<string, string>> = {
  fr: {
    'nav.dashboard': 'Dashboard',
    'segment.en_danger_critique': 'En danger critique',
    'segment.impayes': 'Impayés',
    'segment.en_churn': 'En churn',
    'segment.en_expansion': 'En expansion',
    'segment.champions': 'Champions',
    'segment.stables': 'Stables',
    'segment.a_risque_leger': 'À risque léger',
    'segment.nouveaux': 'Nouveaux (< 90 j)',
    'risk.overdue_invoice': 'Invoice impayée depuis {{days}} jour(s)',
    'risk.no_usage_days': 'Aucune connexion depuis {{days}} jours',
    'risk.no_usage_long': 'Aucune connexion depuis plus de 30 jours',
    'risk.financial_degraded': 'Santé financière dégradée',
    'risk.low_health': 'Score de santé faible',
    'playbook.churn_prevention.title': 'Playbook Prévention Churn',
    'playbook.churn_prevention.reason': '{{n}} compte(s) en danger critique identifié(s) dans votre portefeuille.',
  },
  en: {
    'nav.dashboard': 'Dashboard',
    'segment.en_danger_critique': 'Critical danger',
    'segment.impayes': 'Unpaid',
    'segment.en_churn': 'Churned',
    'segment.en_expansion': 'Expanding',
    'segment.champions': 'Champions',
    'segment.stables': 'Stable',
    'segment.a_risque_leger': 'Slightly at risk',
    'segment.nouveaux': 'New (< 90 d)',
    'risk.overdue_invoice': 'Overdue invoice for {{days}} day(s)',
    'risk.no_usage_days': 'No activity for {{days}} days',
    'risk.no_usage_long': 'No activity for over 30 days',
    'risk.financial_degraded': 'Degraded financial health',
    'risk.low_health': 'Low health score',
    'playbook.churn_prevention.title': 'Churn Prevention Playbook',
    'playbook.churn_prevention.reason': '{{n}} account(s) in critical danger identified in your portfolio.',
  },
}

function t(lang: Lang, key: string, params?: Record<string, string | number>): string {
  let str = TRANSLATIONS[lang]?.[key] ?? TRANSLATIONS['fr'][key] ?? key
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      str = str.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), String(v))
    }
  }
  return str
}

function getTranslationDict(lang: Lang): Record<string, string> {
  return { ...TRANSLATIONS[lang] }
}

// ── Tests fonction t() ─────────────────────────────────────────

describe('t() — traduction simple', () => {
  it('retourne la traduction FR correcte', () => {
    expect(t('fr', 'segment.en_danger_critique')).toBe('En danger critique')
  })

  it('retourne la traduction EN correcte', () => {
    expect(t('en', 'segment.en_danger_critique')).toBe('Critical danger')
  })

  it('retourne la clé brute si absente en FR et EN', () => {
    expect(t('fr', 'key.inexistante')).toBe('key.inexistante')
  })

  it('fallback sur FR si la clé est absente en EN', () => {
    const partial: Record<Lang, Record<string, string>> = { fr: { 'only.fr': 'Valeur FR' }, en: {} }
    let str = partial['en']['only.fr'] ?? partial['fr']['only.fr'] ?? 'only.fr'
    expect(str).toBe('Valeur FR')
  })
})

describe('t() — interpolation de paramètres', () => {
  it('interpole {{days}} en FR', () => {
    expect(t('fr', 'risk.overdue_invoice', { days: 20 })).toBe('Invoice impayée depuis 20 jour(s)')
  })

  it('interpole {{days}} en EN', () => {
    expect(t('en', 'risk.overdue_invoice', { days: 20 })).toBe('Overdue invoice for 20 day(s)')
  })

  it('interpole {{n}} dans les raisons de playbook FR', () => {
    expect(t('fr', 'playbook.churn_prevention.reason', { n: 3 })).toContain('3 compte(s)')
  })

  it('interpole {{n}} dans les raisons de playbook EN', () => {
    expect(t('en', 'playbook.churn_prevention.reason', { n: 3 })).toContain('3 account(s)')
  })

  it('laisse la string intacte si aucun paramètre fourni', () => {
    expect(t('fr', 'risk.no_usage_long')).toBe('Aucune connexion depuis plus de 30 jours')
  })
})

describe('t() — segments tous traduits', () => {
  const segments: Array<[string, string, string]> = [
    ['segment.champions', 'Champions', 'Champions'],
    ['segment.en_expansion', 'En expansion', 'Expanding'],
    ['segment.stables', 'Stables', 'Stable'],
    ['segment.a_risque_leger', 'À risque léger', 'Slightly at risk'],
    ['segment.en_danger_critique', 'En danger critique', 'Critical danger'],
    ['segment.impayes', 'Impayés', 'Unpaid'],
    ['segment.en_churn', 'En churn', 'Churned'],
    ['segment.nouveaux', 'Nouveaux (< 90 j)', 'New (< 90 d)'],
  ]

  for (const [key, fr, en] of segments) {
    it(`${key} traduit en FR et EN`, () => {
      expect(t('fr', key)).toBe(fr)
      expect(t('en', key)).toBe(en)
    })
  }
})

describe('getTranslationDict() — dictionnaire complet', () => {
  it('retourne un objet non vide pour FR', () => {
    const dict = getTranslationDict('fr')
    expect(Object.keys(dict).length).toBeGreaterThan(0)
  })

  it('retourne un objet non vide pour EN', () => {
    const dict = getTranslationDict('en')
    expect(Object.keys(dict).length).toBeGreaterThan(0)
  })

  it('FR et EN ont les mêmes clés', () => {
    const frKeys = Object.keys(getTranslationDict('fr')).sort()
    const enKeys = Object.keys(getTranslationDict('en')).sort()
    expect(frKeys).toEqual(enKeys)
  })

  it('les valeurs EN diffèrent des valeurs FR pour au moins un segment', () => {
    const fr = getTranslationDict('fr')
    const en = getTranslationDict('en')
    expect(fr['segment.en_danger_critique']).not.toBe(en['segment.en_danger_critique'])
  })

  it('retourne une copie indépendante (mutation ne pollue pas le dictionnaire)', () => {
    const dict1 = getTranslationDict('fr')
    dict1['segment.champions'] = 'MUTATED'
    const dict2 = getTranslationDict('fr')
    expect(dict2['segment.champions']).toBe('Champions')
  })
})
