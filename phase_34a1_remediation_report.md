# The Crunchy Heart — Phase 3.4A.1: Critical Preflight Remediation Report

```
Date: 2026-10-23T13:08:30+05:30
Execution Environment: Local Developer Machine (Windows)
Database Target: postgresql://postgres:postgres@127.0.0.1:5432/crunchy_heart_test
Status: COMPLETE (All remediations active and verified)
```

---

## 1. Executive Summary & Verification Verdict

### Remediation Status: **PASSED (Local Blockers Resolved)**

All three code-level preflight blockers identified in `phase_34a_local_preflight_report.md` have been resolved cleanly with zero regressions:
1. **Independent Secret Validation (P1)**: Production startup now strictly requires independent, non-identical, and cryptographically long ($\ge$ 32 characters) secrets for both `ORDER_TOKEN_SECRET` and `OWNER_SESSION_SECRET`. The fallback between them in `env.js` has been removed.
2. **Reconciliation Database Safety Guard (P2)**: `assertSafeDatabaseUrl()` now scopes test database restrictions to `NODE_ENV === 'test'` (enforcing local `crunchy_heart_test` on `127.0.0.1` / `localhost`), while safely validating production PostgreSQL connection URLs without categorically banning the legitimate cloud provider (Neon).
3. **Storefront API URL Sanitization (P1)**: Hardcoded references to external third-party hosts (`onrender.com`) have been removed from `product.service.ts`. The client now resolves via runtime injection (`__API_BASE_URL__`), local development detection, or same-origin default (`/api`).

**Verification Summary:**
- **Backend Test Suites:** 7/7 suites passed (**128/128 tests pass**, 0 fail, 0 skipped).
- **Storefront Compilation:** Angular production build succeeded with **0 errors, 0 warnings** in 28.31 seconds.
- **Safety Boundaries:** 100% maintained. Zero connection to live Neon, zero Cashfree live API calls, zero database migrations, zero owner accounts provisioned, zero deployment actions taken.

---

## 2. Files Inspected and Changed

