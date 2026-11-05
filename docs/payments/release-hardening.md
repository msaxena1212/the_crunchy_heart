# Post-audit release hardening

Status: code and isolated-test verification complete. **Not production-ready.** No
deployment, live provider call, production database change, or AWS provisioning has
occurred. Background workers remain disabled, and the refund adapter remains
disconnected.

## A. Canonical schema completeness

### Missing elements found and fixed

`database/schema.sql` could not build a fresh database. Its tables referenced
`admin_users`, which was defined only in the foundation upgrade script. It also
lacked the admin audit log, the store settings, the subcategories, the coupon
tables, and the order, order-item, and payment columns that the code uses. The
foundation script was the upgrade for the live Neon database, so a fresh install
from `schema.sql` alone could not run the application.

Fixed by composing the foundation DDL into the canonical schema, in one pass:

- `admin_users` and `admin_audit_logs` are placed before the reconciliation queue,
  which references them.
- The commerce DDL (subcategories, coupons and their rule tables, order, order-item,
  and payment columns, indexes, and the default store settings) is appended at the
  end, with the store-settings insert kept idempotent.
- Excluded: the two data backfills (`UPDATE product_variants`, `UPDATE order_items`).
  They change existing rows and belong to the upgrade history, not to a fresh build.

Also made re-runnable: the refund-orchestration migration now drops each named
constraint before adding it, so applying it twice is safe.

### Verification

- A fresh database built from `schema.sql` plus every migration was created.
- The full backend suite was run against that fresh database: **330 passing, 0
  failing** (historical: before the recovery and interruption suites were added; the current
  count is in section E). The original test database was renamed to `crunchy_heart_test_legacy`
  (kept as a rollback reference), and `crunchy_heart_test` was rebuilt from the
  canonical schema.
- `server/test/schema-fresh-build.test.js` runs static checks on every run: every
  table referenced by application SQL must be defined in the canonical schema, and
  every constraint addition in a migration must be guarded. With
  `SCHEMA_FRESH_BUILD=1` it also creates a disposable database, builds it from the
  schema and migrations, verifies required columns and indexes, and drops it.
  This was run: 4 of 4 passed.

## B. Checkout recovery and storefront key handling

### Storefront key lifecycle

`client/src/app/checkout/checkout.component.ts` generates a new idempotency key only
when the order-determining content changes: customer, shipping and billing fields,
payment method, notes, and the cart items (sorted). A re-render or an identical
retry keeps the key. A changed cart or address gets a new key, so it can never be
refused as a replay of an earlier, different order.

Verification: the TypeScript check passes, and the Angular production build succeeds
(exit 0). **Not verified:** runtime behaviour in a browser. No client unit test exists.

### Guest order recovery (lost checkout response)

The guest token is returned only in the checkout response. If that response is lost,
the guest has no token and no order number, so there was no recovery path.

Server-side contract (`server/src/services/order-recovery.service.js`):

1. `POST /api/orders/recovery/request` accepts an email address or a phone number.
   It never accepts an idempotency key or an order number.
2. The reply is always the same generic message. It never reveals whether an order
   exists, whether a code was sent, or why a later step failed.
3. If a recent order (24 hours, not cancelled) matches the email address, a six-digit
   code is generated and sent to the address on file. Only a keyed HMAC-SHA256 of the
   code is stored (key: `RECOVERY_CODE_SECRET`), bound to the challenge ID. A phone-only match creates no
   challenge, because no code can be delivered to a phone.
4. `POST /api/orders/recovery/verify` accepts the contact and the code. A correct
   code, unexpired, unconsumed, within five attempts, consumes the challenge and
   returns the order summary and a guest token for that one order.

Limits and safeguards:

- A challenge expires after 10 minutes, accepts 5 attempts, and is single-use.
- A contact may start at most 3 challenges per hour, and a client IP at most 20
  requests per hour. Verification attempts are limited to 10 per contact per 15
  minutes and 60 per IP per 15 minutes. All limits are enforced in the database, so
  they hold across instances and restarts (see section D).
