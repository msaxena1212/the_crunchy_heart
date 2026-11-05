/**
 * The Crunchy Heart - Phase 3.5: Inventory Reservation, Deduction & Currency Reconciliation Test Suite
 *
 * Runs strictly against the isolated local test database (crunchy_heart_test).
 * Tests all 11 core requirements for atomic stock reservations, idempotent deductions,
 * bounded reservation releases, and strict INR currency compliance.
 */

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// --------------------------------------------------------------------------
// 1. HARD SECURITY & PRODUCTION SAFETY ASSERTION
// --------------------------------------------------------------------------
const TEST_DB_URL =
    process.env.TEST_DATABASE_URL ||
    'postgresql://postgres:postgres@127.0.0.1:5432/crunchy_heart_test';

if (
    TEST_DB_URL.includes('neon.tech') ||
    TEST_DB_URL.includes('aws.neon.tech') ||
    TEST_DB_URL.includes('ep-solitary-block')
) {
    throw new Error(
        'FATAL SAFETY VIOLATION: Test suite attempted to run against live Neon database! Aborting immediately.'
    );
}

if (!TEST_DB_URL.includes('crunchy_heart_test')) {
    throw new Error(
        `FATAL SAFETY VIOLATION: Test suite must strictly run against 'crunchy_heart_test'. Provided: ${TEST_DB_URL}`
    );
}

// Override environment variables BEFORE any service/pool imports
process.env.DATABASE_URL = TEST_DB_URL;
process.env.DATABASE_URL_UNPOOLED = TEST_DB_URL;
process.env.NODE_ENV = 'test';
process.env.CASHFREE_CLIENT_ID = 'TEST_MOCK_CLIENT_ID';
process.env.CASHFREE_CLIENT_SECRET = 'TEST_MOCK_CLIENT_SECRET_KEY_12345678901234';
process.env.CASHFREE_ENVIRONMENT = 'sandbox';

const { pool, query } = await import('../src/db/pool.js');
const { withTransaction } = await import('../src/db/transaction.js');
const {
    getInventoryForVariants,
    reserveInventory,
    reserveOrderInventory,
    deductInventoryAtomic,
    deductOrderInventory,
    releaseInventoryReservation,
    releaseOrderInventoryReservations,
} = await import('../src/services/inventory.service.js');
const { createOrder } = await import('../src/services/order.service.js');
const { attachCashfreeOrderToPayment, markPaymentSuccess } = await import('../src/services/payment.service.js');

let testCategoryId;
let testProductId;

async function createFixtureVariant({ stock = 20, reserved = 0, price = 249.0 } = {}) {
    const sku = 'TEST-INV-' + Math.random().toString(36).substring(2, 9).toUpperCase();
    const vResult = await query(
        `
        INSERT INTO product_variants (
            product_id, sku, variant_name, weight_grams, flavor,
            mrp, selling_price, cost_price, tax_rate, is_active
        )
        VALUES ($1, $2, $3, 100, 'Peri Peri', $4, $4, 100.00, 18.00, true)
        RETURNING id, sku, selling_price
        `,
        [testProductId, sku, `Test ${sku}`, price]
    );
    const variant = vResult.rows[0];

    await query(
        `
        INSERT INTO inventory (variant_id, quantity_on_hand, quantity_reserved, reorder_level)
        VALUES ($1, $2, $3, 5)
        `,
        [variant.id, stock, reserved]
    );

    return variant;
}

async function createFixtureOrder() {
    const orderNumber = 'TEST-ORD-' + Math.random().toString(36).substring(2, 9).toUpperCase();
    const res = await query(
        `INSERT INTO orders (order_number, customer_name, phone, shipping_address, total_amount, currency, status, payment_status)
         VALUES ($1, 'Test Customer', '9876543210', '{"city":"Mumbai"}'::jsonb, 500.00, 'INR', 'confirmed', 'pending')
         RETURNING id, order_number`,
        [orderNumber]
    );
    return res.rows[0];
}

