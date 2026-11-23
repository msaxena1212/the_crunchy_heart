# Launch checklist: payments and deployment

Status: **not ready to accept real payments.** The sandbox rehearsal has not run, because
the Cashfree sandbox credentials are not set in the environment. Everything else below is
checked against code, tests, or documentation, as noted.

Nothing here commits, deploys, provisions AWS, enables workers, sends email, or makes a live
payment or refund call.

## 1. Batch 2: configuration and rehearsal

### 1a. Configuration (checked in code and tests)

| Item | Result | Evidence |
|---|---|---|
| Production secrets required at startup | Yes. `ORDER_TOKEN_SECRET`, `OWNER_SESSION_SECRET`, and `RECOVERY_CODE_SECRET`, each at least 32 characters, pairwise distinct | `server/src/config/env.js`; `test/recovery-secret-startup.test.js` (8); `test/preflight-remediation.test.js` (18) |
| Workers disabled by default | Yes. Each flag must equal exactly `true` | `server/src/services/worker-registry.js`; `test/worker-registry.test.js` |
| Database TLS | Certificate verification when `DATABASE_SSL_CA_PATH` is set. Local tests use no TLS | `server/src/db/pool.js`; not verified against RDS |
| Health check | `/api/health` exists. Its checks are not tested in this batch | `server/src/server.js` |
| Secrets not printed | Startup errors name the variable only. Audit details never contain tokens or sessions | `test/recovery-secret-startup.test.js` (test 8); `test/payment-attempt-resolution.test.js` (test 2) |
| Recovery rate limits | Database-backed, per contact and per IP | `test/order-recovery.test.js` (tests 15 to 22) |

### 1b. Sandbox rehearsal (blocked)

Required variables, none of which are set in this environment: `CASHFREE_CLIENT_ID`,
`CASHFREE_CLIENT_SECRET`, `CASHFREE_ENVIRONMENT` (value `sandbox`), and `CASHFREE_WEBHOOK_URL`.
Also `server/.env` is absent.

| Rehearsal step | Live sandbox run | Covered by mocked tests |
|---|---|---|
| 1. Create a sandbox checkout | Blocked | `payment-create-lifecycle.test.js` (healthy create) |
| 2. Payment success through the webhook | Blocked. A customer must complete payment in the hosted page | `webhook-http.test.js` test 1 (signed webhook, mocked provider) |
| 3. Duplicate and out-of-order webhooks | Blocked | `webhook-http.test.js` tests 4, 7; `payment-retry.test.js` tests 14, 15, 18b |
| 4. Ambiguous create never triggers a blind second create | Blocked | `payment-create-lifecycle.test.js` tests 2, 5, 8 |
| 5. Failed or ambiguous payment is never shown as paid | Blocked | `payment-attempt-selection.test.js` tests 2, 13; `payment-attempt-resolution.test.js` test 7 |
| 6. Order and inventory are consistent | Blocked | `webhook-http.test.js` test 4; `payment-retry.test.js` tests 15, 18; `reconciliation.test.js` tests J, R |
| 7. Reconciliation works with workers disabled | Blocked. Operator path only | `payment-attempt-resolution.test.js`; `reconciliation.test.js` |

The mocked tests confirm the logic against a simulated provider. They do not confirm
Cashfree's real behaviour. Steps 1 to 7 must be run against the sandbox before any real payment.

## 2. Batch 3: launch decision

### MUST FIX BEFORE ACCEPTING REAL PAYMENTS

1. **Run the sandbox rehearsal** (section 1b). Blocked on the four Cashfree variables.
2. **Confirm Cashfree behaviour that the design depends on:**
   - whether a lookup returns `payment_session_id` for every live order;
   - whether a duplicate `order_id` is rejected or merged;
   - what a 404 from the order lookup means in practice.
   The design treats all three conservatively. Each is still unverified against the live sandbox.