- Code comparison is constant-time. The challenge row is locked, so two concurrent
  submissions of the correct code cannot both succeed.
- A failed attempt is counted and committed. (Found and fixed during testing: the
  counter was rolled back with the error, so the limit never applied.)
- A failed send consumes the challenge, so an undelivered code cannot be used.
- The sender is injectable. The default sender **fails closed** until customer email
  is configured.
- The reply and the logs never contain the code or the token. The
  request-processed log line carries the outcome only.

Tests: `server/test/order-recovery.test.js`, 22 tests. They cover generic replies,
hash-only storage, a verified token bound to one order, single-use codes, lockout
after five wrong attempts, expiry, rate limiting, cross-customer isolation,
phone-only matches, failed sends, concurrent verification, the rejection of an
idempotency key as an identifier, and the exact keys in the generic reply. Section
D lists the tests added in the pre-deployment gate.

## C. Stale payment-attempt recovery

Verified by `server/test/payment-attempt-recovery.test.js`, 7 tests:

- **Bounds:** the provider order-creation call is capped at 15 seconds
  (`CASHFREE_CREATE_TIMEOUT_MS`), and the stale-attempt lease is 120 seconds
  (`ATTEMPT_LEASE_MS`). A static test asserts the timeout is at most half the lease.
- **Delayed provider response:** a call that never answers is aborted at the bound.
  It is classified as ambiguous. The attempt is marked `GATEWAY_AMBIGUOUS_TIMEOUT`,
  and exactly one provider call is made. A retry makes no further provider call.
- **Process interruption:** an attempt stranded in `ATTEMPT_INITIATED` past the lease
  is moved to the ambiguous path, with no new provider order.
- **Concurrent retries on a stale attempt:** both receive 504, exactly one ambiguous
  row exists, and no provider order is created.
- **Reconciliation:** an interrupted attempt's session is recovered through the
  provider lookup, with no new provider order.
- **Reconciliation racing a new request:** the result is either a reused session or a
  504, and never a second provider order.
- **Terminal states:** a paid order cannot be retried (409). A fresh in-flight
  attempt is still refused (409) and is not converted to ambiguous.

Not verified: a real process kill (SIGKILL) between provider success and persistence.

## Migrations and rollback

Existing databases (for example Neon, which predates these migrations) must have the
following applied, in this order, after review:

1. `add_refund_orchestration.sql`: now re-runnable. Run its status pre-check first.
2. `add_reconciliation_claim_token.sql`, `add_reconciliation_retry_support.sql`,
   `add_operational_alerts.sql`, `add_order_idempotency_fingerprint.sql`,
   `add_order_recovery_challenges.sql`, and the reconciliation incidents and queue
   migrations if not already present.

Fresh installations need only `schema.sql`, which already contains all of them.

Rollback:

- `orders.idempotency_fingerprint` is nullable. Dropping it returns replay to the
  earlier, unchecked behaviour.
- `order_recovery_challenges` can be dropped. Recovery stops, and no order data is
  affected.
- No migration deletes financial history. A down-migration removes only the objects
  each migration added.

## D. Pre-deployment security and integration gate

Scope: guest order recovery made safe to expose (W1), a storefront recovery screen
(W2), and interruption, restore, and dependency checks (W3). Still no deployment, no
live Cashfree or refund call, no real email, no production database change, no AWS
provisioning, workers disabled, the refund adapter disconnected, and nothing committed.

### W1. Recovery security

- **Keyed codes.** Codes are stored as HMAC-SHA256 keyed with `RECOVERY_CODE_SECRET`,
  bound to the challenge ID. A plain SHA-256 cannot be brute-forced offline, because a
  six-digit code has only a million values.
- **Fail closed.** If the secret is missing or shorter than 32 characters, the
  request and verify endpoints return `503 RECOVERY_UNAVAILABLE` before any challenge
  is created or any code is sent.
- **Rotation.** Rotating the secret invalidates codes issued before the rotation. Those
  codes expire within 10 minutes anyway.
