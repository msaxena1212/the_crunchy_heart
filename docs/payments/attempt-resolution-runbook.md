# Payment attempt resolution runbook

Scope: orders whose payment attempt is unresolved, in conflict, or left over from before the
durable create lifecycle. Use this runbook before any manual change to a payment record.

Nothing here creates a provider order, marks an order paid, or issues a refund.

## 1. Vocabulary

| State (payments.gateway_status) | Meaning | Action |
|---|---|---|
| `ATTEMPT_INITIATED` | Sent to Cashfree, outcome unknown, lease not yet expired | Wait. The retry path converts it after the lease. |
| `GATEWAY_AMBIGUOUS_TIMEOUT` | Outcome unknown after the lease or a timeout | Lookup, then reconcile, then close only if confirmed absent |
| `CASHFREE_PENDING` with no provider id | Legacy row from before the lifecycle fix | Lookup by order number, then close only if confirmed absent |
| `ORDER_CREATED` (two or more live sessions) | Order conflict | Escalate. Do not act on either session alone. |
| `CREATE_NOT_SUBMITTED` / `CREATION_REJECTED` | No provider order exists | No action needed |

Order-level states shown in order details (`paymentState`):

- `PAID`: a verified payment exists. The order returns no payment session.
- `CONFLICT`: two live sessions. Checkout is refused with `PAYMENT_STATE_CONFLICT`.
- `UNRESOLVED`: an attempt needs review. A retry is refused, and the order shows no retry button.
- `RESUMABLE`: one live session. The customer can resume it.
- `NO_LIVE`: no live session. A retry is allowed.

## 2. Endpoints

All endpoints need an authenticated administrator session (`/api/admin`). The service also
checks for an active `ADMIN` account.

| Method and path | Purpose | Changes state |
|---|---|---|
| `GET /api/admin/payment-attempts/review?limit=50` | List attempts to review, and orders in conflict | No |
| `POST /api/admin/payment-attempts/:paymentId/lookup` | Provider lookup. Attaches a session only if the provider returns the same order with one | Only on success |
| `POST /api/admin/payment-attempts/:paymentId/reconcile` | Runs the verified reconciliation for one attempt | Only on verified provider evidence |
| `POST /api/admin/payment-attempts/:paymentId/close-not-submitted` | Closes an attempt after a fresh 404 and an attestation | Yes, to `CREATE_NOT_SUBMITTED` |

Request body for close: `{ "confirmation": "ABSENT_IN_PROVIDER_DASHBOARD", "note": "<10 to 500 characters>" }`.

Every action writes one row to `admin_audit_logs` (`entity_type = payment_attempt`) with the
actor, the action, and the outcome. Responses contain identifiers and statuses only. Tokens,
sessions, and raw provider payloads are never returned.

## 3. Procedure

1. **Review.** Call the review endpoint. Note each `paymentId` and `orderNumber`.
2. **Lookup.** Call lookup for each attempt.
   - `ORDER_CREATED`: the session is attached. Check the order in the admin view. Done.
   - `RUN_RECONCILE`: the provider reports the order as paid. Go to step 3.
   - `INCONCLUSIVE` with `PROVIDER_ORDER_NOT_FOUND`: go to step 4.
   - `INCONCLUSIVE` with any other reason: do not close. Retry the lookup later, or escalate.
3. **Reconcile.** Call reconcile. It records payment only from provider payment evidence.
   If the result is not reconciled, do not mark the order paid by hand.
4. **Confirm absence before closing.** Open the Cashfree dashboard for the merchant. Search
   for the order number (for legacy rows, the order number; otherwise the stored provider
   order id). Only if the order is absent there:
   - Call close with the confirmation value and a note describing the check, including the
     date and the search term used. The note is stored permanently in the audit log.
   - The server repeats the lookup before it closes. If the provider now returns the order,
     the close is refused with `PROVIDER_ORDER_EXISTS`.
5. **Verify.** Reload the order details. `paymentState` should now be `NO_LIVE` or `RESUMABLE`,
   and `canRetry` should match. Do not create a new attempt by hand.

## 4. Refusals and what they mean

| Code | Meaning | What to do |
|---|---|---|
| `FORBIDDEN` / `AUTH_REQUIRED` | The caller is not an active administrator | Check the account |
| `INVALID_TRANSITION` | The attempt is not in a state that action accepts | Re-run the review. Do not force it. |
| `STATE_CHANGED` | Another action or request changed the attempt first | Re-run the review |
| `PROVIDER_ORDER_EXISTS` | The provider holds the order | Use lookup, not close |
| `LOOKUP_INCONCLUSIVE` | The provider could not answer | Try again later. Never close on this. |
| `CONFIRMATION_REQUIRED` / `NOTE_REQUIRED` | The attestation is missing or too short | Complete the dashboard check first |
| `PAYMENT_STATE_CONFLICT` (checkout) | Two live sessions on one order | Escalate. Do not pick a session. |

## 5. Hard rules

- Never close an attempt on a 404 alone. A 404 is inconclusive, and the attestation is required.
- Never mark an order paid or refunded from a dashboard screenshot or a message. Payment is
  recorded only through reconciliation, which checks provider payment evidence.
- Never create a provider order by hand. The customer retries through checkout, and only
  after the attempt is closed or the order is resolved.
- Record the note as you would a bank reconciliation note. It is the only evidence kept for a
  closed attempt.

## 6. Limits

- Lookups use the merchant `order_id`. Cashfree documents a 404 only as a generic "Resource Not
  found", so a 404 is treated as inconclusive, not as proof of absence.
- The dashboard check is a human control. Automated checks cannot replace it until the
  provider's duplicate-order behaviour is verified against the live sandbox.
- No worker resolves these attempts automatically while the reconciliation worker is disabled.
  Until it is enabled by a deployment decision, every unresolved attempt needs this runbook.
