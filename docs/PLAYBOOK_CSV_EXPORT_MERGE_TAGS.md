# Playbook CSV Export — API Contract & Merge-Tag Mapping

Chantier A — "activate playbook → preview targets → export CSV" flow. Lets a
CS team export the accounts targeted by a playbook (Payment Recovery, Renewal,
Critical Churn Risk, Onboarding, etc.) as a CSV ready to import into an
external email tool (Brevo, Mailchimp, Lemlist, ActiveCampaign, or any CSV-based
sequence tool), then mark the run as sent once confirmed on the ESP side.

## Endpoint

`supabase/functions/export-playbook-csv/index.ts`

### `POST /export-playbook-csv` — preview targets

```json
{ "playbook_id": "uuid", "preview": true }
```

```json
{
  "data": {
    "accounts_count": 42,
    "mrr_at_risk_cents": 1284500,
    "accounts": [
      { "id": "uuid", "display_name": "Acme Corp", "mrr_cents": 49900, "health_score": 28, "churn_risk_score": 75 }
    ]
  }
}
```

No CSV generated, no `playbook_runs` row recorded, no Stripe email resolution
(faster — used for the "preview" step of the UI flow before committing to an
export).

### `POST /export-playbook-csv` — export CSV

```json
{
  "playbook_id": "uuid",
  "include_email": true,
  "exclude_executed_within_days": 30
}
```

Response: `text/csv`, `Content-Disposition: attachment`. Resolves target
accounts the same way `playbook-execute` does (`_shared/playbook-targeting.ts`
— explicit account IDs, else `segment_id` → `segment_memberships`, then
`eligibility_criteria` filter), excludes accounts already covered by an
`executed` run of the same playbook within `exclude_executed_within_days`
(default 30 — anti-double-send), resolves emails from Stripe in transit
(never persisted — same Zero-PII path as `export-csv`), and records a
`playbook_runs` row with `status: 'exported'`.

### `PATCH /export-playbook-csv` — mark a run as executed

```json
{ "run_id": "uuid" }
```

```json
{ "success": true, "updated": true }
```

Calls the `mark_playbook_executed(p_run_id, p_organization_id, p_executed_by)`
RPC — atomic, idempotent (returns `updated: false` if the run doesn't exist,
belongs to another org, or isn't in `'exported'` status). This is what powers
the anti-double-send exclusion on the next export of the same playbook.

### `GET /export-playbook-csv?playbook_id=xxx` — run history

```json
{
  "data": {
    "runs": [
      {
        "id": "uuid",
        "target_label": "Payment Failure Recovery",
        "accounts_count": 42,
        "mrr_at_risk_cents": 1284500,
        "status": "exported",
        "exported_at": "2026-08-02T10:00:00Z",
        "executed_at": null
      }
    ]
  }
}
```

50 most recent runs, newest first. This is what the run-history list and
"Mark as executed" button (frontend) render from.

## CSV columns → merge tags

| CSV column | Merge tag equivalent (ESP import) | Source |
|---|---|---|
| `Company` | `{{company}}` | `accounts.display_name` |
| `Email` | `{{email}}` | Resolved from Stripe in transit — never stored |
| `Stripe ID` | `{{stripe_customer_id}}` | `accounts.stripe_customer_id` |
| `MRR (USD)` | `{{mrr}}` | `accounts.mrr_cents / 100` |
| `Amount Due (USD)` | `{{amount_due}}` | Oldest open/uncollectible invoice past due, if any |
| `Days Overdue` | `{{days_overdue}}` | `today - invoice.due_date` for that same invoice |
| `Health Score` | `{{health_score}}` | `accounts.health_score` |
| `Churn Risk` | `{{churn_risk}}` | `accounts.churn_risk_score` |

`Amount Due` / `Days Overdue` are blank when the account has no overdue
invoice (e.g. a Renewal or Onboarding playbook target, as opposed to Payment
Recovery).

**`invoice_url` is intentionally not included.** The `invoices` table only
stores `stripe_invoice_id` — there's no `hosted_invoice_url` column, and
constructing one reliably requires a live Stripe API call per invoice (the
same in-transit pattern already used for email resolution). For a V1 CSV
export column, that's an extra round-trip for a nice-to-have link rather than
a required field — deferred rather than faked with a guessed URL shape.

## Related

- `_shared/playbook-targeting.ts` — target account resolution, shared with `playbook-execute`.
- `_shared/csv-export-utils.ts` — Stripe email resolution, shared with `export-csv`.
- `playbook_runs` table (migrations `20260802000003`–`20260802000005`) — run tracking + anti-double-send.
- Playbook template content (English): `_shared/playbook-engine.ts` (`PLAYBOOK_TEMPLATES_V1`, simple single/dual-action templates, served live via `playbook-templates`) and `scripts/seed-playbook-templates.ts` (rich multi-step D+0/D+3/.../D+90 workflows — Payment Recovery, Renewal 90/60/30, Onboarding, Critical Churn, etc. — manually seeded per org, not served via an API endpoint).
