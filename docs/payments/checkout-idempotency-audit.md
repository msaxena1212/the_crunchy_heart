# Checkout, payment, and idempotency safety audit

Status: audit completed locally against the isolated `crunchy_heart_test` database.
Provider calls were mocked at the global fetch boundary. No live Cashfree call, no
production database change, and no AWS change occurred. Workers stay disabled, and
the refund adapter stays disconnected.

## 1. Scenario results

| # | Scenario | Result | Evidence |
|---|---|---|---|
| 1 | Client retries order creation after no response, **without a key** | **Defect found, fixed.** Without a key the server created a second order. The server now rejects keyless checkout (400 `IDEMPOTENCY_KEY_REQUIRED`). The storefront always sends a key. | Test 1a. Reverting the fix makes it fail. |
| 1b | Malformed key | Defect found, fixed. Keys must be 8 to 100 letters, digits, hyphens, or underscores. | Test 1b. |
| 2 | Two concurrent requests with the same key | Safe. The unique index and the in-transaction re-check prevent a second order. The winner gets 201 and its token. The loser gets 409 without disclosure. | Test 2. |
| 3 | Same key reused with a different cart, quantity, customer, or amount | **Defect found, fixed.** The old order was returned silently. The server now stores a canonical request fingerprint. A mismatch is rejected with the same non-disclosing 409 an unauthenticated replay gets. | Tests 3a, 3b, and 3c. Disabling the check makes 3a and 3b fail. |
| 4 | Order committed, but the response was lost | Safe against duplicates. Recovery requires the guest token. Without it, the client has no way to recover its order. See open item A. | Test 4. |
| 5 | Cashfree creates the order, but the app times out before saving the result | Safe after fixes. A timeout is recorded as ambiguous and blocks new attempts. The provider call was unbounded, so it now has a 15-second timeout. | Test 5/10. |
| 6 | Same valid payment webhook delivered more than once | Safe. The second delivery returns `alreadySettled`, and stock is deducted once. | Test 6. |
| 7 | Webhook events for one payment arrive out of order (late FAILED after SUCCESS) | Safe. A terminal paid payment is not reversed. | Test 7. |
| 8 | Payment succeeds, but stock is insufficient or the ledger is inconsistent | Safe. The stock-exception path creates one refund intent, and an inconsistent ledger is queued. Covered by the refund-orchestration suite (17 to 19) and the retry suite. | Existing suites. |
| 9 | Shutdown begins during order creation, reservation, persistence, or settlement | Partly verified. In-flight requests drain. An order transaction that is cut off rolls back, and no provider call happens inside it. A payment attempt cut off mid-flight used to block the order forever. It now times out to the ambiguous path. A hard kill (SIGKILL) was not tested live. | Tests 9/12 and 9b. Shutdown suite. |
| 10 | Client retries after a timeout with an unknown outcome | Safe. Ambiguous attempts block new provider orders until reconciliation resolves them. Exactly one provider call is made. | Test 5/10. |
| 11 | Reconciliation worker loses its claim and then writes a stale result | Safe. Claim-token fencing is covered by the retry suite (14, 15) and the refund suite (15, 29). | Existing suites. |
| 12 | A transaction rolls back after an external checkout order was created | Safe for the order transaction. It makes no provider call. The attempt is committed first. A failure after the provider call used to leave the attempt stuck. It is now recovered through the stale-attempt path. | Test 9/12. |
| 13 | Keyless payment retry while an earlier session is still live | **Defect found, fixed.** A keyless retry could create a second payable session. A keyless retry now reuses a live session only while its recorded expiry is in the future. A keyless retry after expiry still creates a new session, as before. | Test 13, and the existing payment-retry test 2. |

## 2. Confirmed defects and minimal fixes