function sampleCustomer() {
    return {
        name: 'Inventory Test Customer',
        phone: '9876543210',
        email: 'inv.test@example.com',
    };
}

function sampleAddress() {
    return {
        name: 'Inventory Test Customer',
        phone: '9876543210',
        addressLine1: '456 Test Boulevard',
        city: 'Mumbai',
        state: 'Maharashtra',
        pincode: '400001',
        country: 'India',
    };
}

describe('Phase 3.5: Inventory Reservation, Deduction & Currency Reconciliation Suite', () => {
    before(async () => {
        const catRes = await query(
            `
            INSERT INTO categories (name, slug, description)
            VALUES ('Inventory Test Makhana', 'inv-test-makhana-' || gen_random_uuid(), 'Test category')
            RETURNING id
            `
        );
        testCategoryId = catRes.rows[0].id;

        const prodRes = await query(
            `
            INSERT INTO products (category_id, name, slug, description, short_description)
            VALUES ($1, 'Inventory Test Makhana Pack', 'inv-test-makhana-pack-' || gen_random_uuid(), 'Test desc', 'Test short')
            RETURNING id
            `,
            [testCategoryId]
        );
        testProductId = prodRes.rows[0].id;
    });

    after(async () => {
        if (testProductId) {
            await query('DELETE FROM products WHERE id = $1', [testProductId]);
        }
        if (testCategoryId) {
            await query('DELETE FROM categories WHERE id = $1', [testCategoryId]);
        }
    });

    test('1. reserveInventory increments quantity_reserved and logs ledger entry', async () => {
        const variant = await createFixtureVariant({ stock: 10, reserved: 0 });
        const testOrderId = 'ORD_RES_TEST_1';

        await withTransaction(async (client) => {
            const updated = await reserveInventory(client, variant.id, 3, testOrderId);
            assert.equal(Number(updated.quantity_on_hand), 10);
            assert.equal(Number(updated.quantity_reserved), 3);
        });

        const inv = await query('SELECT quantity_on_hand, quantity_reserved FROM inventory WHERE variant_id = $1', [variant.id]);
        assert.equal(Number(inv.rows[0].quantity_reserved), 3);

        const tx = await query(
            `SELECT transaction_type, quantity, reference_type, reference_id FROM inventory_transactions WHERE variant_id = $1`,
            [variant.id]
        );
        assert.equal(tx.rows.length, 1);
        assert.equal(tx.rows[0].transaction_type, 'RESERVATION');
        assert.equal(Number(tx.rows[0].quantity), 3);
        assert.equal(tx.rows[0].reference_id, testOrderId);
    });

    test('2. reserveInventory is idempotent on retries for the same order', async () => {
        const variant = await createFixtureVariant({ stock: 10, reserved: 0 });
        const testOrderId = 'ORD_RES_IDEMP_2';

        await withTransaction(async (client) => {
            await reserveInventory(client, variant.id, 4, testOrderId);
            // Repeated reservation for same order & variant
            await reserveInventory(client, variant.id, 4, testOrderId);
        });

        const inv = await query('SELECT quantity_reserved FROM inventory WHERE variant_id = $1', [variant.id]);
        assert.equal(Number(inv.rows[0].quantity_reserved), 4, 'Must NOT double-reserve on retry');

        const tx = await query(
            `SELECT count(*) FROM inventory_transactions WHERE variant_id = $1 AND transaction_type = 'RESERVATION'`,
            [variant.id]
        );
        assert.equal(Number(tx.rows[0].count), 1, 'Only one reservation transaction should be logged');
    });

    test('3. reserveOrderInventory deterministically sorts variant IDs and locks safely', async () => {
        const v1 = await createFixtureVariant({ stock: 10, reserved: 0 });
        const v2 = await createFixtureVariant({ stock: 10, reserved: 0 });
        const testOrderId = 'ORD_MULTI_RES_3';

        await withTransaction(async (client) => {
            // Pass unsorted items
            const items = [
                { variantId: v2.id, quantity: 2 },
                { variantId: v1.id, quantity: 3 },
            ];
            const res = await reserveOrderInventory(client, { orderId: testOrderId, items });
            assert.equal(res.length, 2);
        });

        const inv1 = await query('SELECT quantity_reserved FROM inventory WHERE variant_id = $1', [v1.id]);
        const inv2 = await query('SELECT quantity_reserved FROM inventory WHERE variant_id = $1', [v2.id]);
        assert.equal(Number(inv1.rows[0].quantity_reserved), 3);
        assert.equal(Number(inv2.rows[0].quantity_reserved), 2);
    });

    test('4. deductOrderInventory atomically decrements BOTH quantity_on_hand and quantity_reserved for reserved orders', async () => {
        const variant = await createFixtureVariant({ stock: 5, reserved: 0 });
        const fixtureOrder = await createFixtureOrder();
        const testOrderId = fixtureOrder.id;

        // 1. Reserve 5 units (now on_hand = 5, reserved = 5, available = 0)
        await withTransaction(async (client) => {
            await reserveInventory(client, variant.id, 5, testOrderId);
        });

        const invAfterRes = await query('SELECT quantity_on_hand, quantity_reserved FROM inventory WHERE variant_id = $1', [variant.id]);
        assert.equal(Number(invAfterRes.rows[0].quantity_on_hand), 5);
        assert.equal(Number(invAfterRes.rows[0].quantity_reserved), 5);

        // 2. Settle the order: deduct 5 units
        await withTransaction(async (client) => {
            await deductOrderInventory(client, {
                orderId: testOrderId,
                items: [{ variantId: variant.id, quantity: 5 }],
            });
        });

        // 3. Both on_hand and reserved should drop to 0 atomically, satisfying chk_inventory_reserved
        const invAfterSale = await query('SELECT quantity_on_hand, quantity_reserved FROM inventory WHERE variant_id = $1', [variant.id]);
        assert.equal(Number(invAfterSale.rows[0].quantity_on_hand), 0);
        assert.equal(Number(invAfterSale.rows[0].quantity_reserved), 0);

        // 4. Ledger records SALE_DEDUCTION
        const tx = await query(
            `SELECT transaction_type, quantity FROM inventory_transactions WHERE variant_id = $1 ORDER BY created_at ASC`,
            [variant.id]
        );
        assert.equal(tx.rows.length, 2);
        assert.equal(tx.rows[0].transaction_type, 'RESERVATION');
        assert.equal(tx.rows[1].transaction_type, 'SALE_DEDUCTION');
        assert.equal(Number(tx.rows[1].quantity), 5);
    });

    test('5. deductOrderInventory for unreserved checkout deducts quantity_on_hand and leaves unrelated reservations intact', async () => {
        // Variant has stock = 10, with 2 units reserved by an earlier order
        const variant = await createFixtureVariant({ stock: 10, reserved: 2 });
        const unreservedOrder = await createFixtureOrder();
        const unreservedOrderId = unreservedOrder.id;

        await withTransaction(async (client) => {
            await deductOrderInventory(client, {
                orderId: unreservedOrderId,
                items: [{ variantId: variant.id, quantity: 3 }],
            });
        });

        const inv = await query('SELECT quantity_on_hand, quantity_reserved FROM inventory WHERE variant_id = $1', [variant.id]);
        assert.equal(Number(inv.rows[0].quantity_on_hand), 7, '10 - 3 = 7');
        assert.equal(Number(inv.rows[0].quantity_reserved), 2, 'Unrelated reservation remains 2');
    });

    test('6. deductOrderInventory is idempotent: repeated calls do NOT double-deduct stock', async () => {
        const variant = await createFixtureVariant({ stock: 10, reserved: 0 });
        const fixtureOrder = await createFixtureOrder();
        const testOrderId = fixtureOrder.id;

        await withTransaction(async (client) => {
            await deductOrderInventory(client, {
                orderId: testOrderId,
                items: [{ variantId: variant.id, quantity: 4 }],
            });
            // Second duplicate call with same orderId
            await deductOrderInventory(client, {
                orderId: testOrderId,
                items: [{ variantId: variant.id, quantity: 4 }],
            });
        });

        const inv = await query('SELECT quantity_on_hand FROM inventory WHERE variant_id = $1', [variant.id]);
        assert.equal(Number(inv.rows[0].quantity_on_hand), 6, 'Must deduct 4 exactly once');

        const tx = await query(
            `SELECT count(*) FROM inventory_transactions WHERE variant_id = $1 AND transaction_type = 'SALE_DEDUCTION'`,
            [variant.id]
        );
        assert.equal(Number(tx.rows[0].count), 1, 'Only one sale deduction should be recorded');
    });

    test('7. releaseInventoryReservation safely decrements reserved quantity and logs ledger', async () => {
        const variant = await createFixtureVariant({ stock: 10, reserved: 0 });
        const testOrderId = 'ORD_RELEASE_7';

        await withTransaction(async (client) => {
            await reserveInventory(client, variant.id, 5, testOrderId);
            await releaseInventoryReservation(client, {
                variantId: variant.id,
                quantity: 3,
                orderId: testOrderId,
            });
        });

        const inv = await query('SELECT quantity_on_hand, quantity_reserved FROM inventory WHERE variant_id = $1', [variant.id]);
        assert.equal(Number(inv.rows[0].quantity_on_hand), 10);
        assert.equal(Number(inv.rows[0].quantity_reserved), 2, '5 - 3 = 2 reserved remaining');
    });

    test('8. releaseInventoryReservation prevents over-release and duplicate release', async () => {
        const variant = await createFixtureVariant({ stock: 10, reserved: 0 });
        const testOrderId = 'ORD_OVER_RELEASE_8';

        await withTransaction(async (client) => {
            await reserveInventory(client, variant.id, 2, testOrderId);
            // Attempt to release 10 (exceeding active reservation of 2)
            await releaseInventoryReservation(client, {
                variantId: variant.id,
                quantity: 10,
                orderId: testOrderId,
            });
            // Repeated release call
            await releaseInventoryReservation(client, {
                variantId: variant.id,
                quantity: 10,
                orderId: testOrderId,
            });
        });

        const inv = await query('SELECT quantity_reserved FROM inventory WHERE variant_id = $1', [variant.id]);
        assert.equal(Number(inv.rows[0].quantity_reserved), 0, 'Cannot drop below 0');

        const tx = await query(
            `SELECT transaction_type, quantity FROM inventory_transactions WHERE variant_id = $1 AND transaction_type = 'RESERVATION_RELEASE'`,
            [variant.id]
        );
        assert.equal(tx.rows.length, 1);
        assert.equal(Number(tx.rows[0].quantity), 2, 'Released quantity must be clamped to actual reservation (2)');
    });

    test('9. releaseOrderInventoryReservations releases all items for an order', async () => {
        const v1 = await createFixtureVariant({ stock: 10, reserved: 0 });
        const v2 = await createFixtureVariant({ stock: 10, reserved: 0 });
        const testOrderId = 'ORD_ALL_REL_9';

        await withTransaction(async (client) => {
            await reserveOrderInventory(client, {
                orderId: testOrderId,
                items: [
                    { variantId: v1.id, quantity: 2 },
                    { variantId: v2.id, quantity: 4 },
                ],
            });
            await releaseOrderInventoryReservations(client, { orderId: testOrderId });
        });

        const inv1 = await query('SELECT quantity_reserved FROM inventory WHERE variant_id = $1', [v1.id]);
        const inv2 = await query('SELECT quantity_reserved FROM inventory WHERE variant_id = $1', [v2.id]);
        assert.equal(Number(inv1.rows[0].quantity_reserved), 0);
        assert.equal(Number(inv2.rows[0].quantity_reserved), 0);
    });

    test('10. Currency is strictly INR across orders, payments and schema defaults', async () => {
        const variant = await createFixtureVariant({ stock: 10, reserved: 0, price: 349.0 });

        const orderResult = await createOrder({
            customer: sampleCustomer(),
            shippingAddress: sampleAddress(),
            items: [{ variantId: variant.id, quantity: 1 }],
            paymentMethod: 'ONLINE',
        });

        // 1. Order currency must be strictly INR
        assert.equal(orderResult.order.currency, 'INR');

        // 2. Payment currency must be strictly INR
        assert.equal(orderResult.payment.currency, 'INR');

        // 3. Database default verification
        const dbOrder = await query('SELECT currency FROM orders WHERE id = $1', [orderResult.order.id]);
        assert.equal(dbOrder.rows[0].currency, 'INR');

        const dbPayment = await query('SELECT currency FROM payments WHERE id = $1', [orderResult.payment.id]);
        assert.equal(dbPayment.rows[0].currency, 'INR');
    });

    test('11. Partial deduction anomaly raises INVENTORY_RECONCILIATION_REQUIRED and halts settlement', async () => {
        const variant = await createFixtureVariant({ stock: 10, reserved: 5 });
        const fixtureOrder = await createFixtureOrder();
        const testOrderId = fixtureOrder.id;

        // Simulate an inconsistent ledger state: a partial deduction of 2 units recorded, but requested is 5
        await query(
            `
            INSERT INTO inventory_transactions (
                variant_id, transaction_type, quantity, reference_type, reference_id, notes
            )
            VALUES ($1, 'SALE_DEDUCTION', 2, 'ORDER', $2, 'Simulated anomalous partial deduction')
            `,
            [variant.id, testOrderId]
        );

        // Attempting deductOrderInventory for 5 units must fail closed with 409 INVENTORY_RECONCILIATION_REQUIRED
        await assert.rejects(
            async () => {
                await withTransaction(async (client) => {
                    await deductOrderInventory(client, {
                        orderId: testOrderId,
                        items: [{ variantId: variant.id, quantity: 5 }],
                    });
                });
            },
            (err) => {
                assert.equal(err.code, 'INVENTORY_RECONCILIATION_REQUIRED');
                assert.equal(err.statusCode, 409);
                assert.equal(err.alreadyDeducted, 2);
                assert.equal(err.requiredQuantity, 5);
                return true;
            }
        );

        // Verify inventory row was NOT mutated: on_hand remains 10, reserved remains 5
        const invAfter = await query('SELECT quantity_on_hand, quantity_reserved FROM inventory WHERE variant_id = $1', [variant.id]);
        assert.equal(Number(invAfter.rows[0].quantity_on_hand), 10);
        assert.equal(Number(invAfter.rows[0].quantity_reserved), 5);

        // Also verify deductInventoryAtomic rejects with the same safety guard
        await assert.rejects(
            async () => {
                await withTransaction(async (client) => {
                    await deductInventoryAtomic(client, {
                        variantId: variant.id,
                        quantity: 5,
                        orderId: testOrderId,
                    });
                });
            },
            (err) => {
                assert.equal(err.code, 'INVENTORY_RECONCILIATION_REQUIRED');
                assert.equal(err.statusCode, 409);
                assert.equal(err.alreadyDeducted, 2);
                assert.equal(err.requestedQuantity, 5);
                return true;
            }
        );
    });

    test('12. Mixed deduction state (Variant A fully deducted, Variant B not deducted) fails closed without mutating stock', async () => {
        const vA = await createFixtureVariant({ stock: 10, reserved: 0 });
        const vB = await createFixtureVariant({ stock: 10, reserved: 0 });
        const fixtureOrder = await createFixtureOrder();
        const testOrderId = fixtureOrder.id;

        // Pre-record deduction for vA (3 units) but NOT vB
        await query(
            `
            INSERT INTO inventory_transactions (
                variant_id, transaction_type, quantity, reference_type, reference_id, notes
            )
            VALUES ($1, 'SALE_DEDUCTION', 3, 'ORDER', $2, 'Pre-recorded deduction for vA only')
            `,
            [vA.id, testOrderId]
        );

        // Attempting deductOrderInventory for vA (3) and vB (2) must raise INVENTORY_RECONCILIATION_REQUIRED
        await assert.rejects(
            async () => {
                await withTransaction(async (client) => {
                    await deductOrderInventory(client, {
                        orderId: testOrderId,
                        items: [
                            { variantId: vA.id, quantity: 3 },
                            { variantId: vB.id, quantity: 2 },
                        ],
                    });
                });
            },
            (err) => {
                assert.equal(err.code, 'INVENTORY_RECONCILIATION_REQUIRED');
                assert.equal(err.statusCode, 409);
                return true;
            }
        );

        // Verify stock for BOTH variants was NOT mutated:
        // vA must still have 10 on hand (not double-deducted to 7!)
        // vB must still have 10 on hand
        const invA = await query('SELECT quantity_on_hand FROM inventory WHERE variant_id = $1', [vA.id]);
        const invB = await query('SELECT quantity_on_hand FROM inventory WHERE variant_id = $1', [vB.id]);
        assert.equal(Number(invA.rows[0].quantity_on_hand), 10, 'Variant A must not be deducted a second time');
        assert.equal(Number(invB.rows[0].quantity_on_hand), 10, 'Variant B must not be partially deducted');
    });

    test('13. Unexpected extra variant in ledger raises INVENTORY_RECONCILIATION_REQUIRED and halts settlement', async () => {
        const vA = await createFixtureVariant({ stock: 10, reserved: 0 });
        const vExtra = await createFixtureVariant({ stock: 10, reserved: 0 });
        const fixtureOrder = await createFixtureOrder();
        const testOrderId = fixtureOrder.id;

        // Record deductions for both vA (3) and an extra unexpected variant vExtra (1)
        await query(
            `
            INSERT INTO inventory_transactions (
                variant_id, transaction_type, quantity, reference_type, reference_id, notes
            )
            VALUES
                ($1, 'SALE_DEDUCTION', 3, 'ORDER', $3, 'Recorded deduction for vA'),
                ($2, 'SALE_DEDUCTION', 1, 'ORDER', $3, 'Unexpected deduction for vExtra')
            `,
            [vA.id, vExtra.id, testOrderId]
        );

        // Order expects ONLY vA (3 units). The extra variant in the ledger indicates an inconsistent state!
        await assert.rejects(
            async () => {
                await withTransaction(async (client) => {
                    await deductOrderInventory(client, {
                        orderId: testOrderId,
                        items: [{ variantId: vA.id, quantity: 3 }],
                    });
                });
            },
            (err) => {
                assert.equal(err.code, 'INVENTORY_RECONCILIATION_REQUIRED');
                assert.equal(err.statusCode, 409);
                return true;
            }
        );

        // Verify stock was NOT mutated
        const invA = await query('SELECT quantity_on_hand FROM inventory WHERE variant_id = $1', [vA.id]);
        const invExtra = await query('SELECT quantity_on_hand FROM inventory WHERE variant_id = $1', [vExtra.id]);
        assert.equal(Number(invA.rows[0].quantity_on_hand), 10);
        assert.equal(Number(invExtra.rows[0].quantity_on_hand), 10);
    });

    test('14. Multi-item order with all expected variants deducted exactly returns idempotently without stock mutation', async () => {
        const vA = await createFixtureVariant({ stock: 10, reserved: 0 });
        const vB = await createFixtureVariant({ stock: 10, reserved: 0 });
        const fixtureOrder = await createFixtureOrder();
        const testOrderId = fixtureOrder.id;

        // 1. First execution: clean deduction of vA (3) and vB (2)
        await withTransaction(async (client) => {
            await deductOrderInventory(client, {
                orderId: testOrderId,
                items: [
                    { variantId: vA.id, quantity: 3 },
                    { variantId: vB.id, quantity: 2 },
                ],
            });
        });

        const invAAfter1 = await query('SELECT quantity_on_hand FROM inventory WHERE variant_id = $1', [vA.id]);
        const invBAfter1 = await query('SELECT quantity_on_hand FROM inventory WHERE variant_id = $1', [vB.id]);
        assert.equal(Number(invAAfter1.rows[0].quantity_on_hand), 7);
        assert.equal(Number(invBAfter1.rows[0].quantity_on_hand), 8);

        // 2. Second execution (retry): exact match on all items
        await withTransaction(async (client) => {
            const rows = await deductOrderInventory(client, {
                orderId: testOrderId,
                items: [
                    { variantId: vA.id, quantity: 3 },
                    { variantId: vB.id, quantity: 2 },
                ],
            });
            assert.equal(rows.length, 2);
        });

        // 3. Stock must remain exactly 7 and 8 (no double deduction)
        const invAAfter2 = await query('SELECT quantity_on_hand FROM inventory WHERE variant_id = $1', [vA.id]);
        const invBAfter2 = await query('SELECT quantity_on_hand FROM inventory WHERE variant_id = $1', [vB.id]);
        assert.equal(Number(invAAfter2.rows[0].quantity_on_hand), 7);
        assert.equal(Number(invBAfter2.rows[0].quantity_on_hand), 8);

        // 4. Ledger count must still be exactly 2 SALE_DEDUCTION rows for this order
        const txRes = await query(
            `SELECT count(*) FROM inventory_transactions WHERE reference_id = $1 AND transaction_type = 'SALE_DEDUCTION'`,
            [testOrderId]
        );
        assert.equal(Number(txRes.rows[0].count), 2);
    });

    test('15. Concurrent direct calls to deductOrderInventory for the same order are serialized; stock deducted exactly once', async () => {
        const variant = await createFixtureVariant({ stock: 10, reserved: 0 });
        const fixtureOrder = await createFixtureOrder();

        // Run two separate concurrent transactions invoking deductOrderInventory for the same order
        const [resA, resB] = await Promise.all([
            withTransaction(async (client) => {
                return await deductOrderInventory(client, {
                    orderId: fixtureOrder.id,
                    items: [{ variantId: variant.id, quantity: 3 }],
                });
            }),
            withTransaction(async (client) => {
                return await deductOrderInventory(client, {
                    orderId: fixtureOrder.id,
                    items: [{ variantId: variant.id, quantity: 3 }],
                });
            }),
        ]);

        // Stock was 10, 3 units requested -> final stock must be exactly 7 (NOT 4!)
        const invAfter = await query('SELECT quantity_on_hand, quantity_reserved FROM inventory WHERE variant_id = $1', [variant.id]);
        assert.equal(Number(invAfter.rows[0].quantity_on_hand), 7, 'Stock must be deducted exactly once despite concurrency');
        assert.equal(Number(invAfter.rows[0].quantity_reserved), 0);

        // Ledger must record exactly 1 SALE_DEDUCTION row for this order
        const txRes = await query(
            `SELECT count(*) FROM inventory_transactions WHERE reference_type = 'ORDER' AND reference_id = $1 AND transaction_type = 'SALE_DEDUCTION'`,
            [fixtureOrder.id]
        );
        assert.equal(Number(txRes.rows[0].count), 1, 'Exactly one SALE_DEDUCTION transaction must be recorded');
    });

    test('16. deductOrderInventory throws ORDER_NOT_FOUND if non-existent orderId is provided', async () => {
        const variant = await createFixtureVariant({ stock: 10, reserved: 0 });
        const fakeOrderId = '00000000-0000-0000-0000-000000000000';

        await assert.rejects(
            async () => {
                await withTransaction(async (client) => {
                    await deductOrderInventory(client, {
                        orderId: fakeOrderId,
                        items: [{ variantId: variant.id, quantity: 2 }],
                    });
                });
            },
            (err) => {
                assert.equal(err.code, 'ORDER_NOT_FOUND');
                assert.equal(err.statusCode, 404);
                return true;
            }
        );
    });
});
