# THE CRUNCHY HEART — Complete Product Catalogue Expansion
## Document 13: Application Security & Data Isolation Audit

**Date**: November 18, 2026  
**Status**: Passed & Enforced across Backend & Database Layers

---

### 1. Procurement Data Privacy & Leak Prevention

- **Audit Objective**: Ensure competitor or customer inspection cannot expose internal supplier costs, landed costs, or margin structures.
- **Verification**:
  - `product_variants.cost_price` is excluded from all public SQL `SELECT` projections (`/api/products`, `/api/products/:slug`, `/api/categories`, `/api/checkout/preview`).
  - Table `supplier_price_history` is not referenced by any public router. Access is strictly isolated to authenticated Admin routers (`server/src/routes/admin.routes.js`).
  - Public JSON API responses were scanned: zero occurrences of `costPrice`, `supplier`, or margin metrics.

---

### 2. Authentication & Rate Limiting

1. **Admin Console Auth**:
   - Protected by `adminAuthGuard` (Angular frontend) and `authenticateAdmin` (Express middleware).
   - Session tokens use HMAC SHA-256 signatures with server-side expiration.
2. **Customer Mobile OTP**:
   - Endpoint: `/api/auth/customer/otp/request`
   - Enforces strict numeric phone regex (`/^[6-9]\d{9}$/`).
   - Rate limiting: Max 3 OTP requests per phone per 15 minutes.
   - Master test OTP is restricted to configured environments.

---

### 3. Payment Gateway & Idempotency Safeguards

- **Order Idempotency**:
  - `orders.idempotency_key` ensures a customer double-clicking "Confirm Order" never creates duplicate orders.
  - Fingerprint validation (`resolveIdempotencyKey`) ensures retry requests reuse the transaction key while changed carts generate fresh keys.
- **Cashfree PG Signature Verification**:
  - Webhooks from Cashfree are verified via raw request body HMAC-SHA256 signature against `CASHFREE_CLIENT_SECRET`.

---

### 4. Database Injection & Transactional Concurrency

- **Parameterized Queries**: 100% of SQL statements across `server/src/` use `$1, $2, ...` parameterized bindings via `pg.Pool.query`. Zero raw string concatenations.
- **Inventory Concurrency**:
  - Stock reservations and deductions execute inside `withTransaction` using `SELECT ... FOR UPDATE` row locks to prevent race conditions or overselling during traffic spikes.
