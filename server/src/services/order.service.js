import crypto from 'node:crypto';
import { query } from '../db/pool.js';
import { withTransaction } from '../db/transaction.js';
import { loadOrderAttempts, summarizeAttempts } from './payment-creation.service.js';

import {
    getVariantsForCheckout,
    calculateItemPricing,
} from './pricing.service.js';

import {
    calculateShipping,
} from './shipping.service.js';

import {
    reserveInventory,
} from './inventory.service.js';

import {
    roundMoney,
} from '../utils/money.js';

import {
    createCashfreeOrder,
} from './cashfree.service.js';

import {
    verifyGuestAccessToken,
} from '../utils/order-token.js';


/*
|--------------------------------------------------------------------------
| Helpers
|--------------------------------------------------------------------------
*/

function normalizePaymentMethod(
    paymentMethod
) {
    const normalized =
        String(
            paymentMethod || ''
        )
            .trim()
            .toUpperCase();


    if (
        ![
            'COD',
            'ONLINE',
        ].includes(normalized)
    ) {
        const error =
            new Error(
                'paymentMethod must be COD or ONLINE.'
            );

        error.statusCode = 400;

        throw error;
    }


    return normalized;
}


function validateCustomer(
    customer
) {
    if (
        !customer ||
        !customer.name ||
        !customer.phone
    ) {
        const error =
            new Error(
                'Customer name and phone are required.'
            );

        error.statusCode = 400;

        throw error;
    }


    return {
        name:
            String(
                customer.name
            ).trim(),

        phone:
            String(
                customer.phone
            ).trim(),

        email:
            customer.email
                ? String(
                    customer.email
                ).trim()
                : null,
    };
}


function validateAddress(
    address,
    label
) {
    if (!address) {
        const error =
            new Error(
                `${label} is required.`
            );

        error.statusCode = 400;

        throw error;
    }


    const requiredFields = [
        'name',
        'phone',
        'addressLine1',
        'city',
        'state',
        'pincode',
        'country',
    ];


    for (
        const field
        of requiredFields
    ) {
        if (
            !address[field]
        ) {
            const error =
                new Error(
                    `${label}.${field} is required.`
                );

            error.statusCode = 400;

            throw error;
        }
    }


    return {
        name:
            String(
                address.name
            ).trim(),

        phone:
            String(
                address.phone
            ).trim(),

        addressLine1:
            String(
                address.addressLine1
            ).trim(),

        addressLine2:
            address.addressLine2
                ? String(
                    address.addressLine2
                ).trim()
                : '',

        city:
            String(
                address.city
            ).trim(),

        state:
            String(
                address.state
            ).trim(),

        pincode:
            String(
                address.pincode
            ).trim(),

        country:
            String(
                address.country
            ).trim(),
    };
}


function normalizeItems(
    items
) {
    if (
        !Array.isArray(items) ||
        items.length === 0
    ) {
        const error =
            new Error(
                'At least one item is required.'
            );

        error.statusCode = 400;

        throw error;
    }


    return items.map(
        (item, index) => {

            if (
                !item?.variantId
            ) {
                const error =
                    new Error(
                        `items[${index}].variantId is required.`
                    );

                error.statusCode = 400;

                throw error;
            }


            const quantity =
                Number(
                    item.quantity
                );


            if (
                !Number.isInteger(
                    quantity
                ) ||
                quantity <= 0
            ) {
                const error =
                    new Error(
                        `items[${index}].quantity must be a positive integer.`
                    );

                error.statusCode = 400;

                throw error;
            }


            return {
                variantId:
                    String(
                        item.variantId
                    ).trim(),

                quantity,
            };
        }
    );
}


function aggregateItems(items) {
    const map = new Map();
    for (const item of items) {
        const vId = String(item.variantId || item.variant_id).trim();
        const qty = Number(item.quantity || 0);
        if (!map.has(vId)) {
            map.set(vId, { ...item, variantId: vId, quantity: qty });
        } else {
            map.get(vId).quantity += qty;
        }
    }
    return Array.from(map.values());
}


/*
|--------------------------------------------------------------------------
| Request fingerprint (idempotency replay safety)
|--------------------------------------------------------------------------
| A replayed idempotency key must carry the same logical request. The
| fingerprint covers everything the client controls that changes the order.
| It is stored on the order, and a replay with a different fingerprint is
| rejected instead of silently returning the earlier order.
*/
function canonicalize(value) {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value && typeof value === 'object') {
        return Object.keys(value).sort().reduce((acc, key) => {
            acc[key] = canonicalize(value[key]);
            return acc;
        }, {});
    }
    return value;
}

