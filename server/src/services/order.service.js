import { query } from '../db/pool.js';
import { withTransaction } from '../db/transaction.js';

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


/*
|--------------------------------------------------------------------------
| Create Order
|--------------------------------------------------------------------------
|
| This method creates:
|
| 1. Order
| 2. Order items
| 3. Inventory reservation
| 4. Payment record
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


    const normalizedItems =
        normalizeItems(
            items
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

    if (
        normalizedIdempotencyKey
    ) {
        const existingResult =
            await query(
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

                WHERE
                    o.idempotency_key =
                    $1

                LIMIT 1
                `,
                [
                    normalizedIdempotencyKey,
                ]
            );


        if (
            existingResult.rows.length
        ) {
            const row =
                existingResult.rows[0];


            const existingItemsResult =
                await query(
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


            return {
                existing: true,

                order: {
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
                            row.subtotal
                        ),

                    discount_amount:
                        Number(
                            row.discount_amount
                        ),

                    shipping_amount:
                        Number(
                            row.shipping_amount
                        ),

                    tax_amount:
                        Number(
                            row.tax_amount
                        ),

                    total_amount:
                        Number(
                            row.total_amount
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
                            row.tax_rate
                        ),

                    price_includes_tax:
                        row.price_includes_tax,

                    created_at:
                        row.created_at,
                },

                payment:
                    row.payment_id
                        ? {
                            id:
                                row.payment_id,

                            order_id:
                                row.id,

                            provider:
                                row.payment_provider,

                            provider_order_id:
                                row.provider_order_id,

                            provider_payment_id:
                                row.provider_payment_id,

                            amount:
                                Number(
                                    row.payment_amount
                                ),

                            currency:
                                row.payment_currency,

                            status:
                                row.payment_status_record,

                            payment_method:
                                row.payment_method_record,

                            gateway_status:
                                row.gateway_status,

                            raw_response:
                                row.payment_raw_response,
                        }
                        : null,

                items: existingItemsResult.rows.map(
                    mapOrderItemRow
                ),
            };
        }
    }


    /*
    |--------------------------------------------------------------------------
    | Transaction
    |--------------------------------------------------------------------------
    */

    return withTransaction(
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
                // Serialize requests sharing an idempotency key. SELECT FOR
                // UPDATE cannot lock a row that does not exist yet.
                await client.query(
                    `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
                    [normalizedIdempotencyKey]
                );

                const duplicateResult =
                    await client.query(
                        `
                        SELECT
                            id,
                            order_number
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
                            ORDER BY created_at DESC
                            LIMIT 1
                            `,
                            [
                                existingOrderId,
                            ]
                        );


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
                            paymentResult
                                .rows[0]
                                ? mapPaymentRow(
                                    paymentResult
                                        .rows[0]
                                )
                                : null,

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
                | Lock inventory row
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

                        FOR UPDATE
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


                /*
                |--------------------------------------------------------------------------
                | Reserve inventory
                |--------------------------------------------------------------------------
                */

                await reserveInventory(
                    client,

                    item.variantId,

                    item.quantity,

                    order.id
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


            const gatewayStatus =
                normalizedPaymentMethod ===
                    'ONLINE'
                    ? 'CASHFREE_PENDING'
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