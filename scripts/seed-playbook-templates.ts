/**
 * Seed for the 15 anti-churn playbook workflow templates for Sentio AI.
 *
 * Usage:
 *   npx tsx scripts/seed-playbook-templates.ts <organization_id>
 *
 * Archives old templates then inserts 15 new workflows.
 */

import 'dotenv/config'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!
const ORG_ID = process.env.SEED_ORG_ID || process.argv[2]

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}
if (!ORG_ID) {
  console.error('Usage: npx tsx scripts/seed-playbook-templates.ts <organization_id>')
  process.exit(1)
}

// Helper : wrap email content in consistent layout
function emailHtml(body: string): string {
  return '<div style="font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#1e293b;">' + body + '<p style="margin-top:24px;color:#64748b;font-size:13px;">— Sentio AI | {{org.name}}</p></div>'
}

interface WorkflowTemplate {
  organization_id: string
  title: string
  title_en: string
  description: string
  description_en: string
  playbook_type: string
  template_category: string
  priority: string
  is_template: boolean
  is_workflow: boolean
  status: string
  actions: unknown[]
  steps: Array<{
    step_order: number
    delay_days: number
    action_type: string
    title: string
    config: Record<string, unknown>
  }>
  eligibility_criteria: {
    operator: string
    conditions: Array<{ field: string; operator: string; value: unknown }>
  }
}