| File Path | Type | Nature of Modification & Safety Rationale |
| :--- | :--- | :--- |
| [`server/src/config/env.js`](file:///e:/The%20Crunchy%20Heart/server/src/config/env.js) | Core Config | Removed silent fallback of `OWNER_SESSION_SECRET` to `ORDER_TOKEN_SECRET`. Added `validateSecrets()` and startup evaluation under `NODE_ENV === 'production'`. Fails fast before incoming requests are accepted. |
| [`server/src/services/reconciliation.service.js`](file:///e:/The%20Crunchy%20Heart/server/src/services/reconciliation.service.js) | Service | Updated `assertSafeDatabaseUrl(databaseUrl, executionEnv)` to distinguish test isolation (strictly local `crunchy_heart_test`) from production validation (syntactic PostgreSQL check without banning `neon.tech`). |
| [`client/src/app/product.service.ts`](file:///e:/The%20Crunchy%20Heart/client/src/app/product.service.ts) | Storefront Service | Removed hardcoded `onrender.com` guess from `getApiBaseUrl()`. Preserved local development routing and runtime `window.__API_BASE_URL__` override. |
| [`server/package.json`](file:///e:/The%20Crunchy%20Heart/server/package.json) | Package Config | Added `node --test test/preflight-remediation.test.js` to the root `npm test` script. |
| [`server/test/preflight-remediation.test.js`](file:///e:/The%20Crunchy%20Heart/server/test/preflight-remediation.test.js) | Test Suite | New automated test suite with 18 unit tests validating secret checks, database safety guards, and storefront base URL resolution. |

---

## 3. Secret-Validation Behavior (Production vs. Test)

### Production Mode (`NODE_ENV === 'production'`)
- Evaluated synchronously at application boot when `env.js` is imported.
- Enforces that `ORDER_TOKEN_SECRET` and `OWNER_SESSION_SECRET` are both defined and non-empty.
- Enforces that both secrets are at least 32 characters long (`MINIMUM_SECRET_LENGTH = 32`).
- Enforces that the two secrets are **cryptographically distinct** (`orderSecret !== ownerSecret`).
- If any check fails, the process throws an explicit configuration error and halts before `server.js` starts listening.
- Secret values are **never printed, logged, or reflected** in error messages or stack traces.

### Test / Development Mode (`NODE_ENV !== 'production'`)
- Does not block process startup if secrets are omitted, ensuring lightweight local tools and unrelated test suites (e.g. `phase1-regression.test.js`) can boot smoothly.
- If a secret is provided, minimum-length and distinctness validations are still enforced.
- If an admin operation or guest token is requested without a configured secret, call-time checks in `admin-token.js` and `order-token.js` still fail closed with HTTP 500.

---

## 4. Reconciliation Database Safety Guard Behavior

### Implementation in `assertSafeDatabaseUrl(databaseUrl, executionEnv)`:
1. **Empty / Malformed URL Check:** In all environments, missing or non-PostgreSQL (`postgresql:` / `postgres:`) URLs throw `FATAL CONFIGURATION ERROR`.
2. **Test Environment (`executionEnv === 'test'`):**
   - Strictly enforces that the target hostname is local loopback (`127.0.0.1`, `localhost`, `::1`, `[::1]`).
   - Strictly enforces that the database name is `crunchy_heart_test`.
   - Any remote host (including `*.neon.tech`, `aws.neon.tech`, `staging-db.internal`) or mismatched database name immediately throws `FATAL SAFETY VIOLATION`.
   - Never allows `NODE_ENV=test` to connect to an external database.
3. **Non-Test Environments (`executionEnv === 'production' | 'staging' | 'development'`):**
   - Validates hostname presence, credentials structure, and database name.
   - Does **not** unconditionally ban `neon.tech` or `aws.neon.tech`, allowing legitimate production Neon instances to be reconciled once authorized.

---

## 5. Hosting Architecture & API Routing Audit

### Current Repository Evidence
- `netlify.toml`: Removed. Deployment is standardized exclusively on AWS (EC2 Nginx / CloudFront).
- `client/src/app/product.service.ts`: Hardcoded third-party hosts removed. Client resolves via runtime injection (`__API_BASE_URL__`), local dev (`localhost:5000`), or same-origin default (`/api`).
- `server/src/server.js`: Configures CORS with `credentials: true` for `CLIENT_URL`, `http://localhost:4200`, and `http://127.0.0.1:4200`. Sets Express `trust proxy` to `env.trustProxy`.
- `server/src/controllers/admin.controller.js`: Sets session cookie `tch_admin_session` with `sameSite: 'Lax'` and `secure: isProd`.

### Architectural Standardization (AWS)

#### Unified Origin via AWS EC2 Nginx Reverse Proxy (ACTIVE SPECIFICATION)
- **Architecture:** Both storefront and backend API share a single domain (e.g. `https://thecrunchyheart.com/` with Nginx serving Angular static assets from `dist/the-crunchy-heart/browser` and reverse-proxying `/api/*` to the Node.js backend on `127.0.0.1:5000`).
- **Cookie & Auth Behavior:** Complete compatibility. `SameSite=Lax` cookies are naturally transmitted on same-origin `/api` fetch calls without third-party cookie blocking.
- **CORS:** Unnecessary for API calls through the reverse proxy; eliminates preflight latency.
- **Reverse Proxy Hop Count:** Explicit and fixed (`TRUST_PROXY=1` behind Nginx).
- **Client Configuration:** Storefront uses default `getApiBaseUrl() === '/api'`.

### Recommendation
**Deploy using Option A** (or Netlify API rewrite proxying `/api/*` to the backend host). This preserves the existing hardened `SameSite=Lax`, `HttpOnly`, `Secure` cookie architecture and avoids third-party cookie breakage.

---

## 6. Rate-Limiting Scope & Operational Boundaries

- **Location:** [`server/src/controllers/admin.controller.js:L14-53`](file:///e:/The%20Crunchy%20Heart/server/src/controllers/admin.controller.js#L14-L53)
- **Configuration:** 5 maximum attempts within a 15-minute rolling window (`RATE_LIMIT_MAX_ATTEMPTS = 5`, `RATE_LIMIT_WINDOW_MS = 900000`).
- **Client IP Derivation:** Relies on `req.ip`, which is strictly governed by `app.set('trust proxy', env.trustProxy)`. Because `TRUST_PROXY` defaults to `false` and rejects blind `"true"`, client IP spoofing via injected `X-Forwarded-For` is prevented.
- **Scope & Limitations:**
  - State is held in an in-memory `Map()`.
  - Process restarts reset attempt counters.
  - In a horizontally scaled or multi-container environment (e.g. multiple Render instances), state is **not shared**.
- **Staging vs. Production Verdict:**
  - **Acceptable for single-instance staging and initial single-instance launch.**
  - Prior to multi-instance horizontal scaling, rate limiting should be externalized to Redis or managed at the edge WAF (e.g. Cloudflare Rate Limiting Rules).

---

## 7. Automated Test Results

All tests were executed against the isolated local test database (`crunchy_heart_test`).

### Backend Regression Suites (`npm test` in `server/`)
Command: `npm test`

```
1. Phase 1 Core Order, Payment & Inventory Correctness Suite
   File: test/phase1-regression.test.js
   Result: 12/12 pass (duration: ~7.08s)

2. Phase 1.1: Cashfree Webhook HTTP Integration Suite
   File: test/webhook-http.test.js
   Result: 10/10 pass (duration: ~30.12s)

3. Phase 2: Payment Attempt Lifecycle & Retry Safety Suite
   File: test/payment-retry.test.js
   Result: 23/23 pass (duration: ~4.72s)

4. Phase 2C: Payment Attempt Reconciliation Suite
   File: test/reconciliation.test.js
   Result: 20/20 pass (duration: ~1.87s)

5. Phase 3.2: Storefront Customer Checkout Acceptance Suite
   File: test/checkout-flow.test.js
   Result: 14/14 pass (duration: ~1.35s)

6. Phase 3.3: Minimum Secure Owner Operations Test Suite
   File: test/admin-operations.test.js
   Result: 31/31 pass (duration: ~5.67s)

7. Phase 3.4A.1: Preflight Remediation Suite (NEW)
   File: test/preflight-remediation.test.js
   Result: 18/18 pass (duration: ~0.45s)

TOTAL: 128 / 128 Tests Passed (100% Pass Rate across 7 suites)
Execution Result: Exit Code 0
```

### Storefront Production Build (`npm run build` in `client/`)
Command: `npm run build`
- **Output Directory:** `client/dist/the-crunchy-heart`
- **Initial Bundle Total:** 323.35 kB (Estimated transfer: 88.22 kB)
- **Status:** **Success (Exit Code 0)** in 28.31 seconds. Zero errors, zero warnings.

---

## 8. Remaining Preflight Issues & Decisions

| Issue | Severity | Status | Next Step |
| :--- | :---: | :---: | :--- |
| **Hosting Topology Decision** | **P1** | Documented & Prepared | Select Option A (unified proxy) or Option B (split origin + Netlify rewrite). Apply corresponding environment variables (`CLIENT_URL`, `TRUST_PROXY`). |
| **Phase 3.4B Live Neon Schema Inspection** | **P1** | Not Started (Awaiting User Authorization) | Perform read-only schema comparison between local `database/schema.sql` and live Neon database upon explicit authorization. |
| **Owner Provisioning in Production** | **P1** | Not Started (Awaiting Staging Walkthrough) | Provision initial store owner interactively via `npm run admin:create` once database is verified. |
| **Cashfree Sandbox Walkthrough** | **P1** | Planned (Checklist Ready) | Execute end-to-end browser walkthrough with Cashfree sandbox modal and real return redirects. |

---

## 9. Boundary Adherence Confirmation

We explicitly confirm that during Phase 3.4A.1:
- Zero connections were made to any production database or live Neon instance.
- Zero live Cashfree API calls or payment transactions were initiated.
- Zero owner accounts were provisioned.
- Zero database migrations or schema alterations were executed.
- Zero deployment scripts or DNS changes were triggered.
- All historical orders, fixtures, backups, user notes (`qq`), and untracked files remain intact and untouched.
