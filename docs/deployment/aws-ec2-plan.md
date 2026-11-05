# AWS EC2 deployment plan (preparation only)

Status: **planning document. Nothing has been provisioned.** No AWS resource,
DNS record, certificate, IAM role, or database has been created or changed. No
production data has been touched. This plan assumes the following are **not yet
decided or existing**: the EC2 instance, the RDS database, the VPC and subnets,
the domain, the TLS certificate, the IAM role, and the deployment platform
decision that the readiness review still lists as open.

Workers and refund execution stay **disabled** throughout the initial API
deployment (see section 9). The refund adapter remains disconnected.

## 1. Architecture

```
Customers --HTTPS--> Reverse proxy (nginx on EC2, TLS terminated)
                         |
                         v
                  Node.js API (Express, one process per instance, port 5000 on loopback)
                         |  TLS, verify-full
                         v
                  Amazon RDS for PostgreSQL (private subnet, not public)

Secrets: AWS Secrets Manager -> injected into the process environment at start.
Logs:    journald on EC2, optionally shipped to CloudWatch Logs.
```

## 2. Prerequisites to confirm before provisioning

| Item | Needed for | Status |
|---|---|---|
| AWS account, region (suggested `ap-south-1`) | All resources | Not confirmed |
| VPC with two private subnets and one public subnet | RDS and EC2 placement | Not confirmed |
| Domain (Hostinger DNS) and subdomain for the API, e.g. `api.<domain>` | HTTPS endpoint | Not confirmed |
| TLS certificate for the API hostname | HTTPS | Not confirmed |
| Deployment platform decision (EC2 confirmed; process supervisor choice below) | Shutdown and runbooks | Partly decided |
| SMTP provider and mailbox for alerts | Alert delivery | Not confirmed; verification deferred |
| Cashfree production credentials | Payments | Not in scope for this stage; must be provided through Secrets Manager only |

## 3. EC2 instance

- **Operating system:** a current Ubuntu LTS (confirm the exact release at build time).
- **Node.js:** an active LTS line that supports Express 5, pinned in the deployment
  artefact. The codebase has been tested locally on Node 18 and 22/26. Confirm the
  production choice and run the full test suite on that version before deploying.
- **Sizing:** start small (for example a 2 vCPU, 4 GiB instance). Measure before
  resizing. The API is I/O bound on the database.
- **Access:** no password SSH. Use AWS Systems Manager Session Manager, or SSH
  restricted to a named administrator address.
- **Patching:** unattended security updates on, with a defined maintenance window.

## 4. Application runtime and process supervision

- Install production dependencies only: `npm ci --omit=dev` inside `server/`, from
  the committed lockfile. Do not run `npm install` on the server.
- Start command: `node src/server.js` (the `start` script). `npm run dev` is for
  development only and must not be used in production.
- Supervise with **systemd** (recommended, no extra dependency):
  - `Restart=on-failure`, with a restart delay.
  - `KillSignal=SIGTERM` and `TimeoutStopSec` longer than the longest expected
    in-flight request. The server handles SIGTERM by stopping workers and closing
    the database pool (see section 8).
  - `User=` a non-root service account, with no login shell.
  - `EnvironmentFile=` pointing at a root-readable file written at boot from
    Secrets Manager (section 6). Do not keep secrets in the unit file.
- Keep **two release directories** (`releases/<version>` and `current` symlink)
  so rollback is a symlink switch (section 10).

## 5. HTTPS and reverse proxy

- **nginx** on the instance terminates TLS and forwards to `127.0.0.1:5000`.
- Redirect HTTP to HTTPS. Enable HSTS only after HTTPS is confirmed working.
- Set `TRUST_PROXY=1` (exactly one trusted hop). Never set `true`: the application
  rejects it, and it would allow client IP spoofing.
- Pass `X-Forwarded-Proto` so the application knows the request was secure.
  Admin session cookies are set `Secure` in production, so HTTPS must work before
  admin login is tested.
- Certificate: a managed certificate on an Application Load Balancer is an
  alternative to nginx TLS. Choose one. Do not run both.
- Enforce request body size limits in nginx. Set a sensible read timeout.

## 6. Secrets and environment

Load from **AWS Secrets Manager** at start. Never commit values, paste them in chat,
or print them in logs. The application refuses to start in production unless the
two session secrets are set, at least 32 characters, and distinct.