const templates: WorkflowTemplate[] = [
  // ── 1. CRITICAL CHURN ALERT ──────────────────────────────
  {
    organization_id: ORG_ID,
    title: 'Critical Churn Alert',
    title_en: 'Critical Churn Alert',
    description: 'Immediate escalation to save accounts in critical danger. 4 steps over 10 days.',
    description_en: 'Immediate escalation to save accounts in critical danger. 4 steps over 10 days.',
    playbook_type: 'semi_automated',
    template_category: 'churn_prevention',
    priority: 'critical',
    is_template: true,
    is_workflow: true,
    status: 'draft',
    actions: [],
    steps: [
      {
        step_order: 1, delay_days: 0, action_type: 'send_email',
        title: 'Day 0: Urgent CSM status update',
        config: {
          email_subject: '[URGENT] Critical churn risk — Account {{account.id}}',
          email_body_html: emailHtml('<h2 style="color:#dc2626;">Critical Churn Alert</h2><p>Hello {{csm.name}},</p><p>Account <strong>{{account.id}}</strong> is showing signs of critical churn:</p><ul><li>Health Score: <strong>{{account.health_score}}/100</strong></li><li>Churn Risk: <strong>{{account.churn_risk_score}}/100</strong></li><li>MRR: <strong>{{account.mrr_eur}} USD/month</strong></li><li>Plan: {{account.plan_tier}}</li></ul><p>Action required: contact the customer within 24h to understand the situation and propose a retention plan.</p><p style="margin-top:16px;"><a href="#" style="background:#dc2626;color:white;padding:10px 20px;border-radius:6px;text-decoration:none;">View account in Sentio</a></p>'),
          email_from_name: 'Sentio AI Alerts',
        },
      },
      {
        step_order: 2, delay_days: 2, action_type: 'send_email',
        title: 'Day 2: Follow-up — No response',
        config: {
          email_subject: '[FOLLOW-UP] Critical churn — Account {{account.id}}',
          email_body_html: emailHtml('<h2 style="color:#dc2626;">Follow-up — No action detected</h2><p>{{csm.name}},</p><p>Account {{account.id}} is still in critical danger (Health: {{account.health_score}}, Churn Risk: {{account.churn_risk_score}}).</p><p>No action has been logged since the initial alert. Please:</p><ol><li>Call the customer</li><li>Offer a free Health Check</li><li>Update the status in Sentio</li></ol>'),
          email_from_name: 'Sentio AI Alerts',
        },
      },
      {
        step_order: 3, delay_days: 5, action_type: 'send_email',
        title: 'Day 5: VP Customer Success escalation',
        config: {
          email_subject: '[VP ESCALATION] Critical account — {{account.id}} ({{account.mrr_eur}} USD MRR)',
          email_body_html: emailHtml('<h2 style="color:#dc2626;">VP Escalation — Strategic account at risk</h2><p>This account requires executive intervention:</p><table style="width:100%;border-collapse:collapse;margin:16px 0;"><tr style="border-bottom:1px solid #e2e8f0;"><td style="padding:8px;font-weight:bold;">Health Score</td><td style="padding:8px;">{{account.health_score}}/100</td></tr><tr style="border-bottom:1px solid #e2e8f0;"><td style="padding:8px;font-weight:bold;">Churn Risk</td><td style="padding:8px;">{{account.churn_risk_score}}/100</td></tr><tr style="border-bottom:1px solid #e2e8f0;"><td style="padding:8px;font-weight:bold;">MRR</td><td style="padding:8px;">{{account.mrr_eur}} USD</td></tr><tr><td style="padding:8px;font-weight:bold;">Plan</td><td style="padding:8px;">{{account.plan_tier}}</td></tr></table><p>Propose: complimentary personalized training session + Health Check with a product expert.</p>'),
          email_from_name: 'Sentio AI — VP CS',
        },
      },
      {
        step_order: 4, delay_days: 10, action_type: 'send_email',
        title: 'Day 10: Final intervention',
        config: {
          email_subject: '[LAST CHANCE] Rescue plan — {{account.id}}',
          email_body_html: emailHtml('<h2>Final intervention — Rescue plan</h2><p>{{csm.name}},</p><p>Account {{account.id}} ({{account.mrr_eur}} USD MRR) has not been saved despite follow-ups.</p><p><strong>Final options:</strong></p><ul><li>CEO call if account > 10K USD MRR</li><li>Custom rescue plan proposal</li><li>Billing pause option (1 month)</li></ul><p>Please document the final outcome in Sentio.</p>'),
          email_from_name: 'Sentio AI',
        },
      },
    ],
    eligibility_criteria: {
      operator: 'OR',
      conditions: [
        { field: 'churn_risk_score', operator: 'gte', value: 80 },
        { field: 'health_score', operator: 'lte', value: 25 },
      ],
    },
  },

  // ── 2. FAST-TRACK ONBOARDING ────────────────────────────
  {
    organization_id: ORG_ID,
    title: 'Fast-track Onboarding',
    title_en: 'Fast-track Onboarding',
    description: 'Guides new accounts (< 90 days) to First Value within 14 days. 6 steps over 60 days.',
    description_en: 'Guides new accounts (< 90 days) to First Value within 14 days. 6 steps over 60 days.',
    playbook_type: 'automated',
    template_category: 'onboarding',
    priority: 'critical',
    is_template: true,
    is_workflow: true,
    status: 'draft',
    actions: [],
    steps: [
      {
        step_order: 1, delay_days: 0, action_type: 'send_email',
        title: 'Day 1: Welcome email',
        config: {
          email_subject: 'Welcome to {{org.name}} — Your 3-step launch plan',
          email_body_html: emailHtml('<h2 style="color:#4f46e5;">Welcome! 🎉</h2><p>Hello,</p><p>We\'re thrilled to welcome this new customer aboard!</p><p>To get off to a great start, here are the 3 critical steps:</p><div style="background:#f8fafc;border-radius:8px;padding:16px;margin:16px 0;"><p>✅ <strong>Step 1</strong>: Invite the team (2 min)</p><p>✅ <strong>Step 2</strong>: Connect Stripe/HubSpot data (5 min)</p><p>✅ <strong>Step 3</strong>: Create the first dashboard (3 min)</p></div><p><strong>Goal: first insights within 48h!</strong></p><p>The assigned CSM is {{csm.name}} ({{csm.email}}).</p>'),
          email_from_name: 'Sentio AI Onboarding',
        },
      },
      {
        step_order: 2, delay_days: 3, action_type: 'send_email',
        title: 'Day 3: Step reminder + video tutorial',
        config: {
          email_subject: 'Reminder: complete your {{org.name}} setup',
          email_body_html: emailHtml('<h2>Need help getting started?</h2><p>{{csm.name}}, the new account has not yet completed all onboarding steps.</p><p>Suggestion: send a reminder with a video tutorial (< 2 min) and offer a guided video setup session.</p><p>Current usage score: <strong>{{account.product_usage_score}}/100</strong></p>'),
          email_from_name: 'Sentio AI',
        },
      },
      {
        step_order: 3, delay_days: 7, action_type: 'send_email',
        title: 'Day 7: Quick Win — Most-used feature',
        config: {
          email_subject: 'Quick Win: get your first insight in 5 minutes',
          email_body_html: emailHtml('<h2>A Quick Win to get started</h2><p>Here is the feature most used by similar accounts. Offer a pre-filled template for their specific use case.</p><p>Current Health Score: <strong>{{account.health_score}}/100</strong></p><p>Usage Score: <strong>{{account.product_usage_score}}/100</strong></p>'),
          email_from_name: 'Sentio AI',
        },
      },
      {
        step_order: 4, delay_days: 14, action_type: 'send_email',
        title: 'Day 14: Personalized CSM check-in',
        config: {
          email_subject: '14-day check-in — How is your usage going?',
          email_body_html: emailHtml('<h2>14-day check-in</h2><p>{{csm.name}}, the account has been active for 14 days.</p><p><strong>3 questions to ask the customer:</strong></p><ol><li>Is the data connected?</li><li>What is the top-priority use case?</li><li>What business outcome are you targeting in 90 days?</li></ol><p>Health Score: {{account.health_score}} | Usage: {{account.product_usage_score}}</p>'),
          email_from_name: 'Sentio AI',
        },
      },
      {
        step_order: 5, delay_days: 30, action_type: 'send_email',
        title: 'Day 30: First Business Review',
        config: {
          email_subject: '30-day review — First value metrics',
          email_body_html: emailHtml('<h2>First-month review</h2><p>Offer the customer a light QBR covering the first value metrics generated:</p><ul><li>Health Score: <strong>{{account.health_score}}/100</strong></li><li>Usage: <strong>{{account.product_usage_score}}/100</strong></li><li>MRR: <strong>{{account.mrr_eur}} USD</strong></li></ul><p>Identify the next 3 quick wins.</p>'),
          email_from_name: 'Sentio AI',
        },
      },
      {
        step_order: 6, delay_days: 60, action_type: 'send_email',
        title: 'Day 60: 90-day Success Plan',
        config: {
          email_subject: '90-day Success Plan — Let\'s define your goals',
          email_body_html: emailHtml('<h2>90-day Success Plan</h2><p>Send the pre-filled Success Plan template with the account\'s data:</p><ul><li>Health Score: {{account.health_score}}</li><li>Expansion Score: {{account.expansion_score}}</li><li>Seat usage: {{account.seat_count}}/{{account.seat_limit}}</li></ul><p>Ask for validation of business objectives and propose a gradual adoption roadmap.</p>'),
          email_from_name: 'Sentio AI',
        },
      },
    ],
    eligibility_criteria: {
      operator: 'AND',
      conditions: [
        { field: 'product_usage_score', operator: 'lte', value: 40 },
      ],
    },
  },

  // ── 3. SEAT EXPANSION UPSELL ────────────────────────────
  {
    organization_id: ORG_ID,
    title: 'Seat Expansion Upsell',
    title_en: 'Seat Expansion Upsell',
    description: 'Convert seat saturation into license expansion. 4 steps over 14 days.',
    description_en: 'Convert seat saturation into license expansion. 4 steps over 14 days.',
    playbook_type: 'semi_automated',
    template_category: 'expansion',
    priority: 'high',
    is_template: true,
    is_workflow: true,
    status: 'draft',
    actions: [],
    steps: [
      {
        step_order: 1, delay_days: 0, action_type: 'send_email',
        title: 'Day 0: Value-based email — Seats at capacity',
        config: {
          email_subject: 'Expansion opportunity — {{account.seat_usage_pct}}% of seats used',
          email_body_html: emailHtml('<h2 style="color:#4f46e5;">Expansion opportunity detected</h2><p>{{csm.name}},</p><p>Account {{account.id}} is using <strong>{{account.seat_usage_pct}}%</strong> of its seats ({{account.seat_count}}/{{account.seat_limit}}).</p><p><strong>Context:</strong></p><ul><li>Health Score: {{account.health_score}}/100 (good)</li><li>Expansion Score: {{account.expansion_score}}/100</li><li>Current MRR: {{account.mrr_eur}} USD</li></ul><p>Propose an upgrade with an estimated ROI based on current KPIs.</p>'),
          email_from_name: 'Sentio AI Growth',
        },
      },
      {
        step_order: 2, delay_days: 3, action_type: 'send_email',
        title: 'Day 3: Temporary unlock offered',
        config: {
          email_subject: '[ACTION] Temporary seat unlock — {{account.id}}',
          email_body_html: emailHtml('<h2>Temporary unlock proposal</h2><p>To avoid blocking the customer\'s team, offer to unlock 5 extra seats for free for 14 days.</p><p>Current seats: {{account.seat_count}}/{{account.seat_limit}}</p><p>This gives time to assess actual needs.</p>'),
          email_from_name: 'Sentio AI',
        },
      },
      {
        step_order: 3, delay_days: 10, action_type: 'create_task',
        title: 'Day 10: CSM call — Understand the needs',
        config: { title: 'Expansion call — Understand growth needs', due_days: 3 },
      },
      {
        step_order: 4, delay_days: 14, action_type: 'send_email',
        title: 'Day 14: Special offer from VP Sales',
        config: {
          email_subject: 'Special expansion offer — {{account.id}}',
          email_body_html: emailHtml('<h2>Special expansion offer</h2><p>The extra-seats trial period is ending. Offer a special deal:</p><ul><li>10% discount if upgraded before Day 20</li><li>Current MRR: {{account.mrr_eur}} USD</li><li>Expansion Score: {{account.expansion_score}}/100</li></ul>'),
          email_from_name: 'Sentio AI Sales',
        },
      },
    ],
    eligibility_criteria: {
      operator: 'AND',
      conditions: [
        { field: 'expansion_score', operator: 'gte', value: 75 },
        { field: 'health_score', operator: 'gte', value: 65 },
      ],
    },
  },

  // ── 4. RE-ENGAGEMENT OF INACTIVE ACCOUNTS ───────────────────────────
  {
    organization_id: ORG_ID,
    title: 'Re-engagement of Inactive Accounts',
    title_en: 'Re-engagement of Inactive Accounts',
    description: 'Re-activates dormant accounts before inactivity leads to churn. 4 steps over 20 days.',
    description_en: 'Re-activates dormant accounts before inactivity leads to churn. 4 steps over 20 days.',
    playbook_type: 'automated',
    template_category: 'reactivation',
    priority: 'high',
    is_template: true,
    is_workflow: true,
    status: 'draft',
    actions: [],
    steps: [
      {
        step_order: 1, delay_days: 0, action_type: 'send_email',
        title: 'Day 0: "We miss you" email',
        config: {
          email_subject: 'Inactive account detected — {{account.id}}',
          email_body_html: emailHtml('<h2>Inactive account detected</h2><p>{{csm.name}},</p><p>No login has been detected on account {{account.id}} for a while.</p><ul><li>Usage Score: <strong>{{account.product_usage_score}}/100</strong></li><li>Health Score: <strong>{{account.health_score}}/100</strong></li><li>MRR: <strong>{{account.mrr_eur}} USD</strong></li></ul><p>Contact the customer to understand the situation. Key questions:</p><ol><li>Technical difficulties?</li><li>Does the product no longer meet their needs?</li><li>Has a business priority changed?</li></ol>'),
          email_from_name: 'Sentio AI',
        },
      },
      {
        step_order: 2, delay_days: 5, action_type: 'send_email',
        title: 'Day 5: Complimentary re-onboarding',
        config: {
          email_subject: '[OFFER] Free re-onboarding — {{account.id}}',
          email_body_html: emailHtml('<h2>Re-onboarding proposal</h2><p>With no word from the customer, offer a free 45-minute rediscovery session with a product expert:</p><ul><li>Review of the original use case</li><li>Discovery of new features</li><li>Optimal configuration</li></ul><p>No obligation — just here to help them get the most out of their subscription.</p>'),
          email_from_name: 'Sentio AI',
        },
      },
      {
        step_order: 3, delay_days: 10, action_type: 'send_email',
        title: 'Day 10: Missed savings',
        config: {
          email_subject: 'Alert — {{account.mrr_eur}} USD/month unused',
          email_body_html: emailHtml('<h2 style="color:#f59e0b;">Missed savings</h2><p>Simple fact: the subscription costs {{account.mrr_eur}} USD/month but is not being used.</p><p><strong>Two options:</strong></p><ol><li>Reactivation with CSM support (free)</li><li>Pause or cancellation (no fees)</li></ol><p>Full transparency — we\'re here to help, not to keep them against their will.</p>'),
          email_from_name: 'Sentio AI',
        },
      },
      {
        step_order: 4, delay_days: 20, action_type: 'send_email',
        title: 'Day 20: Downgrade offer',
        config: {
          email_subject: 'Final option before cancellation — {{account.id}}',
          email_body_html: emailHtml('<h2>Final option</h2><p>Instead of a full cancellation, offer a downgrade:</p><ul><li>Lower-tier plan at reduced cost (-60%)</li><li>Access retained</li><li>Option to reactivate later</li></ul><p>Or a clean cancellation with no fees.</p>'),
          email_from_name: 'Sentio AI',
        },
      },
    ],
    eligibility_criteria: {
      operator: 'AND',
      conditions: [
        { field: 'product_usage_score', operator: 'lte', value: 20 },
        { field: 'health_score', operator: 'lte', value: 40 },
      ],
    },
  },

  // ── 5. CONTRACT RENEWAL SEQUENCE 90/60/30 ────────────────────
  {
    organization_id: ORG_ID,
    title: 'Contract Renewal Sequence 90/60/30',
    title_en: 'Contract Renewal Sequence 90/60/30',
    description: 'Anticipatory renewal sequence over 90 days for annual contracts. 6 steps.',
    description_en: 'Anticipatory renewal sequence over 90 days for annual contracts. 6 steps.',
    playbook_type: 'semi_automated',
    template_category: 'renewal',
    priority: 'critical',
    is_template: true,
    is_workflow: true,
    status: 'draft',
    actions: [],
    steps: [
      {
        step_order: 1, delay_days: 0, action_type: 'send_email',
        title: 'Day -90: First renewal contact',
        config: {
          email_subject: 'Your renewal in 3 months — Annual review',
          email_body_html: emailHtml('<h2>Renewal in 90 days</h2><p>{{csm.name}},</p><p>The contract for account {{account.id}} is coming up for renewal.</p><p><strong>Review:</strong></p><ul><li>Health Score: {{account.health_score}}/100</li><li>MRR: {{account.mrr_eur}} USD</li><li>Plan: {{account.plan_tier}}</li></ul><p>Renewal options to offer:</p><ol><li>Automatic renewal (no action required)</li><li>Upgrade to a higher plan</li><li>Adjustments (let\'s discuss)</li></ol>'),
          email_from_name: 'Sentio AI Renewals',
        },
      },
      {
        step_order: 2, delay_days: 30, action_type: 'send_email',
        title: 'Day -60: Business Review',
        config: {
          email_subject: 'Review + renewal prep (Day -60)',
          email_body_html: emailHtml('<h2>Business Review — Day -60</h2><p>Before renewal, offer a review covering:</p><ul><li>Results achieved this year</li><li>Goals for next year</li><li>Possible optimizations</li></ul><p>30 minutes together to prepare for renewal.</p>'),
          email_from_name: 'Sentio AI',
        },
      },
      {
        step_order: 3, delay_days: 60, action_type: 'send_email',
        title: 'Day -30: Reminder + early-bird incentive',
        config: {
          email_subject: 'Renewal in 30 days — Early-bird offer',
          email_body_html: emailHtml('<h2 style="color:#4f46e5;">Early Bird Offer</h2><p>The contract renews in 30 days.</p><p><strong>Special offer for early renewal:</strong></p><ul><li>10% discount on next year</li><li>Complimentary premium feature</li><li>Quarterly strategic session included</li></ul><p>Current MRR: {{account.mrr_eur}} USD</p>'),
          email_from_name: 'Sentio AI',
        },
      },
      {
        step_order: 4, delay_days: 75, action_type: 'send_email',
        title: 'Day -15: Gentle urgency',
        config: {
          email_subject: '[ACTION] Renewal confirmation required',
          email_body_html: emailHtml('<h2 style="color:#f59e0b;">Action required — Day -15</h2><p>Without action, access will end on the expiration date.</p><p>The -10% offer expires in 48h.</p><p>Confirm renewal in one click.</p>'),
          email_from_name: 'Sentio AI',
        },
      },
      {
        step_order: 5, delay_days: 83, action_type: 'send_email',
        title: 'Day -7: Technical alert',
        config: {
          email_subject: 'Access expires in 7 days — {{account.id}}',
          email_body_html: emailHtml('<h2 style="color:#dc2626;">Expiring in 7 days</h2><p><strong>Important reminder:</strong></p><ul><li>Access is automatically cut off if not renewed</li><li>Data retained for 30 days, then permanently deleted</li></ul><p>Available actions: Renew | Export data | Talk to us</p>'),
          email_from_name: 'Sentio AI',
        },
      },
      {
        step_order: 6, delay_days: 89, action_type: 'send_email',
        title: 'Day -1: Final alert',
        config: {
          email_subject: 'FINAL DAY — Account expires tomorrow',
          email_body_html: emailHtml('<h2 style="color:#dc2626;">Final day</h2><p>Access will be suspended tomorrow at midnight.</p><p>Renew now (2 min) or contact your CSM urgently.</p>'),
          email_from_name: 'Sentio AI Urgent',
        },
      },
    ],
    eligibility_criteria: {
      operator: 'AND',
      conditions: [
        { field: 'mrr_cents', operator: 'gte', value: 30000 },
      ],
    },
  },

  // ── 6. ENTERPRISE CHURN PREVENTION ────────────────────
  {
    organization_id: ORG_ID,
    title: 'Enterprise Churn Prevention',
    title_en: 'Enterprise Churn Prevention',
    description: 'Ultra-priority protection for strategic accounts (ARR > 50K EUR). 5 steps over 14 days.',
    description_en: 'Ultra-priority protection for strategic accounts (ARR > 50K EUR). 5 steps over 14 days.',
    playbook_type: 'semi_automated',
    template_category: 'churn_prevention',
    priority: 'critical',
    is_template: true,
    is_workflow: true,
    status: 'draft',
    actions: [],
    steps: [
      {
        step_order: 1, delay_days: 0, action_type: 'slack_notify',
        title: 'Day 0: Triple Slack notification',
        config: { channel: '#cs-critical', template: 'enterprise_churn_alert' },
      },
      {
        step_order: 2, delay_days: 1, action_type: 'send_email',
        title: 'Day 1: Executive VP → Customer email',
        config: {
          email_subject: '[STRATEGIC ACCOUNT] Status update — {{account.id}} ({{account.arr_eur}} USD ARR)',
          email_body_html: emailHtml('<h2 style="color:#dc2626;">Strategic Account Alert</h2><p>As VP Customer Success, personal intervention is required.</p><table style="width:100%;border-collapse:collapse;margin:16px 0;"><tr style="border-bottom:1px solid #e2e8f0;"><td style="padding:8px;font-weight:bold;">ARR</td><td style="padding:8px;">{{account.arr_eur}} USD</td></tr><tr style="border-bottom:1px solid #e2e8f0;"><td style="padding:8px;font-weight:bold;">Health Score</td><td style="padding:8px;">{{account.health_score}}/100</td></tr><tr style="border-bottom:1px solid #e2e8f0;"><td style="padding:8px;font-weight:bold;">Churn Risk</td><td style="padding:8px;">{{account.churn_risk_score}}/100</td></tr><tr><td style="padding:8px;font-weight:bold;">Plan</td><td style="padding:8px;">{{account.plan_tier}}</td></tr></table><p>Propose a strategic session with VP CS + CSM + product expert.</p>'),
          email_from_name: 'Sentio AI — VP CS',
        },
      },
      {
        step_order: 3, delay_days: 3, action_type: 'create_task',
        title: 'Day 3: Forced Executive Business Review',
        config: { title: 'Prepare EBR for enterprise account — auto-generated QBR report', due_days: 3 },
      },
      {
        step_order: 4, delay_days: 7, action_type: 'send_email',
        title: 'Day 7: CEO escalation',
        config: {
          email_subject: '[CEO] Strategic account to save — {{account.arr_eur}} USD ARR',
          email_body_html: emailHtml('<h2>CEO Escalation</h2><p>If the account exceeds 100K USD ARR, a personal email from the CEO to the customer contact.</p><p>Offer: Customer Advisory Board + VIP event invitation.</p><p>ARR: {{account.arr_eur}} USD | Health: {{account.health_score}}</p>'),
          email_from_name: 'Sentio AI — Direction',
        },
      },
      {
        step_order: 5, delay_days: 14, action_type: 'send_email',
        title: 'Day 14: Custom rescue plan',
        config: {
          email_subject: '90-day rescue plan — {{account.id}}',
          email_body_html: emailHtml('<h2>Co-built rescue plan</h2><p>Creating a dedicated 90-day Success Plan:</p><ul><li>Dedicated resource (Technical Account Manager)</li><li>Enhanced contractual SLAs</li><li>Weekly check-ins</li></ul><p>Current Health Score: {{account.health_score}} | Goal: > 70 within 90 days</p>'),
          email_from_name: 'Sentio AI',
        },
      },
    ],
    eligibility_criteria: {
      operator: 'AND',
      conditions: [
        { field: 'arr_cents', operator: 'gte', value: 5000000 },
        { field: 'health_score', operator: 'lte', value: 60 },
      ],
    },
  },

  // ── 7. PROGRESSIVE FEATURE ADOPTION ───────────────────────
  {
    organization_id: ORG_ID,
    title: 'Progressive Feature Adoption',
    title_en: 'Progressive Feature Adoption',
    description: 'Maximise feature adoption to increase stickiness. 4 steps over 14 days.',
    description_en: 'Maximise feature adoption to increase stickiness. 4 steps over 14 days.',
    playbook_type: 'automated',
    template_category: 'customer_education',
    priority: 'medium',
    is_template: true,
    is_workflow: true,
    status: 'draft',
    actions: [],
    steps: [
      {
        step_order: 1, delay_days: 0, action_type: 'send_email',
        title: 'Day 0: Feature spotlight',
        config: {
          email_subject: 'Underused feature detected — {{account.id}}',
          email_body_html: emailHtml('<h2 style="color:#4f46e5;">Feature Spotlight</h2><p>{{csm.name}},</p><p>Account {{account.id}} is not using some paid features:</p><ul><li>Usage Score: {{account.product_usage_score}}/100</li><li>Health Score: {{account.health_score}}/100</li></ul><p>Send the customer an email highlighting concrete benefits and a direct activation link.</p>'),
          email_from_name: 'Sentio AI',
        },
      },
      {
        step_order: 2, delay_days: 3, action_type: 'slack_notify',
        title: 'Day 3: In-app notification',
        config: { channel: '#product-adoption', template: 'feature_adoption_reminder' },
      },
      {
        step_order: 3, delay_days: 7, action_type: 'send_email',
        title: 'Day 7: Similar customer success story',
        config: {
          email_subject: 'Success story — How a similar customer boosted productivity',
          email_body_html: emailHtml('<h2>Success Story</h2><p>Share a case study of a similar customer who activated the underused features.</p><p>Typical results: X% improvement on key metrics, Y hours saved/month.</p><p>Current account usage: {{account.product_usage_score}}/100</p>'),
          email_from_name: 'Sentio AI',
        },
      },
      {
        step_order: 4, delay_days: 14, action_type: 'send_email',
        title: 'Day 14: Complimentary personalized demo',
        config: {
          email_subject: '[OFFER] Personalized demo with your data',
          email_body_html: emailHtml('<h2>Final proposal</h2><p>Offer a 20-minute session to:</p><ul><li>Configure the features with the customer\'s real data</li><li>3 use cases specific to their business</li><li>Answer all questions</li></ul><p>If not interested, stop following up on this topic.</p>'),
          email_from_name: 'Sentio AI',
        },
      },
    ],
    eligibility_criteria: {
      operator: 'AND',
      conditions: [
        { field: 'product_usage_score', operator: 'lte', value: 50 },
        { field: 'health_score', operator: 'gte', value: 40 },
      ],
    },
  },

  // ── 8. NPS DETRACTORS RECOVERY ───────────────────────────
  {
    organization_id: ORG_ID,
    title: 'NPS Detractors Recovery',
    title_en: 'NPS Detractors Recovery',
    description: 'Turn a negative experience into a loyalty opportunity (Service Recovery Paradox). 5 steps over 30 days.',
    description_en: 'Turn a negative experience into a loyalty opportunity (Service Recovery Paradox). 5 steps over 30 days.',
    playbook_type: 'semi_automated',
    template_category: 'nps_detractors',
    priority: 'critical',
    is_template: true,
    is_workflow: true,
    status: 'draft',
    actions: [],
    steps: [
      {
        step_order: 1, delay_days: 0, action_type: 'send_email',
        title: 'Day 0: CSM email within 2h of NPS',
        config: {
          email_subject: '[URGENT] NPS detractor detected — {{account.id}}',
          email_body_html: emailHtml('<h2 style="color:#dc2626;">NPS Detractor — Immediate action</h2><p>{{csm.name}},</p><p>An NPS detractor has been detected on account {{account.id}}.</p><ul><li>Health Score: {{account.health_score}}/100</li><li>Churn Risk: {{account.churn_risk_score}}/100</li></ul><p><strong>Action required within 2h:</strong></p><ol><li>Call the main contact</li><li>Understand what went wrong</li><li>Present an immediate action plan</li></ol>'),
          email_from_name: 'Sentio AI Alerts',
        },
      },
      {
        step_order: 2, delay_days: 1, action_type: 'send_email',
        title: 'Day 1: VP escalation if score <= 3',
        config: {
          email_subject: '[VP ESCALATION] Critical detractor — {{account.id}}',
          email_body_html: emailHtml('<h2 style="color:#dc2626;">VP Customer Success Escalation</h2><p>The VP CS must personally call the customer if the NPS score is very low.</p><p>Goals:</p><ol><li>Understand what went wrong</li><li>Present an immediate action plan</li><li>Personally commit to resolution</li></ol>'),
          email_from_name: 'Sentio AI — VP CS',
        },
      },
      {
        step_order: 3, delay_days: 7, action_type: 'send_email',
        title: 'Day 7: Resolution follow-up',
        config: {
          email_subject: 'Update on actions taken — {{account.id}}',
          email_body_html: emailHtml('<h2>Resolution follow-up</h2><p>Status update on the action plan:</p><ul><li>Current Health Score: {{account.health_score}}/100</li><li>Progress since the alert</li></ul><p>Send a quick 1-question survey: "Do these actions meet your expectations?"</p>'),
          email_from_name: 'Sentio AI',
        },
      },
      {
        step_order: 4, delay_days: 14, action_type: 'send_email',
        title: 'Day 14: Satisfaction re-measurement',
        config: {
          email_subject: 'How would you rate our responsiveness? — {{account.id}}',
          email_body_html: emailHtml('<h2>Satisfaction re-measurement</h2><p>Send a new targeted NPS survey.</p><p>If turned into a Promoter → personalized email from the VP.</p><p>Health Score: {{account.health_score}} | Churn Risk: {{account.churn_risk_score}}</p>'),
          email_from_name: 'Sentio AI',
        },
      },
      {
        step_order: 5, delay_days: 30, action_type: 'create_task',
        title: 'Day 30: Final NPS review',
        config: { title: 'Final NPS review — Verify improvement', due_days: 5 },
      },
    ],
    eligibility_criteria: {
      operator: 'AND',
      conditions: [
        { field: 'health_score', operator: 'lte', value: 40 },
      ],
    },
  },

  // ── 9. CHAMPIONS ADVOCACY ─────────────────────────────────
  {
    organization_id: ORG_ID,
    title: 'Champions Advocacy',
    title_en: 'Champions Advocacy',
    description: 'Transform satisfied customers into active brand ambassadors. 4 steps over 14 days.',
    description_en: 'Transform satisfied customers into active brand ambassadors. 4 steps over 14 days.',
    playbook_type: 'semi_automated',
    template_category: 'champions_advocacy',
    priority: 'medium',
    is_template: true,
    is_workflow: true,
    status: 'draft',
    actions: [],
    steps: [
      {
        step_order: 1, delay_days: 0, action_type: 'send_email',
        title: 'Day 0: Thank-you + testimonial request',
        config: {
          email_subject: 'Champion detected — {{account.id}} (Health {{account.health_score}})',
          email_body_html: emailHtml('<h2 style="color:#10b981;">Champion detected!</h2><p>{{csm.name}},</p><p>Account {{account.id}} is a champion:</p><ul><li>Health Score: <strong>{{account.health_score}}/100</strong></li><li>Expansion Score: <strong>{{account.expansion_score}}/100</strong></li><li>MRR: <strong>{{account.mrr_eur}} USD</strong></li></ul><p><strong>Possible actions:</strong></p><ol><li>Ask for a G2/Capterra/TrustPilot review</li><li>Offer a video testimonial</li><li>Co-create a case study</li></ol>'),
          email_from_name: 'Sentio AI Growth',
        },
      },
      {
        step_order: 2, delay_days: 3, action_type: 'send_email',
        title: 'Day 3: Champions Program invitation',
        config: {
          email_subject: '[INVITATION] Champions Program 2026 — {{account.id}}',
          email_body_html: emailHtml('<h2 style="color:#4f46e5;">Champions Program</h2><p>Invite the customer to the Champions Program:</p><ul><li>Early access to new features (private beta)</li><li>Influence on the product roadmap</li><li>VIP customer events</li><li>"Champion" badge on profile</li><li>Discounts on premium services</li></ul>'),
          email_from_name: 'Sentio AI',
        },
      },
      {
        step_order: 3, delay_days: 7, action_type: 'send_email',
        title: 'Day 7: Co-branded success story',
        config: {
          email_subject: 'Share your success story? — {{account.id}}',
          email_body_html: emailHtml('<h2>Co-branded Success Story</h2><p>Propose a co-branded case study:</p><ul><li>We write everything</li><li>The customer approves it</li><li>Co-promotion on both websites + social media</li></ul><p>Customer investment: one 30-min interview.</p>'),
          email_from_name: 'Sentio AI',
        },
      },
      {
        step_order: 4, delay_days: 14, action_type: 'send_email',
        title: 'Day 14: Referral program',
        config: {
          email_subject: 'Referral program — Refer and earn',
          email_body_html: emailHtml('<h2>Referral Program</h2><p>Offer the referral program:</p><ul><li>Credit for each qualified referral</li><li>Referred customer: 20% off the first year</li><li>Referral tracking dashboard</li></ul>'),
          email_from_name: 'Sentio AI',
        },
      },
    ],
    eligibility_criteria: {
      operator: 'AND',
      conditions: [
        { field: 'health_score', operator: 'gte', value: 75 },
        { field: 'expansion_score', operator: 'gte', value: 60 },
      ],
    },
  },

  // ── 10. MULTI-TOUCH GROWTH NURTURING ──────────────────────
  {
    organization_id: ORG_ID,
    title: 'Multi-touch Growth Nurturing',
    title_en: 'Multi-touch Growth Nurturing',
    description: 'Maximise retention and expansion with a scalable model for Growth accounts (MRR 2K–10K EUR). 5 steps over 90 days.',
    description_en: 'Maximise retention and expansion with a scalable model for Growth accounts (MRR 2K–10K EUR). 5 steps over 90 days.',
    playbook_type: 'automated',
    template_category: 'expansion',
    priority: 'high',
    is_template: true,
    is_workflow: true,
    status: 'draft',
    actions: [],
    steps: [
      {
        step_order: 1, delay_days: 0, action_type: 'send_email',
        title: 'Day 0: Automated quarterly QBR',
        config: {
          email_subject: 'Quarterly review {{org.name}} — {{account.id}}',
          email_body_html: emailHtml('<h2>Quarterly Review</h2><p>{{csm.name}},</p><p>This quarter\'s performance report:</p><table style="width:100%;border-collapse:collapse;margin:16px 0;"><tr style="border-bottom:1px solid #e2e8f0;"><td style="padding:8px;font-weight:bold;">Health Score</td><td style="padding:8px;">{{account.health_score}}/100</td></tr><tr style="border-bottom:1px solid #e2e8f0;"><td style="padding:8px;font-weight:bold;">MRR</td><td style="padding:8px;">{{account.mrr_eur}} USD</td></tr><tr style="border-bottom:1px solid #e2e8f0;"><td style="padding:8px;font-weight:bold;">Usage</td><td style="padding:8px;">{{account.product_usage_score}}/100</td></tr><tr><td style="padding:8px;font-weight:bold;">Expansion</td><td style="padding:8px;">{{account.expansion_score}}/100</td></tr></table><p>Offer a 30-min strategic session this month.</p>'),
          email_from_name: 'Sentio AI',
        },
      },
      {
        step_order: 2, delay_days: 7, action_type: 'send_email',
        title: 'Day 7: Educational webinar invitation',
        config: {
          email_subject: 'Monthly webinar — {{org.name}} best practices',
          email_body_html: emailHtml('<h2>Educational Webinar</h2><p>Notify the CSM of the next monthly webinar so they can invite the customer.</p><p>Format: 45 minutes + live Q&A.</p><p>Recording sent to all registrants.</p>'),
          email_from_name: 'Sentio AI Education',
        },
      },
      {
        step_order: 3, delay_days: 30, action_type: 'send_email',
        title: 'Day 30: Best practices newsletter',
        config: {
          email_subject: 'Monthly newsletter — 3 tips to optimize {{org.name}}',
          email_body_html: emailHtml('<h2>Best Practices Newsletter</h2><p>3 monthly tips for the customer:</p><ol><li>Tip based on the most common usage</li><li>Video tutorial for an advanced feature</li><li>Downloadable template or guide</li></ol><p>Current usage: {{account.product_usage_score}}/100</p>'),
          email_from_name: 'Sentio AI',
        },
      },
      {
        step_order: 4, delay_days: 60, action_type: 'send_email',
        title: 'Day 60: Engagement email if usage drops',
        config: {
          email_subject: 'Declining activity — {{account.id}}',
          email_body_html: emailHtml('<h2 style="color:#f59e0b;">Declining activity</h2><p>{{csm.name}},</p><p>Usage is declining on account {{account.id}}:</p><ul><li>Usage Score: {{account.product_usage_score}}/100</li><li>Health Score: {{account.health_score}}/100</li></ul><p>Any quick win to propose, or help needed?</p>'),
          email_from_name: 'Sentio AI',
        },
      },
      {
        step_order: 5, delay_days: 90, action_type: 'create_task',
        title: 'Day 90: Full quarterly review',
        config: { title: 'Growth quarterly review — Prepare report + next actions', due_days: 7 },
      },
    ],
    eligibility_criteria: {
      operator: 'AND',
      conditions: [
        { field: 'mrr_cents', operator: 'gte', value: 200000 },
        { field: 'mrr_cents', operator: 'lte', value: 1000000 },
      ],
    },
  },

  // ── 11. DOWNGRADE PREVENTION ──────────────────────────────
  {
    organization_id: ORG_ID,
    title: 'Downgrade Prevention',
    title_en: 'Downgrade Prevention',
    description: 'Understand reasons and propose alternatives to a full downgrade. 5 steps over 3 days.',
    description_en: 'Understand reasons and propose alternatives to a full downgrade. 5 steps over 3 days.',
    playbook_type: 'semi_automated',
    template_category: 'downgrade_prevention',
    priority: 'high',
    is_template: true,
    is_workflow: true,
    status: 'draft',
    actions: [],
    steps: [
      {
        step_order: 1, delay_days: 0, action_type: 'send_email',
        title: 'Day 0: Intercept questionnaire',
        config: {
          email_subject: '[ACTION] Downgrade request detected — {{account.id}}',
          email_body_html: emailHtml('<h2 style="color:#f59e0b;">Downgrade detected</h2><p>{{csm.name}},</p><p>Account {{account.id}} is showing downgrade signals:</p><ul><li>Health Score: {{account.health_score}}/100</li><li>MRR: {{account.mrr_eur}} USD</li><li>Seats: {{account.seat_count}}/{{account.seat_limit}}</li></ul><p><strong>Send the customer this questionnaire:</strong></p><ol><li>Main reason (budget/features/team/dissatisfaction)</li><li>What could we do to prevent the downgrade?</li><li>Temporary or permanent?</li></ol>'),
          email_from_name: 'Sentio AI',
        },
      },
      {
        step_order: 2, delay_days: 0, action_type: 'slack_notify',
        title: 'Day 0: CSM Slack notification',
        config: { channel: '#cs-saves', template: 'downgrade_alert' },
      },
      {
        step_order: 3, delay_days: 1, action_type: 'send_email',
        title: 'Day 1: Counter-offer based on reason',
        config: {
          email_subject: 'Alternative options to downgrading — {{account.id}}',
          email_body_html: emailHtml('<h2>Counter-offer</h2><p>Depending on the reason for the downgrade, offer:</p><ul><li><strong>Budget:</strong> Annual payment (-X%) or a 60-day deferral</li><li><strong>Unused features:</strong> Quick 15-min audit</li><li><strong>Smaller team:</strong> Reduce seats without changing plan</li></ul><p>Current MRR: {{account.mrr_eur}} USD</p>'),
          email_from_name: 'Sentio AI',
        },
      },
      {
        step_order: 4, delay_days: 2, action_type: 'create_task',
        title: 'Day 2: CSM phone call',
        config: { title: 'Save call — Understand the real reason for the downgrade', due_days: 1 },
      },
      {
        step_order: 5, delay_days: 3, action_type: 'send_email',
        title: 'Day 3: Final CEO offer',
        config: {
          email_subject: 'Personal CEO offer — {{account.id}}',
          email_body_html: emailHtml('<h2>Final offer — CEO</h2><p>If the account exceeds 20K USD ARR:</p><ul><li>2 months free on the current plan</li><li>No commitment</li><li>Value assessment</li></ul><p>Otherwise, execute the downgrade and send the guide to lost features + a 14-day undo option.</p><p>ARR: {{account.arr_eur}} USD</p>'),
          email_from_name: 'Sentio AI — Direction',
        },
      },
    ],
    eligibility_criteria: {
      operator: 'AND',
      conditions: [
        { field: 'health_score', operator: 'lte', value: 50 },
      ],
    },
  },

  // ── 12. STRATEGIC SUCCESS PLANNING ──────────────────────
  {
    organization_id: ORG_ID,
    title: 'Strategic Success Planning',
    title_en: 'Strategic Success Planning',
    description: 'Co-build a success plan aligned with customer OKRs. 5 steps over 90 days.',
    description_en: 'Co-build a success plan aligned with customer OKRs. 5 steps over 90 days.',
    playbook_type: 'semi_automated',
    template_category: 'success_planning',
    priority: 'medium',
    is_template: true,
    is_workflow: true,
    status: 'draft',
    actions: [],
    steps: [
      {
        step_order: 1, delay_days: 0, action_type: 'send_email',
        title: 'Day 30 post-signature: Success Plan kickoff',
        config: {
          email_subject: 'Let\'s build your 90-day success plan — {{account.id}}',
          email_body_html: emailHtml('<h2 style="color:#4f46e5;">90-day Success Plan</h2><p>{{csm.name}},</p><p>Account {{account.id}} is ready for a Success Plan:</p><ul><li>ARR: {{account.arr_eur}} USD</li><li>Health: {{account.health_score}}/100</li></ul><p><strong>Co-creation session (60 min):</strong></p><ol><li>Define 3 priority business objectives</li><li>Identify measurement KPIs</li><li>Build the adoption roadmap</li><li>Schedule follow-up check-ins</li></ol>'),
          email_from_name: 'Sentio AI',
        },
      },
      {
        step_order: 2, delay_days: 5, action_type: 'send_email',
        title: 'Day 35: Send Success Plan template',
        config: {
          email_subject: 'Pre-filled Success Plan template — {{account.id}}',
          email_body_html: emailHtml('<h2>Success Plan Template</h2><p>Send the pre-filled template with the account\'s data:</p><ul><li>Context & Business Objectives</li><li>Success KPIs (pre-filled)</li><li>30/60/90-day milestones</li><li>Required resources & training</li></ul>'),
          email_from_name: 'Sentio AI',
        },
      },
      {
        step_order: 3, delay_days: 30, action_type: 'send_email',
        title: 'Day 60: Milestone 1 check-in',
        config: {
          email_subject: 'Success Plan check-in — Milestone 1/3 — {{account.id}}',
          email_body_html: emailHtml('<h2>Milestone 1 Check-in</h2><p>Progress update on the Success Plan:</p><ul><li>Health Score: {{account.health_score}}/100</li><li>Usage: {{account.product_usage_score}}/100</li><li>MRR: {{account.mrr_eur}} USD</li></ul><p>Assess progress toward the defined objectives.</p>'),
          email_from_name: 'Sentio AI',
        },
      },
      {
        step_order: 4, delay_days: 60, action_type: 'send_email',
        title: 'Day 90: Milestone 2 check-in',
        config: {
          email_subject: 'Success Plan check-in — Milestone 2/3 — {{account.id}}',
          email_body_html: emailHtml('<h2>Milestone 2 Check-in</h2><p>Mid-point assessment. Adjust the plan if needed.</p><p>Health: {{account.health_score}} | Expansion: {{account.expansion_score}}</p>'),
          email_from_name: 'Sentio AI',
        },
      },
      {
        step_order: 5, delay_days: 90, action_type: 'send_email',
        title: 'Day 120: Final Success Review',
        config: {
          email_subject: 'Success Review — 90 days of results — {{account.id}}',
          email_body_html: emailHtml('<h2 style="color:#10b981;">Final Success Review</h2><p>90-day summary:</p><table style="width:100%;border-collapse:collapse;margin:16px 0;"><tr style="border-bottom:1px solid #e2e8f0;"><td style="padding:8px;font-weight:bold;">Health Score</td><td style="padding:8px;">{{account.health_score}}/100</td></tr><tr style="border-bottom:1px solid #e2e8f0;"><td style="padding:8px;font-weight:bold;">Usage</td><td style="padding:8px;">{{account.product_usage_score}}/100</td></tr><tr><td style="padding:8px;font-weight:bold;">Expansion</td><td style="padding:8px;">{{account.expansion_score}}/100</td></tr></table><p>Plan the next Success Plan (following 90 days).</p>'),
          email_from_name: 'Sentio AI',
        },
      },
    ],
    eligibility_criteria: {
      operator: 'AND',
      conditions: [
        { field: 'arr_cents', operator: 'gte', value: 2000000 },
      ],
    },
  },

  // ── 13. PAYMENT FAILURE RECOVERY ──────────────────────────
  {
    organization_id: ORG_ID,
    title: 'Payment Failure Recovery',
    title_en: 'Payment Failure Recovery',
    description: 'Recover failed payments without friction. Smart dunning in 8 steps over 30 days.',
    description_en: 'Recover failed payments without friction. Smart dunning in 8 steps over 30 days.',
    playbook_type: 'automated',
    template_category: 'payment_recovery',
    priority: 'critical',
    is_template: true,
    is_workflow: true,
    status: 'draft',
    actions: [],
    steps: [
      {
        step_order: 1, delay_days: 0, action_type: 'send_email',
        title: 'Day 0: Failed payment notification',
        config: {
          email_subject: 'Failed payment detected — {{account.id}} ({{account.mrr_eur}} USD)',
          email_body_html: emailHtml('<h2 style="color:#dc2626;">Payment failed</h2><p>{{csm.name}},</p><p>The payment for account {{account.id}} has failed.</p><ul><li>MRR: {{account.mrr_eur}} USD</li><li>Plan: {{account.plan_tier}}</li></ul><p>Internal notification — no immediate action needed (avoid over-contacting).</p>'),
          email_from_name: 'Sentio AI Billing',
        },
      },
      {
        step_order: 2, delay_days: 3, action_type: 'send_email',
        title: 'Day 3: Reminder + proactive help',
        config: {
          email_subject: '[REMINDER] Payment pending — {{account.id}}',
          email_body_html: emailHtml('<h2 style="color:#f59e0b;">Payment still pending</h2><p>The {{account.mrr_eur}} USD payment is still pending.</p><p>Offer proactive help: bank verification, changing the payment method, FAQ.</p>'),
          email_from_name: 'Sentio AI Billing',
        },
      },
      {
        step_order: 3, delay_days: 5, action_type: 'send_email',
        title: 'Day 5: CSM escalation',
        config: {
          email_subject: 'Persistent payment issue — {{account.id}}',
          email_body_html: emailHtml('<h2>CSM Escalation</h2><p>The payment issue has persisted for 5 days.</p><p>{{csm.name}}, contact the customer directly:</p><ul><li>Were billing emails received?</li><li>Any issue with the payment process?</li><li>Need a specific invoice or purchase order?</li></ul>'),
          email_from_name: 'Sentio AI',
        },
      },
      {
        step_order: 4, delay_days: 7, action_type: 'send_email',
        title: 'Day 7: Last chance before suspension',
        config: {
          email_subject: 'FINAL DAY — Suspension imminent — {{account.id}}',
          email_body_html: emailHtml('<h2 style="color:#dc2626;">Suspension imminent</h2><p>Access will be suspended tomorrow if payment is not settled.</p><p>MRR: {{account.mrr_eur}} USD</p><p>Guaranteed response within 1h.</p>'),
          email_from_name: 'Sentio AI Urgent',
        },
      },
      {
        step_order: 5, delay_days: 8, action_type: 'send_email',
        title: 'Day 8: Soft suspension',
        config: {
          email_subject: 'Account suspended — {{account.id}}',
          email_body_html: emailHtml('<h2 style="color:#dc2626;">Account suspended</h2><p>The account is suspended following unpaid payment.</p><p>Data is kept safe (retained for 30 days).</p><p>To reactivate: settle the payment → access restored within 5 minutes.</p>'),
          email_from_name: 'Sentio AI',
        },
      },
      {
        step_order: 6, delay_days: 15, action_type: 'send_email',
        title: 'Day 15: Payment arrangement offer',
        config: {
          email_subject: 'Payment options to reactivate — {{account.id}}',
          email_body_html: emailHtml('<h2>Arrangement offer</h2><p>Offer options:</p><ol><li>Installment payment</li><li>30-day deferral (no fees)</li><li>Personalized discussion</li></ol>'),
          email_from_name: 'Sentio AI Billing',
        },
      },
      {
        step_order: 7, delay_days: 28, action_type: 'send_email',
        title: 'Day 28: Before permanent deletion',
        config: {
          email_subject: '[FINAL ALERT] Deletion in 48h — {{account.id}}',
          email_body_html: emailHtml('<h2 style="color:#dc2626;">Deletion in 48h</h2><p>Data will be permanently deleted in 48h.</p><p>Manual export available. Settling the payment is still possible.</p>'),
          email_from_name: 'Sentio AI',
        },
      },
      {
        step_order: 8, delay_days: 30, action_type: 'send_email',
        title: 'Day 30: Deletion + exit survey',
        config: {
          email_subject: 'Account deleted — {{account.id}}',
          email_body_html: emailHtml('<h2>Account deleted</h2><p>The account has been deleted.</p><p>Send a 30-second exit survey and inform them of the 7-day recovery option.</p>'),
          email_from_name: 'Sentio AI',
        },
      },
    ],
    eligibility_criteria: {
      operator: 'AND',
      conditions: [
        { field: 'health_score', operator: 'lte', value: 30 },
      ],
    },
  },

  // ── 14. WEEKLY HEALTH MONITORING ──────────────────────────
  {
    organization_id: ORG_ID,
    title: 'Weekly Health Monitoring',
    title_en: 'Weekly Health Monitoring',
    description: 'Early detection of degradation before it becomes critical. Automated weekly analysis.',
    description_en: 'Early detection of degradation before it becomes critical. Automated weekly analysis.',
    playbook_type: 'automated',
    template_category: 'health_monitoring',
    priority: 'high',
    is_template: true,
    is_workflow: true,
    status: 'draft',
    actions: [],
    steps: [
      {
        step_order: 1, delay_days: 0, action_type: 'send_email',
        title: 'Day 0: Weekly CSM digest',
        config: {
          email_subject: 'Weekly Health Report — {{account.id}}',
          email_body_html: emailHtml('<h2>Weekly Health Report</h2><p>{{csm.name}},</p><p>Account {{account.id}} — Warning signals:</p><table style="width:100%;border-collapse:collapse;margin:16px 0;"><tr style="border-bottom:1px solid #e2e8f0;"><td style="padding:8px;font-weight:bold;">Health Score</td><td style="padding:8px;">{{account.health_score}}/100</td></tr><tr style="border-bottom:1px solid #e2e8f0;"><td style="padding:8px;font-weight:bold;">Churn Risk</td><td style="padding:8px;">{{account.churn_risk_score}}/100</td></tr><tr style="border-bottom:1px solid #e2e8f0;"><td style="padding:8px;font-weight:bold;">Usage</td><td style="padding:8px;">{{account.product_usage_score}}/100</td></tr><tr><td style="padding:8px;font-weight:bold;">MRR</td><td style="padding:8px;">{{account.mrr_eur}} USD</td></tr></table><p>Check whether action is needed.</p>'),
          email_from_name: 'Sentio AI Monitoring',
        },
      },
      {
        step_order: 2, delay_days: 1, action_type: 'send_email',
        title: 'Day 1: Customer email — Declining activity',
        config: {
          email_subject: 'Declining activity detected — {{account.id}}',
          email_body_html: emailHtml('<h2 style="color:#f59e0b;">Declining activity</h2><p>Our systems have detected a drop in usage:</p><ul><li>Usage Score: {{account.product_usage_score}}/100</li><li>Health Score: {{account.health_score}}/100</li></ul><p>If everything is fine, no action is required. Otherwise, offer help:</p><ul><li>Technical support</li><li>Session with the CSM</li></ul>'),
          email_from_name: 'Sentio AI',
        },
      },
      {
        step_order: 3, delay_days: 3, action_type: 'send_email',
        title: 'Day 3: Congratulations if improved',
        config: {
          email_subject: 'Excellent progress — {{account.id}}',
          email_body_html: emailHtml('<h2 style="color:#10b981;">Congratulations!</h2><p>If the Health Score has improved: send a congratulatory email to the customer.</p><p>Health Score: {{account.health_score}}/100</p><p>Keep the positive momentum going!</p>'),
          email_from_name: 'Sentio AI',
        },
      },
    ],
    eligibility_criteria: {
      operator: 'AND',
      conditions: [
        { field: 'health_score', operator: 'lte', value: 70 },
      ],
    },
  },

  // ── 15. CUSTOMER EDUCATION CERTIFICATION ──────────────────
  {
    organization_id: ORG_ID,
    title: 'Customer Education Certification',
    title_en: 'Customer Education Certification',
    description: 'Increase adoption and stickiness through structured training. Certification programme in 6 steps over 60 days.',
    description_en: 'Increase adoption and stickiness through structured training. Certification programme in 6 steps over 60 days.',
    playbook_type: 'automated',
    template_category: 'customer_education',
    priority: 'medium',
    is_template: true,
    is_workflow: true,
    status: 'draft',
    actions: [],
    steps: [
      {
        step_order: 1, delay_days: 0, action_type: 'send_email',
        title: 'Day 0: Certification invitation',
        config: {
          email_subject: '{{org.name}} Certification invitation — {{account.id}}',
          email_body_html: emailHtml('<h2 style="color:#4f46e5;">{{org.name}} Certification</h2><p>{{csm.name}},</p><p>Account {{account.id}} is ready for certification:</p><ul><li>Usage: {{account.product_usage_score}}/100 (untapped potential)</li><li>Active for > 60 days</li></ul><p><strong>Program (free, online):</strong></p><ol><li>Module 1: Fundamentals (1h)</li><li>Module 2: Advanced features (2h)</li><li>Module 3: Best practices (1h30)</li><li>Final exam (30 min)</li></ol><p>Total duration: ~5h over 2 weeks. Limited spots.</p>'),
          email_from_name: 'Sentio AI Education',
        },
      },
      {
        step_order: 2, delay_days: 1, action_type: 'send_email',
        title: 'Day 1: Certification welcome',
        config: {
          email_subject: 'Welcome to the {{org.name}} Certification',
          email_body_html: emailHtml('<h2>Welcome!</h2><p>Program roadmap:</p><ul><li>Week 1: Modules 1 & 2</li><li>Week 2: Module 3 + Exam</li></ul><p>Goal: Certified badge within 14 days!</p>'),
          email_from_name: 'Sentio AI Education',
        },
      },
      {
        step_order: 3, delay_days: 7, action_type: 'send_email',
        title: 'Day 7: Progress follow-up',
        config: {
          email_subject: 'Certification follow-up — How are you progressing?',
          email_body_html: emailHtml('<h2>Progress follow-up</h2><p>Tips:</p><ul><li>Block 30 min today to make progress</li><li>Shortest module: 20 min</li><li>Exam pass rate: 92%</li></ul>'),
          email_from_name: 'Sentio AI Education',
        },
      },
      {
        step_order: 4, delay_days: 14, action_type: 'send_email',
        title: 'Day 14: Certification congratulations',
        config: {
          email_subject: 'Congratulations! Certification earned — {{account.id}}',
          email_body_html: emailHtml('<h2 style="color:#10b981;">Certification earned!</h2><p>Activated benefits:</p><ul><li>"Certified" badge on profile</li><li>Access to private Slack community</li><li>Priority support (-50% SLA)</li><li>15% promo code</li></ul><p>Next step: Level 2 Certification in 90 days.</p>'),
          email_from_name: 'Sentio AI',
        },
      },
      {
        step_order: 5, delay_days: 30, action_type: 'send_email',
        title: 'Day 30: Post-certification engagement',
        config: {
          email_subject: 'Post-certification — How are you using your new skills?',
          email_body_html: emailHtml('<h2>1 month after certification</h2><p>Feedback questions:</p><ul><li>Concrete results achieved?</li><li>Most-used feature now?</li><li>Use case deployed?</li></ul><p>Current usage: {{account.product_usage_score}}/100</p>'),
          email_from_name: 'Sentio AI Education',
        },
      },
      {
        step_order: 6, delay_days: 60, action_type: 'send_email',
        title: 'Day 60: Advanced webinar for certified users',
        config: {
          email_subject: '[CERTIFIED] Expert Webinar — Advanced session',
          email_body_html: emailHtml('<h2>Expert Webinar</h2><p>Webinar reserved for certified users:</p><ul><li>Level: Expert</li><li>Duration: 60 min</li><li>Advanced technical content</li><li>Q&A with the Lead Developer</li></ul>'),
          email_from_name: 'Sentio AI Education',
        },
      },
    ],
    eligibility_criteria: {
      operator: 'AND',
      conditions: [
        { field: 'product_usage_score', operator: 'gte', value: 40 },
        { field: 'product_usage_score', operator: 'lte', value: 60 },
      ],
    },
  },
]

