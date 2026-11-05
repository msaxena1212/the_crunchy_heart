# Migration plan: Neon → AWS (RDS PostgreSQL)

Target: AWS hosts the API and database; the domain stays at Hostinger (DNS only).

## Status

- [x] Application DB driver switched to standard `pg` (`server/src/db/pool.js`). No code path depends on Neon any more.
- [x] Optional RDS CA verification via `DATABASE_SSL_CA_PATH`.
- [ ] Choose AWS region, RDS instance class, and API runtime (see open decisions).
- [ ] Create RDS PostgreSQL instance (private subnet, encryption at rest, automated backups, force SSL).
- [ ] Export from Neon (read-only) with `pg_dump --format=custom --no-owner --no-acl`.
- [ ] Restore into RDS and compare schema and row counts against Neon.
- [ ] Freeze writes (maintenance window), take a final delta dump, restore it, then switch `DATABASE_URL`.
- [ ] Keep Neon read-only for a rollback window, then delete after sign-off.

## Cutover steps (summary)

1. Run `npm test` with the local test DB (must stay green).
2. `pg_dump` from Neon into `database/backups/` (git-ignored). Never run DDL against Neon from scripts.
3. `pg_restore` into RDS. Apply `database/migrations/add_payment_reconciliation_queue.sql` only if not already in the dump.
4. Set `DATABASE_URL` (RDS, `sslmode=verify-full`) and `DATABASE_SSL_CA_PATH` in the API environment.
5. Smoke test: `GET /api/health`, product list, a test order in Cashfree sandbox, admin login.
6. Point the domain's `api.` record at the API host.

## Open decisions

- AWS region (closest to India customers: `ap-south-1` Mumbai).
- API runtime: App Runner (simplest), ECS Fargate, or EC2.
- Frontend hosting: AWS S3 + CloudFront (or served directly via Nginx on the EC2 instance alongside the API).
- Whether to remove `@neondatabase/serverless` from `server/package.json` after cutover.
- Neon scripts (`dump-neon.mjs`, `inspect-neon.mjs`) are one-off tools and can be removed after cutover.