Non-secret variables (safe defaults in brackets):

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `PORT` | `5000` |
| `HOST` | `127.0.0.1` (loopback only; nginx is the only public entry point) |
| `CLIENT_URL` | the storefront origin, e.g. `https://<domain>` |
| `TRUST_PROXY` | `1` |
| `CASHFREE_ENVIRONMENT` | `sandbox` until production activation is approved |
| `CASHFREE_API_VERSION` | `2025-01-01` (the repository default); change only after review |
| `REFUND_WORKER_ENABLED` | `false` |
| `RECONCILIATION_WORKER_ENABLED` | `false` |
| `OPS_ALERTS_ENABLED` | `false` until SMTP verification is complete |
| `OPS_ALERTS_INTERVAL_MS` | `60000` |
| `DATABASE_SSL_CA_PATH` | path to the RDS CA bundle file on the instance |

Secret variables (from Secrets Manager only):

| Variable | Notes |
|---|---|
| `DATABASE_URL` | Connection string to RDS, with `sslmode=verify-full`. Includes the database user and password. |
| `ORDER_TOKEN_SECRET` | At least 32 characters. Distinct from the owner secret. |
| `OWNER_SESSION_SECRET` | At least 32 characters. Distinct from the order secret. |
| `CASHFREE_CLIENT_ID`, `CASHFREE_CLIENT_SECRET` | Sandbox credentials until activation is approved. |
| `SMTP_USER`, `SMTP_PASSWORD` | Only if the mail host requires login. |

Rotation: rotate session secrets with a planned logout for all admins. Rotate
database credentials with a dual-user method so the application can switch without
downtime.

## 7. RDS for PostgreSQL

- **Placement:** private subnets, **not publicly accessible**.
- **Security group:** inbound 5432 **only from the EC2 instance's security group**.
  No inbound from `0.0.0.0/0`.
- **Encryption:** at rest (KMS) and in transit. Force TLS
  (`rds.force_ssl=1`). The application connects with `sslmode=verify-full` and
  the RDS CA bundle, set through `DATABASE_SSL_CA_PATH`.
- **Engine version:** choose a supported PostgreSQL major version. Confirm that
  the SQL used by the migrations works on that version before creating the
  instance.
- **Connection pooling:** the `pg` pool defaults to 10 connections per process.
  Budget the RDS `max_connections` across instances and any administrative tool.
- **Credentials:** a dedicated application role with the minimum grants needed.
  A separate migration role should exist, used only during deployments.
- **Maintenance:** a defined window. Minor version upgrades applied deliberately.

## 8. Graceful shutdown

On SIGINT or SIGTERM the server (`server/src/services/graceful-shutdown.js`):
1. waits 200 ms (`ACCEPT_GRACE_MS`) so connections already waiting to be accepted are
   accepted and their request bytes read;
2. marks responses sent from now on with `Connection: close`, and stops accepting new
   connections;
3. waits for in-flight requests, up to `SHUTDOWN_DRAIN_TIMEOUT_MS` (default 25000,
   allowed range 1000 to 120000);
4. after 500 ms (`IDLE_CLOSE_GRACE_MS`), sweeps idle keep-alive connections, so a
   request already on the wire is read before its connection is closed;
5. after the drain deadline, force-closes remaining connections and logs `[HIGH]`;
6. stops background workers, then closes the database pool. Each step is bounded by
   the same timeout. A step that fails or hangs is logged as `[HIGH]`, and the pool is
   still closed if workers hang;
7. exits with 0 on success, or 1 if any step failed or timed out. A second signal
   during shutdown returns the same pending result and starts no second cleanup.

Verified locally with real HTTP connections (`test/graceful-shutdown.test.js`, 10
tests, five consecutive runs passed). **Not verified** on the deployment platform.
Windows cannot deliver SIGTERM to a process the way a service manager does, so the
platform-specific signal path must be tested in the chosen environment. Set systemd
`TimeoutStopSec` above the drain timeout plus worker and pool shutdown time.