// ── Main ────────────────────────────────────────────────────

async function main() {
  console.log('=== Sentio AI — Seed 15 Playbook Workflow Templates ===')
  console.log('Organization: ' + ORG_ID)
  console.log('')

  // 1. Archive existing templates
  console.log('Archiving existing templates...')
  const archiveRes = await fetch(
    SUPABASE_URL + '/rest/v1/playbooks?organization_id=eq.' + ORG_ID + '&is_template=eq.true&status=neq.archived',
    {
      method: 'PATCH',
      headers: {
        'apikey': SERVICE_KEY,
        'Authorization': 'Bearer ' + SERVICE_KEY,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation',
      },
      body: JSON.stringify({
        status: 'archived',
        deactivated_at: new Date().toISOString(),
        deactivation_reason: 'Replaced by V2 workflow templates',
      }),
    },
  )

  if (archiveRes.ok) {
    const archived = await archiveRes.json()
    console.log('  Archived ' + archived.length + ' existing templates')
  } else {
    console.log('  No existing templates to archive (or error: ' + archiveRes.status + ')')
  }

  // 2. Insert new templates
  console.log('')
  console.log('Inserting ' + templates.length + ' new workflow templates...')
  console.log('')

  let successCount = 0
  let errorCount = 0

  for (const template of templates) {
    const res = await fetch(
      SUPABASE_URL + '/rest/v1/playbooks',
      {
        method: 'POST',
        headers: {
          'apikey': SERVICE_KEY,
          'Authorization': 'Bearer ' + SERVICE_KEY,
          'Content-Type': 'application/json',
          'Prefer': 'return=representation',
        },
        body: JSON.stringify(template),
      },
    )

    if (res.ok) {
      const data = await res.json()
      const id = Array.isArray(data) ? data[0]?.id : data.id
      console.log('  ✓ [' + template.priority.toUpperCase() + '] ' + template.title + ' (' + (template.steps?.length || 0) + ' steps) — id: ' + (id || '?'))
      successCount++
    } else {
      const err = await res.text()
      console.error('  ✗ ' + template.title + ': ' + res.status + ' ' + err)
      errorCount++
    }
  }

  console.log('')
  console.log('=== Done! ===')
  console.log('  Success: ' + successCount + '/' + templates.length)
  if (errorCount > 0) {
    console.log('  Errors: ' + errorCount)
  }
}

main().catch(console.error)