- **Database-backed limits.** Table `rate_limit_events` (migration
  `add_recovery_rate_limits.sql`) holds one row per counted attempt, keyed by SHA-256
  hashes of the contact and the IP. Each check runs under a per-key advisory lock, so
  parallel requests cannot exceed a limit. The limits survive restarts and work across
  instances.
- **Generic timing.** Every recovery reply takes at least 400 ms, whether or not an
  order matched.
- **Token scope.** The guest token returned by verification is bound to that one order
  and is verified against it only.
- **Logging.** Logs record the outcome only. The contact, code, and token are never
  logged.

Tests added to `server/test/order-recovery.test.js` (now 22 in total, all passing):

| Test | What it proves |
|---|---|
| 15 | Missing or short secret fails closed: no challenge, no send, no verification |
| 16 | The stored value is keyed; the public SHA-256 scheme does not reproduce it |
| 17 | Rotating the secret invalidates an earlier code |
| 18 | One client IP is limited across different contacts (21st request is rate limited, nothing sent) |
| 19 | Eight parallel requests for one contact send at most three codes |
| 20 | Twelve parallel wrong guesses record at most ten verification attempts |
| 21 | Matched and unmatched replies both take at least the minimum time |
| 22 | Logs contain no contact, six-digit code, or token |

Also existing: other customers' orders are not recoverable (test 8), and recovery
cannot start from an idempotency key or order number (test 12).

Open item: edge-level rate limiting (a reverse proxy or WAF) is not configured. The
application limits are the minimum.

### W2. Storefront recovery screen

- Route `/recover-order`. The email step calls `POST /api/orders/recovery/request`.
  The code step calls `POST /api/orders/recovery/verify`. Both send the contact in the
  body, never in the URL.
- On success the guest token is stored with the existing `saveGuestToken` and the page
  navigates to `/orders/<orderNumber>`. The URL carries the order number only.
- Every reply shows the generic message. A 401 shows the invalid-code message, a 503
  shows the unavailable message, and a network failure shows the connection message.
- `SingleFlight` blocks overlapping submissions. Buttons are disabled while a request is
  in flight.
- The order-confirmation page links to the screen from its "Order Access Restricted"
  state.

Verification:

- `client/tests/order-recovery.logic.test.ts`: 12 tests, all passing. The client has no
  test runner, so the file is compiled with the project's TypeScript and run with
  `node:test`. The command is in the file header. Includes a static check that the
  component never puts the code or token in a URL and never logs them.
- `tsc --noEmit -p tsconfig.app.json`: exit 0.
- `ng build` (with `NG_CLI_ANALYTICS=false --progress=false`): exit 0, "Application
  bundle generation complete" in 283.6 s, initial total 367.99 kB (97.59 kB transferred),
  output `client/dist/the-crunchy-heart`. Two earlier attempts stalled at "Building..."
  with no output; the cause was not identified. The run that finished had analytics
  disabled. A slow build is expected on this machine, so allow several minutes.

Not verified: the rendered page in a browser, and the full path from request to order
page against a running server. Both need the backend running with a configured secret
and a working sender. Email is not configured, so no code can be delivered yet.

Client tests now exist (see "Client test infrastructure" below), so the recovery
component is tested directly rather than through the logic module alone.

### Client test infrastructure

- **Runner:** Angular's `@angular/build:unit-test` builder with the `vitest` runner,
  configured as the `test` target in `client/angular.json`. The builder is marked
  experimental by Angular in version 20.3. The Vitest version is pinned to 3.2.7 because
  the builder's peer range is `^3.1.1`. The DOM is jsdom 26.1.0, so no browser is needed.
- **Dependencies added (dev only):** `vitest@3.2.7` and `jsdom@26.1.0`. The lockfile
  change is 65 packages added, none removed, and no existing package changed.
- **Command:** from `client/`, `npm test` (runs `ng test --watch=false`). It exits non-zero
  on any failure. Expect a long run: the build step alone took about five minutes here.
- **Config:** `client/tsconfig.spec.json` (spec files only, so the application build does
  not compile them).
