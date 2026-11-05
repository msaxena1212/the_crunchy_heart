# Production readiness: refund, reconciliation, and alerting

Status: **NOT READY for production refund activation.** Workers are disabled by
default, and the Cashfree refund adapter is **not connected** to the refund
worker. This document records what is verified, what is not, and what must be
decided first. It authorises nothing and does not deploy anything.

## 1. Verified controls (automated tests, isolated test database)

| Control | How it is verified |
|---|---|
| Refund intent is idempotent | Same key and same details return the existing refund. A conflicting key is rejected and the original is kept. |
| Over-refund prevention | Concurrent requests cannot exceed the paid amount (locks on the payment row). |
| Single submission | Ambiguous outcomes move to reconciliation. Lookups never resubmit. Tests assert zero second create calls. |
| Claim-token fencing | A stale worker cannot overwrite a newer owner's state (refund, reconciliation, and late-reconciliation paths). |
| Late success after escalation | Lookup-only reconciliation moves a manual-review refund to `refunded`. Tests assert no create call. |
| Authorization | Admin writes require an authenticated `ADMIN` session and an active `admin_users` row, checked on each request. Deactivated and non-admin sessions are refused. |
| Alerts persist and dedupe | One alert per refund per condition (unique key). Delivered alerts are not resent. |
| Delivery never changes refund state | Tests check refund status before and after failed and successful delivery. |
| Redaction | Payloads are allowlisted. Error text is redacted (credential words, long digit runs). |
| Scheduling defaults | Every worker is off unless its flag is exactly `true`. Alert interval defaults to 60000 ms. |
| Duplicate starts and overlap | One worker per name. A worker never overlaps itself. Advisory locks cover sweeps. |
| Health endpoint | Requires an authenticated admin. Returns worker state and alert counts. Verified against a live local server. |
| Health endpoint hardening | Also requires an active administrator record on each request. Worker error text is redacted. Tests 19 to 22 in admin-refund-api. |
| Dependency audit (production) | Nodemailer moved from 6.10.1 to 10.3.1. Every 6.x advisory had no 6.x fix. A non-forced fix cleared body-parser and qs. `npm audit --omit=dev` reports 0 vulnerabilities. Run on this checkout only. |
| Sandbox monitor reports | Append-only JSON lines, one per run, with timestamp, elapsed time, outcome, and sandbox references only. Written to a gitignored folder. Write failures are returned explicitly and exit non-zero. Tests 10 to 13. |
| Graceful shutdown (local) | Stops accepting connections, drains in-flight requests (sweeping idle keep-alive sockets), force-closes after a timeout with a [HIGH] log, then stops workers and closes the pool. Bounded worker and pool steps; exit code reflects failures. Tested with real HTTP connections, 10 tests, five consecutive runs passed. Unread-request window reduced by grace periods, not closed. Not yet verified on the deployment platform. |
| Monitor argument parsing | A `--max-hours` flag was previously parsed as an order ID. Fixed and tested. |

## 2. Remaining risks

| Severity | Risk | Mitigation before activation |
|---|---|---|
| **Blocker** | Cashfree refund semantics are unresolved. `ACTIVE`, `FAILED`, and `PENDING` simulations still report `PENDING` after hours. | Keep the adapter disconnected. Continue read-only monitoring (section 4). Obtain documented terminal-state guarantees. |
| **Blocker** | No alert channel has been validated against a real mailbox. | Configure SMTP through the secret manager. Send one controlled test to a monitored inbox and confirm receipt. |
| **High** | The late-reconciliation path has not been tested against a real provider. | Keep it fail-closed. Test lookups in sandbox first. |
| **High** | Graceful shutdown has not been verified on the deployment platform. | Test the actual termination mechanism once the platform is chosen. |
| **High** | Migrations have been applied only to the isolated test database. | Run the status pre-check before any real database. Plan rollback (section 5). |
| **Medium** | Alerts may be delivered twice if a crash occurs between sending and recording. | Accept at-least-once delivery. Recipients must tolerate a duplicate. |
| **Medium** | The health endpoint returns worker state to any authenticated admin. | Acceptable for the current single-role model. Review when roles are added. |
| **Medium** | If email is not configured, alerts are recorded but cannot be delivered. There is no log-only fallback. | Startup logs a `[HIGH]` line. Monitor the alert counts on the health endpoint. |
| **Low** | Test suites share one database. A failing run can leave rows that affect the next run. | Each suite cleans its own fixtures. Re-run the full suite after any failure. |

## 3. Configuration and secrets

Non-secret configuration (safe to document):