export function buildOrderRequestFingerprint({
    customer,
    shippingAddress,
    billingAddress,
    items,
    paymentMethod,
    notes,
}) {
    const canonical = canonicalize({
        paymentMethod,
        customer: {
            name: customer.name,
            phone: customer.phone,
            email: customer.email ?? null,
        },
        shippingAddress,
        billingAddress,
        items: items
            .map(item => ({ variantId: String(item.variantId), quantity: Number(item.quantity) }))
            .sort((a, b) => a.variantId.localeCompare(b.variantId)),
        notes: notes ? String(notes) : null,
    });

    return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function assertFingerprintMatches(storedFingerprint, requestFingerprint) {
    // Orders created before fingerprints existed have no stored value. They cannot be
    // compared, so they keep their original replay behaviour.
    if (storedFingerprint === null || storedFingerprint === undefined) return;

    if (storedFingerprint !== requestFingerprint) {
        throw Object.assign(
            new Error('This idempotency key was already used for a different order request.'),
            { statusCode: 409, code: 'IDEMPOTENCY_KEY_REUSED' }
        );
    }
}

async function assertReplayMatches(idempotencyKey, requestFingerprint) {
    const res = await query(
        `SELECT idempotency_fingerprint FROM orders WHERE idempotency_key = $1 LIMIT 1`,
        [idempotencyKey]
    );
    if (res.rows.length) {
        assertFingerprintMatches(res.rows[0].idempotency_fingerprint, requestFingerprint);
    }
}

/*
 * Maps an authoritative attempt row to the payment shape used by replies.
 */
function attemptToPayment(row) {
    if (!row) {
        return null;
    }

    return {
        id: row.id,
        order_id: row.order_id,
        provider: row.provider,
        provider_order_id: row.provider_order_id,
        provider_payment_id: row.provider_payment_id,
        amount: Number(row.amount),
        currency: row.currency,
        status: row.status,
        payment_method: row.payment_method,
        gateway_status: row.gateway_status,
        raw_response: row.raw_response,
    };
}

async function fetchExistingOrderByIdempotencyKey(normalizedIdempotencyKey) {
    if (!normalizedIdempotencyKey) return null;

    const existingResult = await query(
        `
        SELECT
            o.id,
            o.order_number,
            o.customer_name,
            o.phone,
            o.email,
            o.subtotal,
            o.discount_amount,
            o.shipping_amount,
            o.tax_amount,
            o.total_amount,
            o.currency,
            o.status,
            o.payment_status,
            o.payment_method,
            o.tax_rate,
            o.price_includes_tax,
            o.created_at,

            p.id AS payment_id,
            p.provider AS payment_provider,
            p.provider_order_id,
            p.provider_payment_id,
            p.amount AS payment_amount,
            p.currency AS payment_currency,
            p.status AS payment_status_record,
            p.payment_method AS payment_method_record,
            p.gateway_status,
            p.raw_response AS payment_raw_response
        FROM orders o
        LEFT JOIN payments p
            ON p.order_id = o.id
        WHERE o.idempotency_key = $1
        ORDER BY o.created_at DESC
        LIMIT 1
        `,
        [normalizedIdempotencyKey]
    );

    if (!existingResult.rows.length) {
        return null;
    }

    const row = existingResult.rows[0];

    const itemResult = await query(
        `
        SELECT
            variant_id,
            product_name,
            variant_name,
            sku,
            quantity,
            unit_price,
            total_price,
            taxable_value,
            tax_rate,
            tax_amount,
            unit_price_includes_tax
        FROM order_items
        WHERE order_id = $1
        ORDER BY created_at ASC
        `,
        [row.id]
    );

    // The payment is chosen from every attempt on the order, by state, never by position.
    const attemptSummary = summarizeAttempts(await loadOrderAttempts(row.id));

    return {
        existing: true,
        paymentState: attemptSummary.state,
        order: {
            id: row.id,
            order_number: row.order_number,
            customer_name: row.customer_name,
            phone: row.phone,
            email: row.email,
            subtotal: Number(row.subtotal),
            discount_amount: Number(row.discount_amount),
            shipping_amount: Number(row.shipping_amount),
            tax_amount: Number(row.tax_amount),
            total_amount: Number(row.total_amount),
            currency: row.currency,
            status: row.status,
            payment_status: row.payment_status,
            payment_method: row.payment_method,
            tax_rate: Number(row.tax_rate),
            price_includes_tax: row.price_includes_tax,
            created_at: row.created_at,
        },
        payment: attemptToPayment(attemptSummary.authoritative),
        items: itemResult.rows.map(mapOrderItemRow),
    };
}


/*
|--------------------------------------------------------------------------
| Create Order
|--------------------------------------------------------------------------
|
| This method creates:
|
| 1. Order
| 2. Order items
| 3. Payment record
|
| Everything above is executed inside one DB transaction.
|
|--------------------------------------------------------------------------
*/

export async function createOrder({
    customer,
    shippingAddress,
    billingAddress,
    items,
    paymentMethod,
    notes,
    idempotencyKey,
}) {
    const normalizedPaymentMethod =
        normalizePaymentMethod(
            paymentMethod
        );


    const normalizedCustomer =
        validateCustomer(
            customer
        );


    const normalizedShippingAddress =
        validateAddress(
            shippingAddress,
            'shippingAddress'
        );


    const normalizedBillingAddress =
        billingAddress
            ? validateAddress(
                billingAddress,
                'billingAddress'
            )
            : normalizedShippingAddress;


    const rawNormalizedItems =
        normalizeItems(
            items
        );

    const normalizedItems =
        aggregateItems(
            rawNormalizedItems
        );


    const normalizedIdempotencyKey =
        idempotencyKey
            ? String(
                idempotencyKey
            ).trim()
            : null;


    /*
    |--------------------------------------------------------------------------
    | Idempotency pre-check
    |--------------------------------------------------------------------------
    */

    const requestFingerprint = normalizedIdempotencyKey
        ? buildOrderRequestFingerprint({
            customer: normalizedCustomer,
            shippingAddress: normalizedShippingAddress,
            billingAddress: normalizedBillingAddress,
            items: normalizedItems,
            paymentMethod: normalizedPaymentMethod,
            notes,
        })
        : null;

    if (
        normalizedIdempotencyKey
    ) {
        await assertReplayMatches(normalizedIdempotencyKey, requestFingerprint);

        const existing = await fetchExistingOrderByIdempotencyKey(
            normalizedIdempotencyKey
        );

        if (existing) {
            return existing;
        }
    }


    /*
    |--------------------------------------------------------------------------
    | Transaction
    |--------------------------------------------------------------------------
    */

    try {
        return await withTransaction(
        async client => {

            /*
            |--------------------------------------------------------------------------
            | Re-check idempotency inside transaction
            |--------------------------------------------------------------------------
            |
            | Protects against concurrent duplicate requests.
            |
            */

            if (
                normalizedIdempotencyKey
            ) {
                const duplicateResult =
                    await client.query(
                        `
                        SELECT
                            id,
                            order_number,
                            idempotency_fingerprint
                        FROM orders
                        WHERE
                            idempotency_key =
                            $1
                        FOR UPDATE
                        `,
                        [
                            normalizedIdempotencyKey,
                        ]
                    );


                if (
                    duplicateResult.rows.length
                ) {
                    assertFingerprintMatches(
                        duplicateResult.rows[0].idempotency_fingerprint,
                        requestFingerprint
                    );

                    const existingOrderId =
                        duplicateResult
                            .rows[0]
                            .id;


                    const orderResult =
                        await client.query(
                            `
                            SELECT
                                *
                            FROM orders
                            WHERE id = $1
                            `,
                            [
                                existingOrderId,
                            ]
                        );


                    const paymentResult =
                        await client.query(
                            `
                            SELECT
                                *
                            FROM payments
                            WHERE order_id = $1
                            ORDER BY created_at ASC
                            `,
                            [
                                existingOrderId,
                            ]
                        );

                    // The authoritative attempt is chosen by state from every row, never by position.
                    const attemptSummary = summarizeAttempts(paymentResult.rows);


                    const itemResult =
                        await client.query(
                            `
                            SELECT
                                variant_id,
                                product_name,
                                variant_name,
                                sku,
                                quantity,
                                unit_price,
                                total_price,
                                taxable_value,
                                tax_rate,
                                tax_amount,
                                unit_price_includes_tax
                            FROM order_items
                            WHERE order_id = $1
                            ORDER BY created_at ASC
                            `,
                            [
                                existingOrderId,
                            ]
                        );


                    return {
                        existing: true,

                        order:
                            mapOrderRow(
                                orderResult
                                    .rows[0]
                            ),

                        payment:
                            attemptSummary.authoritative
                                ? mapPaymentRow(
                                    attemptSummary.authoritative
                                )
                                : null,

                        paymentState: attemptSummary.state,

                        items:
                            itemResult
                                .rows
                                .map(
                                    mapOrderItemRow
                                ),
                    };
                }
            }


            /*
            |--------------------------------------------------------------------------
            | Fetch product variants
            |--------------------------------------------------------------------------
            */

            const variantIds =
                normalizedItems.map(
                    item =>
                        item.variantId
                );


            const variants =
                await getVariantsForCheckout(
                    variantIds
                );


            const variantMap =
                new Map(
                    variants.map(
                        variant => [
                            String(
                                variant.id
                            ),
                            variant,
                        ]
                    )
                );


            /*
            |--------------------------------------------------------------------------
            | Validate every requested variant
            |--------------------------------------------------------------------------
            */

            for (
                const item
                of normalizedItems
            ) {
                const variant =
                    variantMap.get(
                        String(
                            item.variantId
                        )
                    );


                if (!variant) {
                    const error =
                        new Error(
                            `Product variant not found: ${item.variantId}`
                        );

                    error.statusCode =
                        404;

                    throw error;
                }
            }


            /*
            |--------------------------------------------------------------------------
            | Price + inventory
            |--------------------------------------------------------------------------
            */

            const pricedItems = [];

            let subtotal = 0;

            let taxableSubtotal =
                0;

            let taxAmount = 0;


            for (
                const item
                of normalizedItems
            ) {
                const variant =
                    variantMap.get(
                        String(
                            item.variantId
                        )
                    );


                /*
                |--------------------------------------------------------------------------
                | Check available inventory (zero-reservation policy)
                |--------------------------------------------------------------------------
                */

                const inventoryResult =
                    await client.query(
                        `
                        SELECT
                            variant_id,
                            quantity_on_hand,
                            quantity_reserved,

                            GREATEST(
                                quantity_on_hand -
                                quantity_reserved,
                                0
                            ) AS available_quantity

                        FROM inventory

                        WHERE
                            variant_id = $1
                        `,
                        [
                            variant.id,
                        ]
                    );


                if (
                    !inventoryResult.rows.length
                ) {
                    const error =
                        new Error(
                            `Inventory not found for ${variant.sku}.`
                        );

                    error.statusCode =
                        409;

                    throw error;
                }


                const inventory =
                    inventoryResult.rows[0];


                const availableQuantity =
                    Number(
                        inventory.available_quantity ||
                        0
                    );


                if (
                    availableQuantity <
                    item.quantity
                ) {
                    const error =
                        new Error(
                            availableQuantity === 0
                                ? `${variant.variant_name} is currently out of stock.`
                                : `Only ${availableQuantity} unit(s) of ${variant.variant_name} are available.`
                        );

                    error.statusCode =
                        409;

                    error.availableQuantity =
                        availableQuantity;

                    throw error;
                }


                /*
                |--------------------------------------------------------------------------
                | Calculate price
                |--------------------------------------------------------------------------
                */

                const pricing =
                    calculateItemPricing(
                        variant,
                        item.quantity
                    );


                subtotal +=
                    pricing.grossAmount;


                taxableSubtotal +=
                    pricing.taxableAmount;


                taxAmount +=
                    pricing.taxAmount;


                pricedItems.push({
                    variantId:
                        variant.id,

                    productId:
                        variant.product_id,

                    productName:
                        variant.product_name,

                    variantName:
                        variant.variant_name,

                    sku:
                        variant.sku,

                    quantity:
                        item.quantity,

                    unitPrice:
                        pricing.unitPrice,

                    totalPrice:
                        pricing.grossAmount,

                    taxableValue:
                        pricing.taxableAmount,

                    taxRate:
                        pricing.taxRate,

                    taxAmount:
                        pricing.taxAmount,

                    availableQuantity,
                });
            }


            subtotal =
                roundMoney(
                    subtotal
                );


            taxableSubtotal =
                roundMoney(
                    taxableSubtotal
                );


            taxAmount =
                roundMoney(
                    taxAmount
                );


            /*
            |--------------------------------------------------------------------------
            | Discount
            |--------------------------------------------------------------------------
            |
            | Coupon engine will be connected here.
            |
            */

            const discountAmount =
                0;


            /*
            |--------------------------------------------------------------------------
            | Shipping
            |--------------------------------------------------------------------------
            */

            const shippingAmount =
                await calculateShipping(
                    subtotal
                );


            /*
            |--------------------------------------------------------------------------
            | Final total
            |--------------------------------------------------------------------------
            */

            const totalAmount =
                roundMoney(
                    subtotal -
                    discountAmount +
                    shippingAmount
                );


            /*
            |--------------------------------------------------------------------------
            | Order status
            |--------------------------------------------------------------------------
            */

            const orderStatus =
                normalizedPaymentMethod === 'COD'
                    ? 'confirmed'
                    : 'pending';


            const paymentStatus =
                'pending';


            /*
            |--------------------------------------------------------------------------
            | Create order
            |--------------------------------------------------------------------------
            */

            const orderResult =
                await client.query(
                    `
                    INSERT INTO orders (
                        order_number,
                        customer_id,
                        customer_name,
                        phone,
                        email,
                        shipping_address,
                        billing_address,
                        subtotal,
                        discount_amount,
                        shipping_amount,
                        tax_amount,
                        total_amount,
                        currency,
                        status,
                        payment_status,
                        notes,
                        coupon_id,
                        coupon_code,
                        payment_method,
                        tax_rate,
                        price_includes_tax,
                        idempotency_key,
                        idempotency_fingerprint,
                        created_at,
                        updated_at
                    )
                    VALUES (
                        $1,
                        NULL,
                        $2,
                        $3,
                        $4,
                        $5::jsonb,
                        $6::jsonb,
                        $7,
                        $8,
                        $9,
                        $10,
                        $11,
                        'INR',
                        $12,
                        $13,
                        $14,
                        NULL,
                        NULL,
                        $15,
                        $16,
                        true,
                        $17,
                        $18,
                        NOW(),
                        NOW()
                    )
                    RETURNING
                        id,
                        order_number,
                        customer_name,
                        phone,
                        email,
                        subtotal,
                        discount_amount,
                        shipping_amount,
                        tax_amount,
                        total_amount,
                        currency,
                        status,
                        payment_status,
                        payment_method,
                        tax_rate,
                        price_includes_tax,
                        created_at
                    `,
                    [
                        generateOrderNumber(),

                        normalizedCustomer.name,

                        normalizedCustomer.phone,

                        normalizedCustomer.email,

                        JSON.stringify(
                            normalizedShippingAddress
                        ),

                        JSON.stringify(
                            normalizedBillingAddress
                        ),

                        subtotal,

                        discountAmount,

                        shippingAmount,

                        taxAmount,

                        totalAmount,

                        orderStatus,

                        paymentStatus,

                        notes
                            ? String(notes)
                            : null,

                        normalizedPaymentMethod,

                        18,

                        normalizedIdempotencyKey,
                        requestFingerprint,
                    ]
                );


            const order =
                orderResult.rows[0];


            /*
            |--------------------------------------------------------------------------
            | Create order items
            |--------------------------------------------------------------------------
            */

            const createdItems = [];


            for (
                const item
                of pricedItems
            ) {
                const itemResult =
                    await client.query(
                        `
                        INSERT INTO order_items (
                            order_id,
                            variant_id,
                            product_name,
                            variant_name,
                            sku,
                            quantity,
                            unit_price,
                            total_price,
                            discount_amount,
                            taxable_value,
                            tax_rate,
                            tax_amount,
                            unit_price_includes_tax,
                            created_at
                        )
                        VALUES (
                            $1,
                            $2,
                            $3,
                            $4,
                            $5,
                            $6,
                            $7,
                            $8,
                            $9,
                            $10,
                            $11,
                            $12,
                            true,
                            NOW()
                        )
                        RETURNING
                            variant_id,
                            product_name,
                            variant_name,
                            sku,
                            quantity,
                            unit_price,
                            total_price,
                            taxable_value,
                            tax_rate,
                            tax_amount,
                            unit_price_includes_tax
                        `,
                        [
                            order.id,

                            item.variantId,

                            item.productName,

                            item.variantName,

                            item.sku,

                            item.quantity,

                            item.unitPrice,

                            item.totalPrice,

                            0,

                            item.taxableValue,

                            item.taxRate,

                            item.taxAmount,
                        ]
                    );


                createdItems.push(
                    mapOrderItemRow(
                        itemResult.rows[0]
                    )
                );
            }


            /*
            |--------------------------------------------------------------------------
            | Payment provider
            |--------------------------------------------------------------------------
            */

            const paymentProvider =
                normalizedPaymentMethod ===
                    'ONLINE'
                    ? 'cashfree'
                    : 'internal';


            const paymentStatusRecord =
                normalizedPaymentMethod ===
                    'ONLINE'
                    ? 'created'
                    : 'pending';


            // ONLINE: CREATE_PENDING means no provider call has been made. The controller must
            // claim it (CREATE_PENDING -> ATTEMPT_INITIATED) before contacting Cashfree. A retry
            // may close it instead (CREATE_NOT_SUBMITTED). Only one of the two conditional writes wins.
            const gatewayStatus =
                normalizedPaymentMethod ===
                    'ONLINE'
                    ? 'CREATE_PENDING'
                    : 'COD_PENDING';


            /*
            |--------------------------------------------------------------------------
            | Create payment record
            |--------------------------------------------------------------------------
            */

            const paymentResult =
                await client.query(
                    `
                    INSERT INTO payments (
                        order_id,
                        provider,
                        amount,
                        currency,
                        status,
                        raw_response,
                        created_at,
                        updated_at,
                        payment_method,
                        gateway_status
                    )
                    VALUES (
                        $1,
                        $2,
                        $3,
                        'INR',
                        $4,
                        NULL,
                        NOW(),
                        NOW(),
                        $5,
                        $6
                    )
                    RETURNING
                        id,
                        order_id,
                        provider,
                        provider_order_id,
                        provider_payment_id,
                        amount,
                        currency,
                        status,
                        raw_response,
                        created_at,
                        updated_at,
                        payment_method,
                        gateway_status
                    `,
                    [
                        order.id,

                        paymentProvider,

                        totalAmount,

                        paymentStatusRecord,

                        normalizedPaymentMethod,

                        gatewayStatus,
                    ]
                );


            const payment =
                mapPaymentRow(
                    paymentResult.rows[0]
                );


            /*
            |--------------------------------------------------------------------------
            | Return
            |--------------------------------------------------------------------------
            */

            return {
                existing: false,

                order:
                    mapOrderRow(
                        order
                    ),

                payment,

                items:
                    createdItems,
            };
        }
    );
    } catch (error) {
        if (
            normalizedIdempotencyKey &&
            (error.code === '23505' ||
             String(error.constraint).includes('ux_orders_idempotency_key') ||
             String(error.message).includes('idempotency_key'))
        ) {
            await assertReplayMatches(normalizedIdempotencyKey, requestFingerprint);

            const existing = await fetchExistingOrderByIdempotencyKey(
                normalizedIdempotencyKey
            );

            if (existing) {
                return existing;
            }
        }

        throw error;
    }
}


/*
|--------------------------------------------------------------------------
| Order Number
|--------------------------------------------------------------------------
*/

function generateOrderNumber() {
    const now =
        new Date();


    const date =
        now
            .toISOString()
            .slice(0, 10)
            .replaceAll('-', '');


    const random =
        Math.random()
            .toString(36)
            .substring(2, 8)
            .toUpperCase();


    return `TCH-${date}-${random}`;
}


/*
|--------------------------------------------------------------------------
| Row Mappers
|--------------------------------------------------------------------------
*/

function mapOrderRow(
    row
) {
    if (!row) {
        return null;
    }


    return {
        id:
            row.id,

        order_number:
            row.order_number,

        customer_name:
            row.customer_name,

        phone:
            row.phone,

        email:
            row.email,

        subtotal:
            Number(
                row.subtotal || 0
            ),

        discount_amount:
            Number(
                row.discount_amount || 0
            ),

        shipping_amount:
            Number(
                row.shipping_amount || 0
            ),

        tax_amount:
            Number(
                row.tax_amount || 0
            ),

        total_amount:
            Number(
                row.total_amount || 0
            ),

        currency:
            row.currency,

        status:
            row.status,

        payment_status:
            row.payment_status,

        payment_method:
            row.payment_method,

        tax_rate:
            Number(
                row.tax_rate ?? 18
            ),

        price_includes_tax:
            row.price_includes_tax,

        created_at:
            row.created_at,
    };
}


function mapPaymentRow(
    row
) {
    if (!row) {
        return null;
    }


    return {
        id:
            row.id,

        order_id:
            row.order_id,

        provider:
            row.provider,

        provider_order_id:
            row.provider_order_id,

        provider_payment_id:
            row.provider_payment_id,

        amount:
            Number(
                row.amount || 0
            ),

        currency:
            row.currency,

        status:
            row.status,

        raw_response:
            row.raw_response,

        payment_method:
            row.payment_method,

        gateway_status:
            row.gateway_status,

        created_at:
            row.created_at,

        updated_at:
            row.updated_at,
    };
}


function mapOrderItemRow(
    row
) {
    return {
        variantId:
            row.variant_id,

        productName:
            row.product_name,

        variantName:
            row.variant_name,

        sku:
            row.sku,

        quantity:
            Number(
                row.quantity
            ),

        unitPrice:
            Number(
                row.unit_price
            ),

        totalPrice:
            Number(
                row.total_price
            ),

        taxableValue:
            Number(
                row.taxable_value
            ),

        taxRate:
            Number(
                row.tax_rate
            ),

        taxAmount:
            Number(
                row.tax_amount
            ),

        unitPriceIncludesTax:
            row.unit_price_includes_tax,
    };
}


/*
|--------------------------------------------------------------------------
| Retry Payment Attempt
|--------------------------------------------------------------------------
|
| 3-Phase Decoupled Payment Retry Engine:
| Phase 1: DB Transaction - verification, stock validation, attempt reservation
|          (Locks released immediately upon commit)
| Phase 2: Cashfree External Call (Outside any DB transaction)
| Phase 3: Post-network DB update - finalized session or ambiguous timeout
|
|--------------------------------------------------------------------------
*/

// An ATTEMPT_INITIATED row older than this is treated as interrupted (see
// retryPaymentAttempt). It must exceed CASHFREE_CREATE_TIMEOUT_MS by a wide margin.
export const ATTEMPT_LEASE_MS = 120000;

export async function retryPaymentAttempt({
    orderNumber,
    guestAccessToken,
    idempotencyKey = null,
}) {
    const normalizedOrderNumber = String(orderNumber || '').trim();
    if (!normalizedOrderNumber) {
        const error = new Error('orderNumber is required.');
        error.statusCode = 400;
        throw error;
    }

    const normalizedToken = String(guestAccessToken || '').trim();
    if (!normalizedToken) {
        const error = new Error('Valid guest access token is required to retry payment.');
        error.statusCode = 401;
        throw error;
    }

    const normalizedIdempotencyKey = idempotencyKey
        ? String(idempotencyKey).trim()
        : null;

    let orderSnapshot;
    let attemptSnapshot;
    let isReusedAttempt = false;
    let staleAttemptProviderOrderId = null;

    /*
    |--------------------------------------------------------------------------
    | Phase 1: Short DB Transaction
    |--------------------------------------------------------------------------
    */
    await withTransaction(async client => {
        // 1. Fetch order with row lock
        const orderRes = await client.query(
            `
            SELECT *
            FROM orders
            WHERE order_number = $1
            FOR UPDATE
            `,
            [normalizedOrderNumber]
        );

        if (!orderRes.rows.length) {
            const error = new Error(`Order ${normalizedOrderNumber} not found.`);
            error.statusCode = 404;
            throw error;
        }

        const order = orderRes.rows[0];

        // 2. Cryptographic guest access token verification
        const auth = verifyGuestAccessToken({
            token: normalizedToken,
            orderNumber: order.order_number,
            order,
        });

        if (!auth.valid) {
            const error = new Error('Valid guest access token is required to retry payment.');
            error.statusCode = 401;
            error.authReason = auth.reason;
            throw error;
        }

        // 3. Reject COD orders
        if (order.payment_method !== 'ONLINE') {
            const error = new Error('Only online payment orders are eligible for payment retry.');
            error.statusCode = 400;
            throw error;
        }

        // 4. Reject already paid orders
        if (order.payment_status === 'paid' || order.status === 'confirmed') {
            const error = new Error('Order has already been paid and cannot be retried.');
            error.statusCode = 409;
            throw error;
        }

        // 5. Reject cancelled orders
        if (order.status === 'cancelled') {
            const error = new Error('Cancelled orders cannot be retried.');
            error.statusCode = 400;
            throw error;
        }

        // 6. Fetch line items
        const itemRes = await client.query(
            `
            SELECT
                variant_id,
                product_name,
                variant_name,
                sku,
                quantity,
                unit_price,
                total_price,
                taxable_value,
                tax_rate,
                tax_amount,
                unit_price_includes_tax
            FROM order_items
            WHERE order_id = $1
            ORDER BY created_at ASC
            `,
            [order.id]
        );

        const items = itemRes.rows;

        // 7. Inspect all payment attempts for this order to enforce concurrency and ambiguity guards (CONC-02)
        const orderPaymentsRes = await client.query(
            `
            SELECT *
            FROM payments
            WHERE order_id = $1
            ORDER BY created_at DESC
            FOR UPDATE
            `,
            [order.id]
        );

        const existingPayments = orderPaymentsRes.rows;

        // 7-pre. A create row without a provider order id (written before the create
        // lifecycle was made durable) may already exist at Cashfree. Its outcome must be
        // resolved by lookup before any new provider order is considered.
        const unboundCreate = existingPayments.find(
            p => p.gateway_status === 'CASHFREE_PENDING' && !p.provider_order_id
        );
        if (unboundCreate) {
            const error = new Error(
                'A previous payment creation for this order has an unresolved outcome. Payment status must be verified before a new attempt can be created.'
            );
            error.statusCode = 409;
            error.code = 'PAYMENT_RESOLUTION_REQUIRED';
            throw error;
        }

        // 7-claim. A create row still waiting for the controller (CREATE_PENDING) has not
        // reached Cashfree. Closing it here takes it out of play, and the controller's
        // conditional claim then fails, so no provider order is created for it.
        await client.query(
            `
            UPDATE payments
            SET
                gateway_status = 'CREATE_NOT_SUBMITTED',
                status = 'failed',
                updated_at = NOW()
            WHERE order_id = $1
              AND gateway_status = 'CREATE_PENDING'
              AND provider_order_id IS NULL
            `,
            [order.id]
        );

        // 7a. Competing in-flight attempt guard:
        // If ANY payment attempt on this order is currently in-flight (ATTEMPT_INITIATED),
        // reject parallel attempts regardless of whether different idempotency keys are used.
        const inFlightPayment = existingPayments.find(
            p => p.gateway_status === 'ATTEMPT_INITIATED'
        );
        if (inFlightPayment) {
            // An attempt that has been in flight longer than the lease was not
            // completed: the process stopped, or the provider result was never saved.
            // Its outcome is unknown, so it moves to the ambiguous path, which
            // reconciliation resolves. No new provider order is created here.
            const staleCheck = await client.query(
                `
                SELECT (updated_at < NOW() - ($2::int * INTERVAL '1 millisecond')) AS stale
                FROM payments
                WHERE id = $1
                `,
                [inFlightPayment.id, ATTEMPT_LEASE_MS]
            );

            if (staleCheck.rows[0]?.stale) {
                await client.query(
                    `
                    UPDATE payments
                    SET gateway_status = 'GATEWAY_AMBIGUOUS_TIMEOUT', updated_at = NOW()
                    WHERE id = $1 AND gateway_status = 'ATTEMPT_INITIATED'
                    `,
                    [inFlightPayment.id]
                );
                staleAttemptProviderOrderId = inFlightPayment.provider_order_id;
                return;
            }

            const error = new Error(
                'A payment retry attempt is currently being processed for this order.'
            );
            error.statusCode = 409;
            error.providerOrderId = inFlightPayment.provider_order_id;
            throw error;
        }

        // 7b. Ambiguous timeout guard:
        // If ANY payment attempt on this order timed out ambiguously, block creation
        // of a new attempt until the earlier attempt is resolved via reconciliation.
        const ambiguousPayment = existingPayments.find(
            p => p.gateway_status === 'GATEWAY_AMBIGUOUS_TIMEOUT'
        );
        if (ambiguousPayment) {
            const error = new Error(
                `Payment attempt ${ambiguousPayment.provider_order_id} timed out and is awaiting status reconciliation. Please check payment status before retrying; new payment attempts cannot be created until the pending attempt is resolved.`
            );
            error.statusCode = 504;
            error.providerOrderId = ambiguousPayment.provider_order_id;
            throw error;
        }

        // 7c. Check for reusable attempt matching idempotency key:
        if (normalizedIdempotencyKey) {
            const matchingPayment = existingPayments.find(
                p => p.idempotency_key === normalizedIdempotencyKey
            );

            if (matchingPayment) {
                // If matching attempt has a valid session and was not failed, reuse it
                if (
                    matchingPayment.gateway_status === 'ORDER_CREATED' &&
                    matchingPayment.raw_response?.payment_session_id
                ) {
                    isReusedAttempt = true;
                    orderSnapshot = mapOrderRow(order);
                    attemptSnapshot = {
                        payment: mapPaymentRow(matchingPayment),
                        rawResponse: matchingPayment.raw_response,
                        items: items.map(mapOrderItemRow),
                    };
                    return;
                }
            }
        }

        // 7d. No idempotency key: reuse a provider session only while its recorded expiry is
        // still in the future. A keyless retry after expiry must still create a new session.
        // A session with no recorded expiry is never reused.
        if (!normalizedIdempotencyKey) {
            const now = Date.now();
            const liveSession = existingPayments.find(p => {
                const expiry = p.raw_response?.order_expiry_time;
                return (
                    p.gateway_status === 'ORDER_CREATED' &&
                    p.status !== 'paid' &&
                    p.raw_response?.payment_session_id &&
                    expiry &&
                    new Date(expiry).getTime() > now
                );
            });

            if (liveSession) {
                isReusedAttempt = true;
                orderSnapshot = mapOrderRow(order);
                attemptSnapshot = {
                    payment: mapPaymentRow(liveSession),
                    rawResponse: liveSession.raw_response,
                    items: items.map(mapOrderItemRow),
                };
                return;
            }
        }

        // 8. Re-verify inventory availability for all items (deterministic locking)
        const variantAggMap = new Map();
        for (const item of items) {
            const vId = String(item.variant_id).trim();
            variantAggMap.set(
                vId,
                (variantAggMap.get(vId) || 0) + Number(item.quantity)
            );
        }

        const sortedVariantIds = Array.from(variantAggMap.keys()).sort();

        const invRes = await client.query(
            `
            SELECT
                variant_id,
                quantity_on_hand,
                quantity_reserved,
                GREATEST(quantity_on_hand - quantity_reserved, 0) AS available_quantity
            FROM inventory
            WHERE variant_id = ANY($1::uuid[])
            ORDER BY variant_id ASC
            FOR UPDATE
            `,
            [sortedVariantIds]
        );

        const invMap = new Map(
            invRes.rows.map(r => [r.variant_id, Number(r.available_quantity || 0)])
        );

        for (const vId of sortedVariantIds) {
            const requiredQty = variantAggMap.get(vId);
            const availableQty = invMap.get(vId) ?? 0;

            if (availableQty < requiredQty) {
                const error = new Error(
                    `Insufficient inventory to retry payment. Required: ${requiredQty}, available: ${availableQty}.`
                );
                error.statusCode = 409;
                error.availableQuantity = availableQty;
                error.requiredQuantity = requiredQty;
                throw error;
            }
        }

        // 9. Generate next attempt identifier: {order_number}-R{N}
        const countRes = await client.query(
            `
            SELECT COUNT(*) AS count
            FROM payments
            WHERE order_id = $1
            `,
            [order.id]
        );

        const attemptNumber = Number(countRes.rows[0]?.count || 0) + 1;
        const providerOrderId = `${order.order_number}-R${attemptNumber}`;

        // 10. Persist attempt record BEFORE calling Cashfree
        const insertRes = await client.query(
            `
            INSERT INTO payments (
                order_id,
                provider,
                provider_order_id,
                amount,
                currency,
                status,
                gateway_status,
                payment_method,
                idempotency_key,
                created_at,
                updated_at
            )
            VALUES (
                $1,
                'cashfree',
                $2,
                $3,
                'INR',
                'created',
                'ATTEMPT_INITIATED',
                'ONLINE',
                $4,
                NOW(),
                NOW()
            )
            RETURNING *
            `,
            [
                order.id,
                providerOrderId,
                order.total_amount,
                normalizedIdempotencyKey,
            ]
        );

        orderSnapshot = mapOrderRow(order);
        attemptSnapshot = {
            payment: mapPaymentRow(insertRes.rows[0]),
            paymentId: insertRes.rows[0].id,
            providerOrderId,
            amount: Number(order.total_amount),
            customer: {
                name: order.customer_name,
                phone: order.phone,
                email: order.email,
            },
            notes: order.notes,
            items: items.map(mapOrderItemRow),
        };
    });

    // The attempt was persisted before the call but its result was never saved.
    // Surface it as ambiguous: reconciliation resolves it, and no new attempt is created.
    if (staleAttemptProviderOrderId) {
        const error = new Error(
            `Payment attempt ${staleAttemptProviderOrderId} was interrupted before its provider result was saved and is awaiting status reconciliation. Please check payment status before retrying.`
        );
        error.statusCode = 504;
        error.providerOrderId = staleAttemptProviderOrderId;
        throw error;
    }

    // If returning an existing session (idempotency key matched)
    if (isReusedAttempt) {
        const raw = attemptSnapshot.rawResponse || {};
        return {
            existing: true,
            order: orderSnapshot,
            payment: attemptSnapshot.payment,
            items: attemptSnapshot.items,
            cashfree: {
                orderId:
                    raw.order_id ||
                    attemptSnapshot.payment.provider_order_id,
                cfOrderId: raw.cf_order_id || null,
                paymentSessionId: raw.payment_session_id,
                orderStatus: raw.order_status || null,
            },
        };
    }

    /*
    |--------------------------------------------------------------------------
    | Phase 2: Cashfree Call (Outside DB Transaction)
    |--------------------------------------------------------------------------
    */
    let cashfreeOrder;
    let callError = null;
    let isAmbiguous = false;

    try {
        cashfreeOrder = await createCashfreeOrder({
            orderId: attemptSnapshot.providerOrderId,
            orderAmount: attemptSnapshot.amount,
            customer: attemptSnapshot.customer,
            orderNote:
                attemptSnapshot.notes ||
                `Retry payment for order ${orderSnapshot.order_number}`,
        });
    } catch (err) {
        callError = err;
        const msg = String(err.message || '').toLowerCase();
        const code = err.statusCode || err.code;

        if (
            code === 504 ||
            code === 502 ||
            code === 'ETIMEDOUT' ||
            code === 'ECONNRESET' ||
            code === 'UND_ERR_CONNECT_TIMEOUT' ||
            msg.includes('timeout') ||
            msg.includes('network')
        ) {
            isAmbiguous = true;
        }
    }

    /*
    |--------------------------------------------------------------------------
    | Phase 3: Post-Network DB Update
    |--------------------------------------------------------------------------
    */
    if (cashfreeOrder && cashfreeOrder.payment_session_id) {
        const updateRes = await query(
            `
            UPDATE payments
            SET
                gateway_status = 'ORDER_CREATED',
                status = 'created',
                raw_response = $2::jsonb,
                updated_at = NOW()
            WHERE id = $1
            RETURNING *
            `,
            [attemptSnapshot.paymentId, JSON.stringify(cashfreeOrder)]
        );

        return {
            existing: false,
            order: orderSnapshot,
            payment: mapPaymentRow(updateRes.rows[0]),
            items: attemptSnapshot.items,
            cashfree: {
                orderId: cashfreeOrder.order_id,
                cfOrderId: cashfreeOrder.cf_order_id || null,
                paymentSessionId: cashfreeOrder.payment_session_id,
                orderStatus: cashfreeOrder.order_status || null,
            },
        };
    }

    if (isAmbiguous) {
        await query(
            `
            UPDATE payments
            SET
                gateway_status = 'GATEWAY_AMBIGUOUS_TIMEOUT',
                updated_at = NOW()
            WHERE id = $1
            `,
            [attemptSnapshot.paymentId]
        );

        const error = new Error(
            `Cashfree order creation timed out. Payment attempt preserved as ${attemptSnapshot.providerOrderId} for status reconciliation.`
        );
        error.statusCode = 504;
        error.providerOrderId = attemptSnapshot.providerOrderId;
        throw error;
    }

    // Definite failure from Cashfree
    await query(
        `
        UPDATE payments
        SET
            gateway_status = 'CREATION_REJECTED',
            status = 'failed',
            raw_response = $2::jsonb,
            updated_at = NOW()
        WHERE id = $1
        `,
        [
            attemptSnapshot.paymentId,
            JSON.stringify(callError?.cashfreeResponse || { error: callError?.message }),
        ]
    );

    throw callError;
}