3. **Clear the existing payment queue.** Run the operator review endpoint against the
   production database (once it exists) and resolve every unresolved attempt and legacy
   `CASHFREE_PENDING` row using `docs/payments/attempt-resolution-runbook.md`. The count is unknown.
4. **Assign an owner for the review queue.** The reconciliation worker is disabled, so
   unresolved attempts are not resolved automatically.

### MUST VERIFY DURING DEPLOYMENT

1. **Database on RDS.** Connect with `DATABASE_SSL_CA_PATH` set and certificate verification
   on. Only local PostgreSQL 18 has been tested so far.
2. **Secrets in the secret store.** The three production secrets are set, pass startup
   validation, and are not in source control.
3. **Workers off** in the deployed environment. Confirm the three flags are unset.
4. **Migrations applied in order.** Fresh installs use `database/schema.sql`. Rehearsed
   locally only.
5. **Rollback.** The previous release plus a database snapshot restore. There are no
   down-migrations. Not rehearsed.
6. **HTTPS and reverse proxy.** Only the plan exists (`docs/deployment/aws-ec2-plan.md`).

### CAN FOLLOW AFTER LAUNCH

1. **Recovery email.** Until it is configured, recovery fails closed. Customers who lose a
   checkout response use the operator path.
2. **Edge rate limiting.** Application-level limits exist.
3. **Full keyboard and screen-reader pass** on the recovery screen. Focus moves to the code
   field in code; a browser check of tab order is still pending.
4. **Linux and systemd shutdown.** Not verified. Needed only if the deployment architecture
   depends on it.
5. **Optional alerting, 3D product views, and visual polish.**

## 3. Verification record

| Check | Result |
|---|---|
| Full backend suite | exit 0: 416 tests, 415 passing, 0 failing, 1 skipped (opt-in fresh-schema) |
| Fresh-schema check | exit 0: 4 passing |
| Whitespace | `git diff --check` exit 0 |
| Client tests, TypeScript, production build | Last run in the previous batch: 45 passing, exit 0, exit 0. No client code changed since. |

## 4. Status update, 23 Nov 2026

### Done since the sections above were written
- Neon staging and production schemas brought up to date from `database/schema.sql` (backup branches
  `staging-backup-before-schema-sync` and `production-backup-before-schema-sync` hold the earlier state; delete them once
  you are satisfied). Production data was not changed. Production still has its own 42-product catalogue and 1 test order;
  staging has the full 59-product catalogue and images.
- Staging also has the image migration (`add_missing_product_images.sql`) and coupon phone migration applied.
- Orders now hold stock for 15 minutes (online) and COD orders can be cancelled until dispatch. **Set
  `INVENTORY_HOLD_WORKER_ENABLED=true` in production**, otherwise abandoned checkouts keep stock reserved.
- FSSAI number is set in Admin > Settings (nothing is shown until you save it).
- Coupons work at checkout and are managed in Admin > Offers & coupons.
- GST is charged on the discounted price (coupons and the festive combo discount).
- Product images exist for every product. 18 are generated illustrations, not photographs.

### Still blocking launch
1. **OTP login**: the `111111` master code and mock SMS sender are still live. Do not launch before replacing them.
2. **Cashfree sandbox rehearsal** (section 1b), then production keys.
3. **Email (SMTP)** for order recovery and ops alerts.
4. **Production catalogue**: decide whether production should receive the staging catalogue and images
   (`add_dry_fruits_and_spices.sql`, `add_missing_product_images.sql`) before go-live.
5. **Supplier prices**, real FSSAI number, real product photos.
6. **Secrets**: move `the-crunchy-heart-staging.pem` out of the project folder; set the three production secrets.
7. **CSP**: the nginx policy is report-only; switch to enforcing once staging shows no violations.
8. **Hosting**: choose AWS RDS or keep Neon and deploy using `deploy/README.md`; run the staging smoke test
   (`docs/catalogue-expansion/07_RELEASE_CHECKLIST.md`).
