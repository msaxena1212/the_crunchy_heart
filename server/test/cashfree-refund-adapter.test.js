/**
 * The Crunchy Heart - Cashfree Refund Adapter contract tests
 *
 * Every HTTP exchange is a mock. No Cashfree endpoint is contacted.
 * These tests pin the adapter's handling of the documented endpoints and of
 * ambiguous, malformed and mismatched responses. They do not prove live
 * provider behaviour; see the unverified list in cashfree-refund.adapter.js.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://postgres:postgres@127.0.0.1:5432/crunchy_heart_test';
process.env.CASHFREE_CLIENT_ID = 'TEST_ADAPTER_CLIENT_ID';
process.env.CASHFREE_CLIENT_SECRET = 'TEST_ADAPTER_CLIENT_SECRET_KEY_1234567890abcdef';
process.env.CASHFREE_ENVIRONMENT = 'sandbox';

const {
    createCashfreeRefundAdapter,
    deriveProviderRefundId,
    normalizeRefundStatus,
} = await import('../src/services/cashfree-refund.adapter.js');

// Scripted fetch: returns the next queued response, or throws if it is an Error.
function scriptedFetch(...responses) {
    const calls = [];
    const fetchImpl = async (url, init) => {
        calls.push({ url, init });
        const next = responses.shift();
        if (next instanceof Error) throw next;
        const { status = 200, body, raw } = next;
        return {
            status,
            async text() {
                if (raw !== undefined) return raw;
                return body === undefined ? '' : JSON.stringify(body);
            },
        };
    };
    return { fetchImpl, calls };
}

const KEY = 'refund:stock_shortage:pay-123';
const REFUND_ID = deriveProviderRefundId(KEY);

function refundBody(overrides = {}) {
    return {
        refund_id: REFUND_ID,
        cf_refund_id: 'CFRF-1',
        refund_amount: 100,
        refund_status: 'PENDING',
        order_id: 'TCH-ORD-1',
        ...overrides,
    };
}

describe('Cashfree refund adapter contract', () => {
    test('1. Refund id is alphanumeric, deterministic, and distinct per key', () => {
        assert.match(REFUND_ID, /^[A-Z0-9]+$/);
        assert.equal(deriveProviderRefundId(KEY), REFUND_ID);
        assert.notEqual(deriveProviderRefundId('refund:other'), REFUND_ID);
        assert.throws(() => deriveProviderRefundId(''), /refundKey is required/);
    });

    test('2. Status normalisation maps known values and leaves unknown as UNKNOWN', () => {
        assert.equal(normalizeRefundStatus('SUCCESS'), 'SUCCEEDED');
        assert.equal(normalizeRefundStatus('pending'), 'PENDING');
        assert.equal(normalizeRefundStatus('CANCELLED'), 'FAILED');
        assert.equal(normalizeRefundStatus('SOMETHING_NEW'), 'UNKNOWN');
        assert.equal(normalizeRefundStatus(undefined), 'UNKNOWN');
    });

    test('3. Successful creation posts the documented body to the order refunds endpoint', async () => {
        const { fetchImpl, calls } = scriptedFetch({ body: refundBody({ refund_status: 'SUCCESS' }) });
        const adapter = createCashfreeRefundAdapter({ fetchImpl });

        const result = await adapter.createRefund({ providerOrderId: 'TCH-ORD-1', refundKey: KEY, amount: 100, currency: 'INR' });

        assert.equal(result.status, 'SUCCEEDED');
        assert.equal(result.providerRefundId, 'CFRF-1');
        assert.equal(calls.length, 1);
        assert.equal(calls[0].init.method, 'POST');
        assert.match(calls[0].url, /\/pg\/orders\/TCH-ORD-1\/refunds$/);
        const body = JSON.parse(calls[0].init.body);
        assert.equal(body.refund_amount, 100);
        assert.equal(body.refund_id, REFUND_ID);
    });

    test('4. Retry that finds an existing refund returns it without a second refund identity', async () => {
        const { fetchImpl } = scriptedFetch({ body: refundBody({ refund_status: 'SUCCESS', cf_refund_id: 'CFRF-EXISTING' }) });
        const adapter = createCashfreeRefundAdapter({ fetchImpl });

        const result = await adapter.createRefund({ providerOrderId: 'TCH-ORD-1', refundKey: KEY, amount: 100 });

        assert.equal(result.providerRefundId, 'CFRF-EXISTING');
        assert.equal(result.status, 'SUCCEEDED');
    });

    test('5. Pending refund is reported as PENDING, never as success', async () => {
        const { fetchImpl } = scriptedFetch({ body: refundBody({ refund_status: 'PENDING' }) });
        const result = await createCashfreeRefundAdapter({ fetchImpl })
            .createRefund({ providerOrderId: 'TCH-ORD-1', refundKey: KEY, amount: 100 });
        assert.equal(result.status, 'PENDING');
    });

    test('6. Confirmed failure is reported as FAILED', async () => {
        const { fetchImpl } = scriptedFetch({ body: refundBody({ refund_status: 'CANCELLED' }) });
        const result = await createCashfreeRefundAdapter({ fetchImpl })
            .createRefund({ providerOrderId: 'TCH-ORD-1', refundKey: KEY, amount: 100 });
        assert.equal(result.status, 'FAILED');
    });

    test('7. Timeout after submission is ambiguous (not definitive)', async () => {
        const abort = new Error('aborted');
        abort.name = 'AbortError';
        const { fetchImpl } = scriptedFetch(abort);

        await assert.rejects(
            () => createCashfreeRefundAdapter({ fetchImpl })
                .createRefund({ providerOrderId: 'TCH-ORD-1', refundKey: KEY, amount: 100 }),
            (err) => err.code === 'ETIMEDOUT' && err.definitive !== true
        );
    });

    test('8. Network failure is ambiguous (not definitive)', async () => {
        const { fetchImpl } = scriptedFetch(new Error('socket hang up'));

        await assert.rejects(
            () => createCashfreeRefundAdapter({ fetchImpl })
                .createRefund({ providerOrderId: 'TCH-ORD-1', refundKey: KEY, amount: 100 }),
            (err) => err.code === 'NETWORK_ERROR' && err.definitive !== true
        );
    });

    test('9. Malformed 200 response is rejected as ambiguous', async () => {
        const { fetchImpl } = scriptedFetch({ raw: '<html>gateway</html>' });

        await assert.rejects(
            () => createCashfreeRefundAdapter({ fetchImpl })
                .createRefund({ providerOrderId: 'TCH-ORD-1', refundKey: KEY, amount: 100 }),
            (err) => err.code === 'MALFORMED_RESPONSE' && err.definitive !== true
        );
    });

    test('10. Mismatched refund identity is definitive and never accepted', async () => {
        const { fetchImpl } = scriptedFetch({ body: refundBody({ refund_id: 'SOMEOTHERID' }) });

        await assert.rejects(
            () => createCashfreeRefundAdapter({ fetchImpl })
                .createRefund({ providerOrderId: 'TCH-ORD-1', refundKey: KEY, amount: 100 }),
            (err) => err.code === 'IDENTITY_MISMATCH' && err.definitive === true
        );
    });

    test('11. Mismatched amount is definitive and never accepted', async () => {
        const { fetchImpl } = scriptedFetch({ body: refundBody({ refund_amount: 999 }) });

        await assert.rejects(
            () => createCashfreeRefundAdapter({ fetchImpl })
                .createRefund({ providerOrderId: 'TCH-ORD-1', refundKey: KEY, amount: 100 }),
            (err) => err.code === 'AMOUNT_MISMATCH' && err.definitive === true
        );
    });

    test('12. HTTP 400 is definitive; HTTP 503 is ambiguous', async () => {
        const rejected = scriptedFetch({ status: 400, body: { message: 'bad request' } });
        await assert.rejects(
            () => createCashfreeRefundAdapter({ fetchImpl: rejected.fetchImpl })
                .createRefund({ providerOrderId: 'TCH-ORD-1', refundKey: KEY, amount: 100 }),
            (err) => err.httpStatus === 400 && err.definitive === true
        );

        const unavailable = scriptedFetch({ status: 503, body: {} });
        await assert.rejects(
            () => createCashfreeRefundAdapter({ fetchImpl: unavailable.fetchImpl })
                .createRefund({ providerOrderId: 'TCH-ORD-1', refundKey: KEY, amount: 100 }),
            (err) => err.httpStatus === 503 && err.definitive !== true
        );
    });

    test('13. Lookup of a refund that does not exist returns found: false', async () => {
        const { fetchImpl, calls } = scriptedFetch({ status: 404, body: {} });
        const result = await createCashfreeRefundAdapter({ fetchImpl })
            .getRefund({ providerOrderId: 'TCH-ORD-1', refundKey: KEY });

        assert.deepEqual(result, { found: false });
        assert.equal(calls[0].init.method, 'GET');
        assert.match(calls[0].url, new RegExp(`/refunds/${REFUND_ID}$`));
    });

    test('14. Lookup of an existing refund returns its normalised status', async () => {
        const { fetchImpl } = scriptedFetch({ body: refundBody({ refund_status: 'SUCCESS' }) });
        const result = await createCashfreeRefundAdapter({ fetchImpl })
            .getRefund({ providerOrderId: 'TCH-ORD-1', refundKey: KEY });

        assert.equal(result.found, true);
        assert.equal(result.status, 'SUCCEEDED');
        assert.equal(result.providerRefundId, 'CFRF-1');
    });

    test('15. Lookup timeout is ambiguous, so reconciliation keeps trying', async () => {
        const abort = new Error('aborted');
        abort.name = 'AbortError';
        const { fetchImpl } = scriptedFetch(abort);

        await assert.rejects(
            () => createCashfreeRefundAdapter({ fetchImpl })
                .getRefund({ providerOrderId: 'TCH-ORD-1', refundKey: KEY }),
            (err) => err.code === 'ETIMEDOUT' && err.definitive !== true
        );
    });

    test('16. Order refund list is normalised and malformed lists are rejected', async () => {
        const ok = scriptedFetch({ body: [refundBody({ refund_status: 'PENDING' })] });
        const list = await createCashfreeRefundAdapter({ fetchImpl: ok.fetchImpl }).listRefundsForOrder('TCH-ORD-1');
        assert.equal(list[0].status, 'PENDING');

        const bad = scriptedFetch({ body: { unexpected: true } });
        await assert.rejects(
            () => createCashfreeRefundAdapter({ fetchImpl: bad.fetchImpl }).listRefundsForOrder('TCH-ORD-1'),
            (err) => err.code === 'MALFORMED_RESPONSE'
        );
    });

    test('17. Adapter is not wired by default: the refund service still fails closed', async () => {
        const { refundProvider } = await import('../src/services/refund.service.js');
        await assert.rejects(
            () => refundProvider.createRefund({ providerOrderId: 'x', refundKey: KEY, amount: 1 }),
            (err) => err.code === 'PROVIDER_NOT_IMPLEMENTED' && err.definitive === true
        );
    });

    test('18. Create sends the stable refund id as the x-idempotency-key header', async () => {
        const { fetchImpl, calls } = scriptedFetch({ body: refundBody() });
        await createCashfreeRefundAdapter({ fetchImpl })
            .createRefund({ providerOrderId: 'TCH-ORD-1', refundKey: KEY, amount: 100 });

        assert.equal(calls[0].init.headers['x-idempotency-key'], REFUND_ID);
    });

    test('19. Response order_id that differs from the local order is definitive', async () => {
        const { fetchImpl } = scriptedFetch({ body: refundBody({ order_id: 'OTHER-ORDER' }) });

        await assert.rejects(
            () => createCashfreeRefundAdapter({ fetchImpl })
                .createRefund({ providerOrderId: 'TCH-ORD-1', refundKey: KEY, amount: 100 }),
            (err) => err.code === 'IDENTITY_MISMATCH' && err.definitive === true
        );
    });

    test('20. Response without order_id is malformed, never accepted as a match', async () => {
        const body = refundBody();
        delete body.order_id;
        const { fetchImpl } = scriptedFetch({ body });

        await assert.rejects(
            () => createCashfreeRefundAdapter({ fetchImpl })
                .getRefund({ providerOrderId: 'TCH-ORD-1', refundKey: KEY }),
            (err) => err.code === 'MALFORMED_RESPONSE'
        );
    });

    test('21. Malformed order identifiers are rejected before any request is made', async () => {
        const { fetchImpl, calls } = scriptedFetch({ body: refundBody() });
        const adapter = createCashfreeRefundAdapter({ fetchImpl });

        await assert.rejects(
            () => adapter.createRefund({ providerOrderId: '../admin', refundKey: KEY, amount: 100 }),
            (err) => err.code === 'VALIDATION' && err.definitive === true
        );
        await assert.rejects(
            () => adapter.getRefund({ providerOrderId: 'a?b=c', refundKey: KEY }),
            (err) => err.code === 'VALIDATION'
        );
        assert.equal(calls.length, 0);
    });
});