1. **Keyless order creation duplicates orders (scenario 1).** Fix: require a well-formed key on `POST /api/orders/create`.
2. **Reused key returns the wrong order (scenario 3).** Fix: `orders.idempotency_fingerprint` stores a SHA-256 of the canonical request. Replay with a different fingerprint is refused. The HTTP response is the same as an unauthenticated replay, so the response does not reveal that the key exists. Orders created before this change have a NULL fingerprint and keep the old replay behaviour.
3. **Attempt stuck in `ATTEMPT_INITIATED` blocks the order forever (scenarios 9 and 12).** Fix: an attempt older than `ATTEMPT_LEASE_MS` (120 seconds) moves to `GATEWAY_AMBIGUOUS_TIMEOUT`. Reconciliation resolves it, and no new provider order is created. A fresh in-flight attempt still returns 409.
4. **Provider call has no timeout (scenario 5).** Fix: `CASHFREE_CREATE_TIMEOUT_MS = 15000`, which is well below the lease.
5. **Keyless retry can create a second live session (scenario 13).** Fix: reuse a live session only while its expiry is in the future.

## 3. Migrations and schema

- `database/migrations/add_order_idempotency_fingerprint.sql` adds a nullable column. It is applied to the test database only, and it is also in `database/schema.sql`. It re-applies cleanly.
- **Finding, not fixed here:** the canonical `database/schema.sql` `orders` table lacks columns the code depends on (`idempotency_key`, `payment_method`, `tax_rate`, `price_includes_tax`). The fuller definition is in `database/the-crunchy-heart-ecommerce-foundation.sql`. A fresh install from `schema.sql` alone would not run the current code. This must be resolved before any deployment.

## 4. Tests

- `server/test/checkout-idempotency-audit.test.js`: 15 tests.
- Regression evidence: disabling the key requirement fails 1a. Disabling the fingerprint check fails 3a and 3b. Disabling the stale-attempt recovery fails 9/12. Each original was restored and verified byte for byte.
- The payment-retry suite was updated for the keyless behaviour, and it passes. Its test 2 (expired session replacement) and test 17 (unauthorised replay) both still pass.

## 5. Open items and residual risk

- **A. Lost response with no recovery path.** A client that loses the response to a successful create can only recover its order with the guest token, which that response carried. The OTP-based ownership path that the error message mentions is not built. This is a customer-facing gap.
- **B. Storefront key lifetime.** The storefront creates one key per checkout component. If the cart changes within the same page session, the same key is reused with different contents. The server now refuses that with 409, which is safer than the old silent replay, but the storefront should generate a new key when the cart changes. This UI change is not made here, because the client build could not be run in this environment.
- **C. Keyed payment retries can create a second live session.** A retry with a different key still creates a new attempt, which is intended for customers whose session expired. A customer who pays both sessions is handled by the sibling duplicate-capture flow, which creates a refund intent. This is not exactly-once. It depends on the refund workflow.
- **D. Provider-contract assumptions.** The behaviour of Cashfree when an order ID is submitted twice has not been verified. The design avoids relying on it, because an order ID is derived from the order number and attempt count.
- **E. Hard-kill recovery.** Recovery from SIGKILL between a provider success and its persistence depends on the stale-attempt path. It has not been exercised with a real process kill.

## 6. Changed files

- `server/src/services/order.service.js`: fingerprint, replay check, stale-attempt recovery, keyless session reuse, and the lease constant.
- `server/src/controllers/order.controller.js`: key required and validated, mismatch mapped to a non-disclosing response.
- `server/src/services/cashfree.service.js`: bounded provider timeout.
- `database/migrations/add_order_idempotency_fingerprint.sql` (new), and `database/schema.sql` (appended).
- `server/test/checkout-idempotency-audit.test.js` (new), and `server/package.json` (suite registered).
- This document.

## 7. Deployment implications

- Apply `add_order_idempotency_fingerprint.sql` before the new code is deployed. The column is nullable, so the migration is additive and safe to roll back by ignoring the column.
- Keyless checkout requests will fail after deployment (400). Confirm that every client sends a key first.
- Stuck attempts from before the deployment become ambiguous after the lease, and reconciliation must be running to resolve them.