| Variable | Example | Notes |
|---|---|---|
| `OPS_ALERTS_ENABLED` | `false` | Must be exactly `true` to start alert evaluation. |
| `OPS_ALERTS_INTERVAL_MS` | `60000` | Integer, 5000 to 86400000. Invalid values stop startup. |
| `OPS_ALERT_EMAIL_PROVIDER` | `smtp` | Only `smtp` is supported. |
| `OPS_ALERT_EMAIL_FROM` | `alerts@example.com` | Approved sender address. |
| `OPS_ALERT_EMAIL_TO` | `ops@example.com` | One or more addresses, comma-separated. |
| `SMTP_HOST` | `smtp.example.com` | Provided by your mail host. |
| `SMTP_PORT` | `587` | Port 465 uses implicit TLS. |
| `REFUND_WORKER_ENABLED` | `false` | Keep off until refund activation is approved. |
| `RECONCILIATION_WORKER_ENABLED` | `false` | Keep off until activation is approved. |

Secret values (must come from the secret manager, never from source control, chat, or logs):

- `SMTP_USER` and `SMTP_PASSWORD`, if the mail host requires login.
- `CASHFREE_CLIENT_ID`, `CASHFREE_CLIENT_SECRET`, `OWNER_SESSION_SECRET`, and `ORDER_TOKEN_SECRET`.

The email configuration check (emailHealth) reports only the names of missing or invalid fields, never values. It is not yet exposed by any endpoint.

## 4. Read-only sandbox monitoring

The monitor is `server/src/scripts/sandbox-refund-status.mjs`. It issues GET
requests only, refuses non-sandbox configuration, and reports unresolved refunds
for escalation. Usage:

```
CASHFREE_ENVIRONMENT=sandbox CASHFREE_API_VERSION=2026-01-01 node src/scripts/sandbox-refund-status.mjs <orderId> [<orderId> ...] --max-checks=6 --interval-ms=60000
```

**Stopping limit.** Monitoring stops when every refund reaches a terminal status
(`SUCCESS`, `FAILED`, or `CANCELLED`), after `--max-checks`, or when the
wall-clock limit of **72 hours** (`--max-hours`, enforced by the script) is reached, whichever comes first. A refund still non-terminal at that point is
recorded as **unresolved** and escalated. It is never treated as success or
failure, and it is never resubmitted.

**Observation record** (UTC `2026-10-30T09:38:40Z`, two checks one minute apart,
read-only):

| Order | Refund note | Observed status | Classification |
|---|---|---|---|
| `SBXPAYXLVO11EM` | `SUCCESS` | `SUCCESS` ("Refund processed successfully") | Terminal success |
| `SBXACTIVEGCL9SO` | `ACTIVE` | `PENDING` ("In Progress") | Unresolved, escalated |
| `SBXFAILEDCBB2I7` | `FAILED` | `PENDING` ("In Progress") | Unresolved, escalated |
| `SBXPENDINGKM2LKC` | `PENDING` | `PENDING` ("In Progress") | Unresolved, escalated |

The three unresolved refunds were also `PENDING` in earlier observations. The
`FAILED` simulation has not produced a terminal failure, so the adapter must not
be connected on the assumption that it will.

## 4a. Explicit test email (not performed)

`server/src/scripts/send-test-alert-email.mjs` sends ONE synthetic alert to a
single approved test mailbox. It runs only when invoked by hand with
`OPS_ALERT_TEST_CONFIRM=SEND-ONE-TEST-EMAIL` and `OPS_ALERT_TEST_RECIPIENT` equal
to `OPS_ALERT_EMAIL_TO`. It never runs at startup or in tests, never touches the
database, and prints only the accepted-recipient count. **SMTP acceptance is not
inbox delivery.** Confirm receipt in the mailbox.

## 4b. Deployment preparation

`docs/deployment/aws-ec2-plan.md` describes the intended EC2, RDS, reverse-proxy, secrets, and restore-test setup. It provisions nothing and lists the prerequisites that are not yet confirmed.

## 5. Rollback and recovery

- **Migrations** are additive: new tables, columns, and constraints. Rolling
  back a migration removes new structures only after confirming that no rows
  depend on them. Financial history (refunds, payments, audit) is never deleted
  by a down-migration.
- **Workers** are stopped by unsetting their flags and restarting. Claims left
  mid-run expire and are moved to reconciliation. They are not resubmitted.
- **Alerts** can be cleared only by an operator after review. Deleting alert
  rows does not change refund state.
- **Refunds** in an unknown state are never repaired by hand. They are looked
  up, then escalated.

## 6. Verification still outstanding

- Live SMTP delivery and inbox receipt (not performed; needs SMTP settings, a test mailbox, and explicit approval).
- Live graceful-shutdown test on the chosen deployment platform.
- Sandbox resolution of `ACTIVE`, `FAILED`, and `PENDING`, or documented
  provider terminal-state semantics.
- Production database backup and restore test (procedure documented, not run).
- Deployment platform selection and its secret-management configuration.

## 7. Go/no-go

| Area | Decision |
|---|---|
| Authorization and audit | Go, for the current single-role model |
| Refund idempotency and fencing | Go, tested locally |
| Alerting persistence and redaction | Go, tested locally |
| Alert channel | **No-go** until a real delivery is confirmed |
| Refund submission | **No-go**: adapter disconnected, semantics unresolved |
| Worker activation | **No-go** outside controlled testing |
