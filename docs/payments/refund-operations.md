# Refund and reconciliation operations

Status: **implemented and tested locally; not deployed.** The Cashfree refund
adapter is **not connected** to the refund worker. Refunds fail closed.

## Workers and flags

All background workers are **disabled by default**. A worker starts only when
its flag is exactly `true`.

| Flag | Starts | Notes |
|---|---|---|
| `RECONCILIATION_WORKER_ENABLED=true` | Payment reconciliation sweep (settlement retry) | Advisory lock `738412019` |
| `REFUND_WORKER_ENABLED=true` | Refund sweep (provider lookup, approved submission) | Advisory lock `738412020`. Provider is fail-closed, so approved refunds end in manual review |
| `OPS_ALERTS_ENABLED=true` | Alert raising and email delivery | Advisory lock `738412021` |
| `WORKER_INTERVAL_MS` | Tick interval for reconciliation and refund workers | Default `60000` |
| `OPS_ALERTS_INTERVAL_MS` | Alert evaluation interval | Default `60000`. Integer from 5000 to 86400000. Invalid values stop startup |
| `REFUND_ALERT_PENDING_MINUTES` | Age after which a pending refund raises an alert | Default `60` |

Anything other than the exact string `true` (for example `TRUE` or `1`) leaves a
worker off. The alert worker ignores `WORKER_INTERVAL_MS`, so changing the shared
interval never changes how often alerts are evaluated.

Each worker runs at most once at a time inside a process. Across instances, the
advisory lock lets only one run a sweep at a time. Item-level correctness still
rests on the claim tokens and fencing in the services, not on the lock.

On `SIGINT` or `SIGTERM` the server stops scheduling, waits for in-flight runs,
and closes the database pool. This shutdown path has not been verified on the
deployment platform.

## Health

`GET /api/admin/workers/health` (requires an authenticated admin) returns, for
each worker, whether its flag is enabled, whether it has started, and the last
run's counts and error. It also returns alert counts (`pending`, `failed`,
`undeliverable`, `delivered`). No secrets or payloads are included.

A worker that fails is logged at `[HIGH]` and retried on the next tick.
`consecutiveFailures` shows how many runs failed in a row.

## Retry budget and observation window

- A refund intent gets `max_attempts = 20`.
- Attempt 1 is the provider submission. Attempts 2 to 20 are provider lookups.
- Gaps between attempts grow exponentially from 30 seconds, with jitter, and are
  capped at 6 hours.
- Measured cumulative window: **about 31 to 63 hours** (from the minimum to the
  maximum of the jitter range) before the 20th attempt.
- The budget controls **escalation only**. It never authorises a new submission.

## Refund state transitions

| From | Trigger | To |
|---|---|---|
| `pending` | operator approval | `approved` |
| `approved` | submission returns SUCCEEDED | `refunded` |
| `approved` | submission returns PENDING, or fails ambiguously | `reconciliation_required` |
| `approved` | definitive provider rejection | `manual_review` |
| `reconciliation_required` | lookup returns SUCCEEDED | `refunded` |
| `reconciliation_required` | lookup returns FAILED or a permanent error | `manual_review` |
| `reconciliation_required` | lookup returns PENDING, not found, or a transient error | stays, backoff |
| `reconciliation_required` | attempts exhausted | `manual_review` |
| `processing` lease expired | worker died mid-call | `reconciliation_required` (never resubmitted) |
| `manual_review` | **late reconciliation** (lookup only) | `refunded` if the provider now reports success, otherwise unchanged |

Only a provider `SUCCEEDED` result moves a refund to `refunded`. Every transition
is fenced by a claim token, so a stale worker cannot overwrite a newer result.

## Operator actions

- `POST /api/admin/refunds/:id/approve`: any active administrator (session role
  `ADMIN`, and the admin row must still be active). Approval only authorises
  submission. It never completes a refund.
- `POST /api/admin/refunds/:id/reconcile`: any active administrator, for
  `reconciliation_required` only. It schedules a lookup. It never calls the
  provider itself.
- `POST /api/admin/refunds/:id/late-reconcile`: any active administrator, for
  `manual_review` only. It asks the provider what happened, is audited, and never
  submits a refund. Until the adapter is connected, it leaves the refund in
  `manual_review`.

## Alerts

- **Raised** once per refund per condition, enforced by a unique `alert_key`:
  - `REFUND_PENDING_OVERDUE`: a refund is still pending or processing past the threshold.
  - `REFUND_MANUAL_REVIEW`: a refund is in manual review.
- **Payloads** are allowlisted: refund ID, order ID, status, age in minutes,
  attempt counts, and a redacted last error. Provider payloads, idempotency keys,
  claim tokens, and secrets are never included.
- **Redaction** removes credential-like words and digit runs of nine or more
  characters from error text before it is stored or sent.
- **Email delivery** uses SMTP through nodemailer. Configure it with
  `OPS_ALERT_EMAIL_PROVIDER=smtp`, `OPS_ALERT_EMAIL_FROM`, `OPS_ALERT_EMAIL_TO`,
  `SMTP_HOST`, and `SMTP_PORT`. `SMTP_USER` and `SMTP_PASSWORD` are optional
  secrets, to be supplied only through the secret manager.
- **Acceptance:** a message is recorded as delivered only after the transport
  accepts it for at least one recipient.
- **Missing configuration:** alerts are still recorded and retried, and startup
  logs a `[HIGH]` line. Delivery stays unavailable until configured.
- **Retries:** a failed delivery is recorded, retried with backoff, and marked
  `undeliverable` after 10 attempts. Delivery never changes refund state.
- **Delivery is at least once.** A crash after sending but before recording can
  produce a duplicate. Recipients must tolerate that.
- **Not yet verified** against a live mailbox. Automated tests use a mock
  transport and never send real mail.

## Known limitations

- The Cashfree refund adapter is not connected. Its status semantics and HTTP
  behaviour are not fully verified. Sandbox simulations for `FAILED`, `PENDING`,
  and `ACTIVE` are still unresolved.
- Email delivery has not been verified against a live mailbox.
- Graceful shutdown has not been verified on the deployment platform.

## Local test database

All suites run against `crunchy_heart_test` on `127.0.0.1` only. They refuse to
run against Neon or any non-test database. Provider calls are mocked, and no
Cashfree endpoint is contacted by the automated tests.

## Deployment checklist (not performed)

1. Apply the migrations in `database/migrations/` in order to the approved target.
   Run the status pre-check in `add_refund_orchestration.sql` first.
2. Set the flags deliberately. Leave all of them off until each has been reviewed.
3. Configure SMTP through the secret manager, then send one controlled test to a
   monitored inbox.
4. Confirm `GET /api/admin/workers/health` shows the expected workers.
5. Keep the refund adapter disconnected until the sandbox results and provider
   retry semantics are confirmed.

See `production-readiness.md` for the go/no-go decision.