- **Scope:** unit tests only. They run in jsdom with mocked services and a spied router.
  No browser integration test exists yet. The rendered page in a real browser is still
  unverified.

Tests:

- `src/app/recover-order/recover-order.component.spec.ts`: the real component and template.
  Covers email validation, the transition to the code step, generic replies, verification
  success and navigation, wrong, expired, and repeated codes, 503 and network errors,
  overlapping submissions (one request for a double click or double submit), token storage
  before navigation, no code or token in URLs or console output, and label, keyboard, and
  error-announcement basics.
- `src/app/recover-order/order-recovery.logic.spec.ts`: the pure validation and error
  mapping functions.
- `src/app/checkout/checkout.component.spec.ts`: idempotency key behaviour. The existing
  code is the specification. The key is kept while the submitted content is unchanged, and
  a new key is generated when items, quantities, the address, the payment method, or the
  notes change. Whitespace is ignored, and item order does not matter, because items are
  sorted. A duplicate submit while one is in flight sends one request. Two details that
  surprised the first draft of these tests, and are kept as they are:
  - The key generated on page load is replaced at the first submit, because the submitted
    content is recorded only then.
  - Changing a field and changing it back produces a new key, because the last submitted
    content differs.

Verification (this step, all run from the working tree):

- `cd client && npm test`: 43 passing, 0 failing, across 3 spec files.
- `cd client && node node_modules/typescript/bin/tsc --noEmit -p tsconfig.app.json`: exit 0.
- `cd client && node node_modules/@angular/cli/bin/ng.js build`: exit 0, bundle generation
  complete in 172.6 s.
- `cd server && npm test`: 365 passing, 0 failing, 1 skipped (the opt-in fresh-build
  check, which is a separate release check, not part of a normal run).
- `git diff --check`: clean.

Two test expectations in the first run were wrong, not the app. They were corrected to the
existing behaviour, as described above. One recovery test read the error text before the
DOM was updated. Those three failures are fixed, and the final run is the one reported.

### W3. Interruption, restore, and dependencies

- **Deterministic interruption.** `server/test/process-interruption.test.js` (3 tests,
  passing). A test-only trigger rejects the `ORDER_CREATED` write for one marked
  customer. The provider order is created, then the local write fails. The test checks
  that the attempt remains `ATTEMPT_INITIATED` and that no second provider order is
  created. Within the lease, a retry is refused (409). After the lease, the attempt
  becomes `GATEWAY_AMBIGUOUS_TIMEOUT` (504). Reconciliation then recovers the same
  provider order to `ORDER_CREATED`. The trigger is dropped right after the simulated
  interruption, and the function is dropped in the `after` hook.
  - Not covered: a real SIGKILL at that point. That needs a separate harness that kills
    a child process.
- **Backup and restore.** Verified against an isolated copy only:
  - `pg_dump -Fc` of `crunchy_heart_test` (PostgreSQL 18 client).
  - `pg_restore` into a new disposable database, `crunchy_heart_restore_check`.
  - Row counts compared for every public table: 38 tables, 1,934 rows in total, no
    mismatches.
  - The disposable database and the dump file were removed afterward.
  - Not done: a restore to any real environment, and no production database was touched.
- **Dependencies.** `npm audit --omit=dev` in `server/`: 0 vulnerabilities.
- **Shutdown on Linux and systemd.** Not verified. The shutdown behaviour was tested on
  Windows only. Signal delivery, the systemd stop timeout, and `KillMode` behaviour need
  a Linux host with the unit file before the first deployment.
- **Graceful-shutdown test stability.** Test 10 (a request during the drain) previously
  opened a new connection at the moment shutdown began. That connection could be reset
  before its bytes were read, which is the window described in
  `graceful-shutdown.js`. The test now sends the request on an established keep-alive
  socket. It passed three runs in a row. The window itself still exists for real
  connections; it is narrowed, not closed.

## Remaining release blockers

1. **Recovery email delivery is not configured.** The default sender fails closed, so
   recovery cannot yet reach customers. Configure customer email (sender, template, and
   secrets) through the secret manager, then test with a monitored mailbox.
