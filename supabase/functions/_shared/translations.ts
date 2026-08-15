// ============================================================
// Dictionnaire FR/EN centralisé — Sentio AI
// Utilisé par : org-settings (GET), onboarding-first-win,
//               playbooks-suggested
// ============================================================

export type Lang = 'fr' | 'en'

const TRANSLATIONS: Record<Lang, Record<string, string>> = {
  fr: {
    // ── Navigation ──────────────────────────────────────────
    'nav.dashboard': 'Dashboard',
    'nav.accounts': 'Comptes',
    'nav.playbooks': 'Playbooks',
    'nav.insights': 'Insights',
    'nav.settings': 'Paramètres',
    'nav.sign_out': 'Se déconnecter',

    // ── Auth ────────────────────────────────────────────────
    'auth.sign_in': 'Se connecter',
    'auth.signing_in': 'Connexion en cours...',
    'auth.email': 'Adresse email',
    'auth.email_placeholder': 'vous@entreprise.com',
    'auth.password': 'Mot de passe',
    'auth.password_placeholder': 'Votre mot de passe',
    'auth.welcome': 'Connectez-vous à votre espace',

    // ── Dashboard ────────────────────────────────────────────
    'dashboard.title': 'Dashboard',
    'dashboard.subtitle': "Vue d'ensemble de votre base client",
    'dashboard.kpi.active_accounts': 'Comptes actifs',
    'dashboard.kpi.active_accounts_desc': 'Total des comptes suivis',
    'dashboard.kpi.mrr': 'MRR Total',
    'dashboard.kpi.mrr_desc': 'Revenus récurrents mensuels',
    'dashboard.kpi.health_score': 'Health Score moyen',
    'dashboard.kpi.health_score_desc': 'Score de santé moyen',
    'dashboard.kpi.at_risk': 'Comptes à risque',
    'dashboard.kpi.at_risk_desc': 'Churn risk ≥ 70 %',
    'dashboard.syncs.title': 'Synchronisations récentes',
    'dashboard.syncs.loading': 'Chargement des synchronisations...',
    'dashboard.syncs.empty': 'Aucune synchronisation effectuée. Lancez votre premier sync Stripe.',
    'dashboard.syncs.error': 'Impossible de charger les synchronisations.',
    'dashboard.no_org': 'Aucune organisation associée à ce compte.',

    // ── Boutons / Actions ────────────────────────────────────
    'action.refresh': 'Actualiser les données',
    'action.refreshing': 'Synchronisation...',
    'action.retry': 'Réessayer',
    'action.reload': 'Recharger',
    'action.go_to_dashboard': 'Accéder au dashboard',

    // ── Errors ───────────────────────────────────────────────
    'error.generic': 'Une erreur est survenue',
    'error.generic_desc': 'Veuillez réessayer ou contacter le support si le problème persiste.',
    'error.critical': 'Erreur critique',
    'error.critical_desc': "L'application a rencontré un problème inattendu.",
    'error.dashboard': 'Impossible de charger le dashboard',
    'error.dashboard_desc': 'Une erreur est survenue lors du chargement des données.',
    'error.ref': 'Référence : {{digest}}',
    'error.sync_failed': 'Échec de la synchronisation',
    'error.sync_timeout': "Délai d'attente dépassé",
    'error.network': 'Erreur réseau',
    'error.invalid_response': 'Réponse invalide du serveur',
    'sync.launched': 'Synchronisation lancée',

    // ── Segments ─────────────────────────────────────────────
    'segment.champions': 'Champions',
    'segment.en_expansion': 'En expansion',
    'segment.stables': 'Stables',
    'segment.a_risque_leger': 'À risque léger',
    'segment.en_danger_critique': 'En danger critique',
    'segment.impayes': 'Impayés',
    'segment.en_churn': 'En churn',
    'segment.nouveaux': 'Nouveaux (< 90 j)',

    // ── Risk reasons (onboarding-first-win) ──────────────────
    'risk.overdue_invoice': 'Invoice impayée depuis {{days}} jour(s)',
    'risk.no_usage_days': 'Aucune connexion depuis {{days}} jours',
    'risk.no_usage_long': 'Aucune connexion depuis plus de 30 jours',
    'risk.financial_degraded': 'Santé financière dégradée',
    'risk.low_health': 'Score de santé faible',

    // ── Playbook suggestions ──────────────────────────────────
    'playbook.churn_prevention.title': 'Playbook Prévention Churn',
    'playbook.churn_prevention.reason': "{{n}} compte(s) en danger critique identifié(s) dans votre portefeuille.",
    'playbook.payment_recovery.title': 'Playbook Recouvrement Paiements',
    'playbook.payment_recovery.reason': "{{n}} compte(s) avec des impayés en attente de résolution.",
    'playbook.winback.title': 'Playbook Winback',
    'playbook.winback.reason': "{{n}} compte(s) en churn (MRR = 0) — tentative de réactivation possible.",
    'playbook.expansion.title': 'Playbook Expansion',
    'playbook.expansion.reason': "{{n}} compte(s) à fort potentiel d'expansion identifiés.",
    'playbook.health_monitoring.title': 'Playbook Suivi Santé',
    'playbook.health_monitoring.reason': "{{n}} comptes présentent des signaux de risque léger — suivi proactif recommandé.",
    'playbook.renewal.title': 'Playbook Gestion Renouvellements',
    'playbook.renewal.reason': "{{n}} alerte(s) de renouvellement actives dans votre portefeuille.",

    // ── Onboarding ───────────────────────────────────────────
    'onboarding.step.stripe': 'Connecter Stripe',
    'onboarding.step.hubspot': 'Connecter HubSpot',
    'onboarding.step.first_win': 'Voir vos premiers insights',
    'onboarding.step.done': 'Onboarding terminé',
    'onboarding.skip': 'Passer cette étape',
    'onboarding.complete': "Terminer l'onboarding",

    // ── Settings ─────────────────────────────────────────────
    'settings.language': 'Langue',
    'settings.language.fr': 'Français',
    'settings.language.en': 'English',
    'settings.saved': 'Paramètres sauvegardés',
  },

  en: {
    // ── Navigation ──────────────────────────────────────────
    'nav.dashboard': 'Dashboard',
    'nav.accounts': 'Accounts',
    'nav.playbooks': 'Playbooks',
    'nav.insights': 'Insights',
    'nav.settings': 'Settings',
    'nav.sign_out': 'Sign out',

    // ── Auth ────────────────────────────────────────────────
    'auth.sign_in': 'Sign in',
    'auth.signing_in': 'Signing in...',
    'auth.email': 'Email address',
    'auth.email_placeholder': 'you@company.com',
    'auth.password': 'Password',
    'auth.password_placeholder': 'Your password',
    'auth.welcome': 'Sign in to your workspace',

    // ── Dashboard ────────────────────────────────────────────
    'dashboard.title': 'Dashboard',
    'dashboard.subtitle': 'Overview of your customer base',
    'dashboard.kpi.active_accounts': 'Active accounts',
    'dashboard.kpi.active_accounts_desc': 'Total tracked accounts',
    'dashboard.kpi.mrr': 'Total MRR',
    'dashboard.kpi.mrr_desc': 'Monthly recurring revenue',
    'dashboard.kpi.health_score': 'Avg Health Score',
    'dashboard.kpi.health_score_desc': 'Average health score',
    'dashboard.kpi.at_risk': 'At-risk accounts',
    'dashboard.kpi.at_risk_desc': 'Churn risk ≥ 70 %',
    'dashboard.syncs.title': 'Recent syncs',
    'dashboard.syncs.loading': 'Loading syncs...',
    'dashboard.syncs.empty': 'No sync yet. Trigger your first Stripe sync.',
    'dashboard.syncs.error': 'Could not load syncs.',
    'dashboard.no_org': 'No organization linked to this account.',

    // ── Boutons / Actions ────────────────────────────────────
    'action.refresh': 'Refresh data',
    'action.refreshing': 'Syncing...',
    'action.retry': 'Retry',
    'action.reload': 'Reload',
    'action.go_to_dashboard': 'Go to dashboard',

    // ── Errors ───────────────────────────────────────────────
    'error.generic': 'Something went wrong',
    'error.generic_desc': 'Please try again or contact support if the issue persists.',
    'error.critical': 'Critical error',
    'error.critical_desc': 'The application encountered an unexpected problem.',
    'error.dashboard': 'Failed to load dashboard',
    'error.dashboard_desc': 'An error occurred while loading your data.',
    'error.ref': 'Reference: {{digest}}',
    'error.sync_failed': 'Sync failed',
    'error.sync_timeout': 'Request timed out',
    'error.network': 'Network error',
    'error.invalid_response': 'Invalid server response',
    'sync.launched': 'Sync started',

    // ── Segments ─────────────────────────────────────────────
    'segment.champions': 'Champions',
    'segment.en_expansion': 'Expanding',
    'segment.stables': 'Stable',
    'segment.a_risque_leger': 'Slightly at risk',
    'segment.en_danger_critique': 'Critical danger',
    'segment.impayes': 'Unpaid',
    'segment.en_churn': 'Churned',
    'segment.nouveaux': 'New (< 90 d)',

    // ── Risk reasons (onboarding-first-win) ──────────────────
    'risk.overdue_invoice': 'Overdue invoice for {{days}} day(s)',
    'risk.no_usage_days': 'No activity for {{days}} days',
    'risk.no_usage_long': 'No activity for over 30 days',
    'risk.financial_degraded': 'Degraded financial health',
    'risk.low_health': 'Low health score',

    // ── Playbook suggestions ──────────────────────────────────
    'playbook.churn_prevention.title': 'Churn Prevention Playbook',
    'playbook.churn_prevention.reason': '{{n}} account(s) in critical danger identified in your portfolio.',
    'playbook.payment_recovery.title': 'Payment Recovery Playbook',
    'playbook.payment_recovery.reason': '{{n}} account(s) with outstanding payments pending resolution.',
    'playbook.winback.title': 'Winback Playbook',
    'playbook.winback.reason': '{{n}} churned account(s) (MRR = 0) — reactivation attempt possible.',
    'playbook.expansion.title': 'Expansion Playbook',
    'playbook.expansion.reason': '{{n}} account(s) with high expansion potential identified.',
    'playbook.health_monitoring.title': 'Health Monitoring Playbook',
    'playbook.health_monitoring.reason': '{{n}} accounts show mild risk signals — proactive follow-up recommended.',
    'playbook.renewal.title': 'Renewal Management Playbook',
    'playbook.renewal.reason': '{{n}} active renewal alert(s) in your portfolio.',

    // ── Onboarding ───────────────────────────────────────────
    'onboarding.step.stripe': 'Connect Stripe',
    'onboarding.step.hubspot': 'Connect HubSpot',
    'onboarding.step.first_win': 'See your first insights',
    'onboarding.step.done': 'Onboarding complete',
    'onboarding.skip': 'Skip this step',
    'onboarding.complete': 'Complete onboarding',

    // ── Settings ─────────────────────────────────────────────
    'settings.language': 'Language',
    'settings.language.fr': 'Français',
    'settings.language.en': 'English',
    'settings.saved': 'Settings saved',
  },
}

/**
 * Retourne la traduction pour une clé dans la langue donnée.
 * Fallback : clé FR → clé brute.
 * Interpole les paramètres {{param}}.
 */
export function t(lang: Lang, key: string, params?: Record<string, string | number>): string {
  let str = TRANSLATIONS[lang]?.[key] ?? TRANSLATIONS['fr'][key] ?? key
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      str = str.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), String(v))
    }
  }
  return str
}

/**
 * Retourne le dictionnaire complet pour une langue.
 * Utilisé par org-settings pour hydrater le frontend en une requête.
 */
export function getTranslationDict(lang: Lang): Record<string, string> {
  return { ...TRANSLATIONS[lang] }
}
