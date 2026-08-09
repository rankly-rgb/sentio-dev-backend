# sentio-dev-backend
Sentio-dev-backend

## Dev scripts

### Seed: churn validation for PR #45 (`scripts/seed-churn-validation.ts`)

Creates a minimal Stripe test-mode dataset (via test clocks) to validate the
`mrr_movements` write path fixed in PR #45 end-to-end: a real dated churn
event, observable in `mrr_movements` and in the Churn Rate dashboard tile
after a `sync-stripe` run. Talks only to the Stripe API — no Supabase writes.

```bash
npm run seed:churn-validation -- --dry-run --seed   # preview, zero API calls
STRIPE_SEED_KEY=sk_test_... SEED_EXPECTED_ACCOUNT_ID=acct_... \
  npm run seed:churn-validation -- --seed            # create the dataset
STRIPE_SEED_KEY=sk_test_... SEED_EXPECTED_ACCOUNT_ID=acct_... \
  npm run seed:churn-validation -- --cleanup          # delete the test clocks
```

`SEED_EXPECTED_ACCOUNT_ID` is a required, blocking guard: 8 of the 11 dev
orgs (the `contactnsocialmediaonline` duplicates) share one real Stripe
test-mode account via the platform's `STRIPE_SECRET_KEY` fallback. This
script refuses to create anything unless the account reached by
`STRIPE_SEED_KEY` matches this expected `acct_...` exactly.

See the script's header docstring for the full rationale (why churn-only),
the exact dataset composition, and the manual `sync-stripe` step to run
afterwards (outside this script, against an org whose Stripe key is
distinct from the shared fallback).