2. **`RECOVERY_CODE_SECRET` must be set in the deployment secret store** (at least 32
   characters). It must never be committed. Without it, recovery is unavailable by design.
3. **Edge rate limiting** is not configured. The application limits hold, but a proxy
   or WAF limit is recommended before public exposure.
4. **Browser verification of the recovery screen** has not been done.
5. **Hard-kill recovery** (SIGKILL between provider success and persistence) is not
   tested live.
6. **Linux and systemd shutdown** is unverified (see W3).
7. **Cashfree duplicate-order semantics** are not verified. The design avoids relying
   on them.
8. **SMTP receipt, the deployment platform, and refund-status semantics** remain open,
   as recorded in `production-readiness.md`.
9. **Lost response for a logged-in or other customer** is covered only by the guest
   path above.

## Verification commands and results

- Historical (superseded by section E): `cd server && npm test`: 354 passing, 0 failing, across 24 suites (this includes the
  14 recovery tests, the 7 attempt-recovery tests, and the schema checks).
- `cd server && SCHEMA_FRESH_BUILD=1 node --test test/schema-fresh-build.test.js`: 4
  passing.
- Full suite against a fresh canonical-schema database: 330 passing, 0 failing (run
  before the recovery feature was added).
- `cd client && node node_modules/typescript/bin/tsc --noEmit -p tsconfig.app.json`:
  exit 0.
- `cd client && node node_modules/@angular/cli/bin/ng.js build`: exit 0.
- `git diff --check`: clean on the changed files.

## Changed files

- `database/schema.sql`: composed (admin tables, commerce DDL, recovery table, fingerprint column, guarded refund constraints).
- `database/migrations/add_refund_orchestration.sql`: re-runnable.
- `database/migrations/add_order_recovery_challenges.sql` (new).
- `server/src/services/order-recovery.service.js` (new).
- `server/src/controllers/order.controller.js`, `server/src/routes/order.routes.js`: recovery endpoints.
- `server/test/order-recovery.test.js` (new), `server/test/payment-attempt-recovery.test.js` (new), `server/test/schema-fresh-build.test.js` (new).
- `server/package.json`: suites registered.
- `client/src/app/checkout/checkout.component.ts`: key regeneration on content change.
- `docs/payments/release-hardening.md` (this document).

The scratch databases created during this work were removed. The renamed legacy test
database `crunchy_heart_test_legacy` is kept for rollback. Nothing was committed.

## E. Release rehearsal and operational checklist (phase 2)

Status terms: **verified** (run here), **simulated** (mocked or preloaded, not the real
platform), **not verified**, **missing** (no implementation in the repository).

### E1. Browser check of the recovery screen (verified, with limits)

Setup: the production build served locally, with a mock recovery API on a separate port. No
database, email, or payment provider was used. The browser pane was the built-in one.

Verified:
- Invalid email rejected with a visible alert (keyboard Enter).
- Valid email reaches the code step, with the generic reply shown.
- Wrong code: generic invalid-code message, stays on the code step, URL unchanged.
- Correct code: navigates to `/orders/REC-DEMO1` with no query string. The token is in
  session storage and not in the URL. The order page fetches the order with the guest
  header and renders it.
- Double submit: three clicks produced one request. During the request the button read
  "Sending code" and was disabled, and the input was disabled too.
- 503 and network failure each show their own visible message.
- At 375 px: no horizontal overflow, 16 px side gutter, 16 px input text (no iOS zoom on focus),
  50 px button height.

Finding (not changed, needs a decision): after the step changes to code entry, focus stays
on the document body. Keyboard and screen-reader users must Tab to the code field. Moving
focus into the code field after the step change is the usual fix.

Limits:
- The pane was intermittently not drawing (its window was hidden). Some input was therefore
  dispatched as DOM events (input events and click calls), not as pointer input. Keyboard
  input through the pane was real key events.
- Visual review by screenshot and the full keyboard tab order were not completed.
- The Cashfree SDK failed to load offline. This is expected here and does not affect the
  recovery screen.