**Limitation, not a guarantee.** Node closes idle sockets when the listener closes, and
a socket whose request has not been read counts as idle. The delays above reduce that
window. A request that arrives after the grace periods can still be dropped. In a
local experiment, five unread requests were all served with the 500 ms idle grace and
one of five was dropped with no grace. That sample is small, so treat the window as
reduced, not closed. A client that receives a connection reset with no response must
treat the request as unknown and retry. Retries are safe only for idempotent calls or
where the write path has an idempotency key. Payment and order-creation paths must be
tested for that before production; idempotency keys and claim fencing do not make
every interrupted request transparently retryable.

## 9. Health checks, logs, monitoring

- **Liveness and readiness:** `GET /api/health` (public). It reports database
  connectivity. Point the load balancer or nginx health check here.
- **Authenticated worker health:** `GET /api/admin/workers/health`. It requires an
  active administrator and must not be used for public probes.
- **Logs:** systemd journal. The application logs structured lines with a `[HIGH]`
  prefix for conditions that need attention. Ship them to CloudWatch Logs if
  central retention is required. Logs must never contain secrets, session tokens,
  or customer payloads. The application is written that way, but verify it with a
  log review before go-live.
- **Alarms to define** (not yet configured):
  - Application process down or restarting.
  - Health endpoint failing.
  - Database connections near the limit.
  - Any `[HIGH]` log line.
  - Undeliverable alerts or manual-review refunds, once alert delivery is verified.
- **Metrics:** CPU, memory, disk, and RDS storage and connection counts.

## 10. Deployment, rollback, and migrations

- **Order:** (1) take a manual RDS snapshot, (2) apply migrations with the migration
  role, after the status pre-checks in the migration headers, (3) deploy the new
  release directory, (4) switch the `current` symlink, (5) restart the service,
  (6) verify health.
- **Migrations are additive** (new tables, columns, and constraints). They are applied
  before the code that needs them. The new release must work with the previous schema
  until the switch is complete.
- **Rollback:** switch the `current` symlink back and restart. Do not run down-migrations
  against financial tables. Restore from a snapshot only as a last resort, after review.
- **Refund state during deploys:** claims left in `processing` expire and move to
  reconciliation. They are never resubmitted. Verify the sweep behaviour after any
  restart.

## 11. Multiple instances and scheduled work

- Start with **one** EC2 instance. Workers stay disabled.
- When workers are enabled later, they must run on **one designated instance**, not on
  every instance. Database advisory locks and claim-token fencing protect against
  overlapping runs, but they do not make parallel scheduling safe to rely on by default.
- Do not solve horizontal scaling by enabling workers on every instance.
- Before adding a second API instance behind a load balancer, confirm that:
  - the rate limiter for admin login is per-process (it is in memory). Note that a second
    instance halves its effective protection. Externalise it or enforce it at the edge first;
  - no other process-local state affects correctness.

## 12. Backups and isolated restore test

- **Automated backups:** enabled, with a retention period agreed with the business
  (for example 14 to 35 days), and point-in-time recovery turned on.
- **Manual snapshot** before every migration.
- **Restore test (never on production):**
  1. Restore the latest snapshot or point-in-time copy to a **new**, isolated RDS
     instance, in a separate security group.
  2. Connect with a read-only verification role.
  3. Compare row counts and key invariants (orders, payments, refunds, queue, audit)
     with the source.
  4. Record the result, then delete the test instance.
- Schedule the restore test, and treat a failed or never-run test as a blocker for
  production.

## 13. Security checklist (before go-live)

- [ ] No secrets in source control, the unit file, logs, or chat.
- [ ] RDS not publicly accessible; its security group allows only the application.
- [ ] Only ports 80 and 443 are open to the internet. SSH restricted or replaced by Session Manager.
- [ ] `TRUST_PROXY=1`; HTTPS verified; admin cookies `Secure`.
- [ ] Workers disabled; refund adapter disconnected.
- [ ] Production secrets distinct and at least 32 characters.
- [ ] `npm audit --omit=dev` reports no unresolved findings (last run: zero).
- [ ] Log review confirms no secret or payload leakage.

## 14. What remains before this can go live

1. Confirm the deployment platform choice and verify graceful shutdown on it.
2. Verify SMTP delivery to a monitored mailbox.
3. Confirm Cashfree status semantics for the unresolved simulations, or keep refunds
   disconnected.
4. Complete and record a restore test.
5. Decide on backup retention, alarm recipients, and the on-call process.
6. Obtain explicit approval for each stage above. None of these is performed by this
   document.