### E2. OS-level hard kill on Windows (simulated provider, real process termination)

Method: the real server process was started with a Cashfree preload that records the provider
call and never answers. An online order was created. Once the provider call was recorded, the
process tree was killed with taskkill /F /T. The database was the local test database.

Result (the rehearsal script is in the session scratchpad, not in the repository):
- The killed request returned a connection reset, as expected.
- Durable state after the kill: the order was pending. Its payment row was CASHFREE_PENDING
  with no provider order id. One provider call had been recorded.
- A guest token was then obtained through the real recovery service, with a recording sender
  and no email. Restart and retry-payment followed. The retry returned 200, and a second
  provider call was recorded. A new ORDER_CREATED session was stored.

Finding, high severity (addressed in section F; this paragraph records the original finding): POST /api/orders/create calls Cashfree inside
the same request and writes no in-flight marker (ATTEMPT_INITIATED). Only the retry path
writes one. A process killed during creation therefore leaves a payment row that the retry
logic does not treat as in flight. After recovery, a retry creates a second provider order
for the same local order. The first provider order is then orphaned locally. Whether
Cashfree rejects or merges a duplicate order_id is not verified, so this report does not
claim that money moved twice.

Recommended fix (needs a decision and its own tests): write the in-flight marker before the
provider call on the create path, so the existing lease and reconciliation rules apply.
Alternatively, refuse retries while a CASHFREE_PENDING row without a provider id exists, and
reconcile first.

Not verified here:
- Linux SIGKILL and systemd stop behaviour. WSL is installed but has no Linux distribution.
  Installing one is a system change that needs approval.
- SIGTERM and SIGINT draining. On Windows these signals do not reach the process the way
  they do on Linux, so the graceful path was exercised only by the unit and integration
  tests (graceful-shutdown.test.js), which simulate it.
- The intermittent connection reset documented in section D, under real signal delivery.

### E3. Migration rehearsal on disposable databases (verified on PostgreSQL 18, local)

Verified:
- Two disposable databases were created with names owned by the run. One was built from
  database/schema.sql, then all 9 migrations were applied. The migrations were then applied a
  second time, with no error. This shows they are repeatable.
- Verified objects: 38 tables and 122 indexes. No required column, index, table, or check
  constraint is missing.
- The build was dumped with pg_dump -Fc and restored with pg_restore into the second
  database. Table, constraint, and index counts match, and row counts match for every table.
- Both disposable databases were dropped afterwards.
- The opt-in fresh-schema test was run explicitly: 4 tests, 4 passing, 0 skipped. It is a
  separate release gate and was not part of the npm test run.

Not verified: RDS itself (this was local PostgreSQL 18, not Amazon RDS), the RDS snapshot
procedure, and cross-version upgrade. The repository has no down-migrations. The rollback
path is therefore the symlink switch plus snapshot restore described in the AWS plan
(section 10), which has not been rehearsed.

### E4. Operational checklist

| Item | Status | Evidence and gap |
|---|---|---|
| Edge rate limiting for recovery and other public endpoints | missing | Application-level, database-backed limits exist for recovery only. No proxy or WAF configuration is in the repository, and the AWS plan does not specify one. Required before public exposure. |
| RECOVERY_CODE_SECRET | partly | Fails closed at request time (503). Production startup does not check it (src/config/env.js checks only ORDER_TOKEN_SECRET and OWNER_SESSION_SECRET). The env template now documents it with no value. Startup validation is recommended. |
| Secret rotation for recovery codes | verified (tests) | Test 17: codes issued before rotation fail. Only pending codes are affected, and they expire within 10 minutes. |
| HTTPS, security groups, IAM, private RDS | planned only | docs/deployment/aws-ec2-plan.md sections 5, 7, and 13. Nothing provisioned, nothing verified. |
| Backups and restore | partly verified | pg_dump and pg_restore into a disposable database matched (E3, and an earlier run on the test database). Scheduled backups and retention are not configured in the repository. |
| Logs, metrics, alerts | partly | Ops alert service and worker health route exist. Alert email is not configured. No metrics pipeline is in the repository. /api/health exists. |
| Alert delivery failure handling | tested (simulated) | ops-alert-email tests use an injected transport. Live SMTP is not verified. |
| Worker enablement controls | verified in code | Flags RECONCILIATION_WORKER_ENABLED, REFUND_WORKER_ENABLED, and OPS_ALERTS_ENABLED must each equal exactly "true". They are not listed in server/.env.example, so they should be documented there. |
| Multi-instance coordination | partly | Advisory locks guard sweeps, claim tokens guard queue items, and the recovery rate limits are database-backed. Not tested across two live instances. |
| Migration, rollback, post-deploy checks | rehearsed locally | E3. Order and snapshot are in the AWS plan (section 10). No down-migrations exist. |
| Guest token scope, expiry, storage | verified (tests) | Tokens are bound to one order and checked against it. Client lookup enforces expiry. The client keeps the token in session storage and also in local storage, a bearer credential readable by same-origin scripts. This is documented in client/src/app/checkout.service.ts. |
| Documentation consistency | corrected | Recovery hashing is now described as keyed HMAC-SHA256. Older test counts are marked as superseded. |

### E5. Blockers before the first isolated AWS rehearsal (updated)

1. Create-path duplicate provider order risk (E2). Addressed in section F; open items in F5.
2. Edge rate limiting is not configured (E4).
3. Production startup check for RECOVERY_CODE_SECRET is missing (E4).
4. Focus management on the recovery code step (E1). Accessibility gap.
5. Linux and systemd shutdown, and real SIGKILL, not run (E2).
6. Email delivery is not configured, and no approved test mailbox has been used.
7. Cashfree duplicate-order semantics are not verified. This also bears on item 1.
8. Worker flags are not in the env template, so the default-off state is not documented where deployers look.

## F. P0: Cashfree create-order crash safety (phase 3)

### F1. Root cause (verified before the fix)

`POST /api/orders/create` did three things in sequence:

1. `createOrder` committed the order and a payment row `CASHFREE_PENDING` with no provider id.
2. The controller called `POST /pg/orders` with the merchant `order_id` set to the order number.
3. It wrote the provider id and the session only after the response arrived.

A process killed between steps 2 and 3 left the row with no provider id and no in-flight
marker. The retry guards blocked only `ATTEMPT_INITIATED` and `GATEWAY_AMBIGUOUS_TIMEOUT`, so
this row did not block. The retry created `<order_number>-R1` as a second provider order.

Reproduced on Windows: the server was killed with `taskkill /F /T` while the provider call was
in flight. The durable state was one `CASHFREE_PENDING` row with no provider id. After
recovery and a retry, a second provider call was recorded. This is evidence of a duplicate
creation risk, not proof of a duplicate charge.

### F2. Design

The create row moves through these states (`payments.gateway_status`, no schema change):

| State | Meaning |
|---|---|
| `CREATE_PENDING` | Written with the order. No provider call has been made. |
| `ATTEMPT_INITIATED` | Claimed by the controller right before the provider call. Owned until its lease expires. |
| `ORDER_CREATED` | The provider confirmed the order and returned a session. |
| `GATEWAY_AMBIGUOUS_TIMEOUT` | The outcome is unknown. It blocks every new create until a lookup resolves it. |
| `CREATION_REJECTED` | The provider refused the request with a 4xx other than 409. No provider order exists. |
| `CREATE_NOT_SUBMITTED` | A retry closed a `CREATE_PENDING` row before any provider call. |

Rules:

- **Claim before contact.** The controller changes `CREATE_PENDING` to `ATTEMPT_INITIATED`
  with a conditional update. Only a successful claim may call Cashfree.
- **Close before contact.** A retry closes any `CREATE_PENDING` row inside its own
  transaction. The claim and the close are conditional on the same state, so only one of
  them can win. A retry that later fails rolls the close back.
- **Refusal versus unknown.** Only a 4xx other than 409 is a definitive refusal. Timeouts,
  network failures, 5xx responses, and success responses without a session are unknown. A 409
  `order_already_exists` means the provider holds the order, so it is resolved by lookup.
- **Lookup, never create.** Resolution uses `GET /pg/orders/{order_id}` with the merchant
  `order_id`. A 404 is inconclusive. A lookup result without a `payment_session_id` is not
  resumable, so the attempt stays blocked.
- **Conditional writes.** Storing a session, marking ambiguous, and marking rejected each
  apply only when the row is still in the state the writer expects. A stale owner cannot
  overwrite a session that reconciliation already stored.
- **Legacy rows.** A `CASHFREE_PENDING` row with no provider id, written before this change,
  blocks retries with `409 PAYMENT_RESOLUTION_REQUIRED`. Replaying the same checkout resolves it
  by lookup. The replay never creates an order.
- **Replay.** A replay of an existing order never calls the provider. It returns the stored
  session, or a retryable 409 while a create is in progress, or a 202 when the outcome is
  unknown.

Changed files: `server/src/services/payment-creation.service.js` (new),
`server/src/services/order.service.js` (create row state, retry close and legacy guard),
`server/src/controllers/order.controller.js` (claim, outcomes, replay),
`server/src/services/cashfree.service.js` (missing credentials carry a code, so they are
classified as definitive refusals because no network call was made).

### F3. Provider facts

Checked against Cashfree's official API reference on 2026-11-02:

- The merchant `order_id` must be unique for every create request. A duplicate returns
  `409`, `order_already_exists`, with the message "order with same id is already present".
- The optional `x-idempotency-key` header is documented as safe to retry after a failure or
  timeout with the same key. A different body with the same key returns `422`. The window for
  this guarantee is not documented. The fix does not rely on it.
- `GET /orders/{order_id}` takes the merchant `order_id`. Its 404 is documented only as a
  generic "Resource Not found". It is treated as inconclusive.

Unverified:

- Whether the lookup response always includes `payment_session_id`. The code requires it.
- Whether a duplicate `order_id` sometimes merges with the earlier order rather than failing.
  The fix never relies on that behaviour.
- The lifetime of an unpaid, expired order that is never resolved.

### F4. Tests and verification

- `server/test/payment-create-lifecycle.test.js` (new, 10 tests). The provider is mocked at
  the fetch boundary, and every create and lookup is counted per merchant `order_id`. Covered:
  a healthy create; an ambiguous timeout with a refused retry and a lookup that resolves it; a
  definitive 400 followed by a valid new attempt; two concurrent creates with one provider
  call; a replay and a retry while the call is in flight; a stale owner that cannot overwrite
  a stored session; a stale owner that can record its success while the outcome is still
  unknown; provider success followed by a persistence failure; a lookup that returns not found;
  and a legacy row that a replay resolves by lookup.
- `server/test/recovery-secret-startup.test.js` (new, 8 tests) for the production secret check.
- Existing suites rerun after the change: `checkout-idempotency-audit` 15 passing,
  `payment-retry` 23 passing, `payment-attempt-recovery` 7 passing, `process-interruption` 3
  passing, `reconciliation` 20 passing, `checkout-flow` 14 passing.
- Real process termination, Windows only: `taskkill /F /T` on the server during an in-flight
  provider call, followed by an aged-lease restart. The retry returned 504, the provider order
  count stayed at 1, and the row became `GATEWAY_AMBIGUOUS_TIMEOUT`. This is OS-level
  termination on Windows, not a Linux SIGKILL.

### F5. Limits and open items (block production until closed)

1. **Ambiguous orders need an operator when lookup returns 404.** They stay blocked until an
   operator decides. No operator tool exists yet. The reconciliation worker is disabled by
   design, so no automatic resolution runs.
2. **The replay path reads one payment row per order.** It picks one arbitrarily when an order
   has several. This was already the case before this change. It needs a fix before go-live.
3. **Legacy rows** written before this change block retries until a replay or an operator
   resolves them.
4. **Provider behaviour** in F3 remains unverified against the live sandbox. Nothing here was
   sent to Cashfree.
