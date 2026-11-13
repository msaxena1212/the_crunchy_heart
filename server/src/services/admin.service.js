import { query } from '../db/pool.js';
import { withTransaction } from '../db/transaction.js';
import { deductOrderInventory } from './inventory.service.js';

/**
 * List orders with bounded pagination, filtering, and safe field mapping for owner dashboard.
 */
export async function listOrdersAdmin({
    page = 1,
    limit = 20,
    status,
    paymentMethod,
    paymentStatus,
    search,
} = {}) {
    const parsedPage = parseInt(page, 10);
    const pageNum = (!isNaN(parsedPage) && parsedPage > 0) ? parsedPage : 1;
    const parsedLimit = parseInt(limit, 10);
    const limitNum = (!isNaN(parsedLimit) && parsedLimit > 0) ? Math.min(50, parsedLimit) : 20;
    const offset = (pageNum - 1) * limitNum;

    const conditions = [];
    const values = [];
    let paramIndex = 1;

    if (status && typeof status === 'string' && status.trim()) {
        conditions.push(`o.status = $${paramIndex++}`);
        values.push(status.trim());
    }

    if (paymentMethod && typeof paymentMethod === 'string' && paymentMethod.trim()) {
        conditions.push(`o.payment_method = $${paramIndex++}`);
        values.push(paymentMethod.trim().toUpperCase());
    }

    if (paymentStatus && typeof paymentStatus === 'string' && paymentStatus.trim()) {
        conditions.push(`o.payment_status = $${paramIndex++}`);
        values.push(paymentStatus.trim().toLowerCase());
    }

    if (search && typeof search === 'string' && search.trim()) {
        const searchTerm = `%${search.trim()}%`;
        conditions.push(
            `(o.order_number ILIKE $${paramIndex} OR o.customer_name ILIKE $${paramIndex} OR o.phone ILIKE $${paramIndex})`
        );
        values.push(searchTerm);
        paramIndex++;
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const listQuery = `
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
            o.notes,
            o.created_at,
            o.updated_at,
            COUNT(*) OVER() AS total_count,
            COUNT(oi.id) AS item_count
        FROM orders o
        LEFT JOIN order_items oi ON oi.order_id = o.id
        ${whereClause}
        GROUP BY o.id
        ORDER BY o.created_at DESC
        LIMIT $${paramIndex++} OFFSET $${paramIndex++}
    `;

    values.push(limitNum, offset);

    const result = await query(listQuery, values);
    const total = result.rows.length ? parseInt(result.rows[0].total_count, 10) : 0;
    const totalPages = Math.ceil(total / limitNum);

    const orders = result.rows.map((row) => ({
        id: row.id,
        orderNumber: row.order_number,
        customerName: row.customer_name,
        phone: row.phone,
        email: row.email,
        subtotal: Number(row.subtotal),
        discountAmount: Number(row.discount_amount),
        shippingAmount: Number(row.shipping_amount),
        taxAmount: Number(row.tax_amount),
        totalAmount: Number(row.total_amount),
        currency: row.currency,
        status: row.status,
        paymentStatus: row.payment_status,
        paymentMethod: row.payment_method,
        notes: row.notes,
        itemCount: Number(row.item_count),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        canDispatch: (row.payment_method === 'COD' && row.status === 'confirmed') ||
                     (row.payment_method === 'ONLINE' && row.payment_status === 'paid' && (row.status === 'confirmed' || row.status === 'paid')),
    }));

    return {
        orders,
        pagination: {
            page: pageNum,
            limit: limitNum,
            total,
            totalPages,
        },
    };
}

/**
 * Retrieve comprehensive order details for the owner dashboard.
 * Includes items, payments, refunds, status history, and operational dispatch readiness.
 */
export async function getOrderDetailsAdmin(orderNumber) {
    if (!orderNumber || typeof orderNumber !== 'string') {
        const error = new Error('Valid order number is required.');
        error.statusCode = 400;
        throw error;
    }

    const orderResult = await query(
        `
        SELECT
            id,
            order_number,
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
            payment_method,
            notes,
            created_at,
            updated_at
        FROM orders
        WHERE order_number = $1
        LIMIT 1
        `,
        [orderNumber.trim()]
    );

    if (!orderResult.rows.length) {
        const error = new Error(`Order ${orderNumber} not found.`);
        error.statusCode = 404;
        throw error;
    }

    const order = orderResult.rows[0];

    // Order items
    const itemsResult = await query(
        `
        SELECT
            id,
            variant_id,
            product_name,
            variant_name,
            sku,
            quantity,
            unit_price,
            total_price,
            taxable_value,
            tax_rate,
            tax_amount
        FROM order_items
        WHERE order_id = $1
        ORDER BY created_at ASC
        `,
        [order.id]
    );

    // Payment attempts
    const paymentsResult = await query(
        `
        SELECT
            id,
            provider,
            provider_order_id,
            provider_payment_id,
            amount,
            currency,
            status,
            gateway_status,
            created_at,
            updated_at
        FROM payments
        WHERE order_id = $1
        ORDER BY created_at DESC
        `,
        [order.id]
    );

    // Refunds
    const refundsResult = await query(
        `
        SELECT
            id,
            payment_id,
            amount,
            reason,
            status,
            provider_refund_id,
            created_at,
            updated_at
        FROM refunds
        WHERE order_id = $1
        ORDER BY created_at DESC
        `,
        [order.id]
    );

    // Status transition audit history
    const statusHistoryResult = await query(
        `
        SELECT
            id,
            status,
            note,
            created_at
        FROM order_status_history
        WHERE order_id = $1
        ORDER BY created_at DESC
        `,
        [order.id]
    );

    return {
        order: {
            id: order.id,
            orderNumber: order.order_number,
            customerName: order.customer_name,
            phone: order.phone,
            email: order.email,
            shippingAddress: order.shipping_address,
            billingAddress: order.billing_address,
            subtotal: Number(order.subtotal),
            discountAmount: Number(order.discount_amount),
            shippingAmount: Number(order.shipping_amount),
            taxAmount: Number(order.tax_amount),
            totalAmount: Number(order.total_amount),
            currency: order.currency,
            status: order.status,
            paymentStatus: order.payment_status,
            paymentMethod: order.payment_method,
            notes: order.notes,
            createdAt: order.created_at,
            updatedAt: order.updated_at,
        },
        items: itemsResult.rows.map((row) => ({
            id: row.id,
            variantId: row.variant_id,
            productName: row.product_name,
            variantName: row.variant_name,
            sku: row.sku,
            quantity: Number(row.quantity),
            unitPrice: Number(row.unit_price),
            totalPrice: Number(row.total_price),
            taxableValue: Number(row.taxable_value),
            taxRate: Number(row.tax_rate),
            taxAmount: Number(row.tax_amount),
        })),
        payments: paymentsResult.rows.map((row) => ({
            id: row.id,
            provider: row.provider,
            providerOrderId: row.provider_order_id,
            providerPaymentId: row.provider_payment_id,
            amount: Number(row.amount),
            currency: row.currency,
            status: row.status,
            gatewayStatus: row.gateway_status,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
        })),
        refunds: refundsResult.rows.map((row) => ({
            id: row.id,
            paymentId: row.payment_id,
            amount: Number(row.amount),
            reason: row.reason,
            status: row.status,
            providerRefundId: row.provider_refund_id,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
        })),
        statusHistory: statusHistoryResult.rows.map((row) => ({
            id: row.id,
            status: row.status,
            note: row.note,
            createdAt: row.created_at,
        })),
        canDispatch: (order.payment_method === 'COD' && order.status === 'confirmed') ||
                     (order.payment_method === 'ONLINE' && order.payment_status === 'paid' && (order.status === 'confirmed' || order.status === 'paid')),
    };
}

/**
 * Atomically dispatch an order (both Cash on Delivery and Prepaid ONLINE orders).
 *
 * Invariants:
 * 1. Lock parent order FIRST with SELECT ... FOR UPDATE.
 * 2. Validate payment eligibility:
 *    - COD orders must be in 'confirmed' status.
 *    - ONLINE orders must be in 'paid' payment_status and 'confirmed'/'paid' status. Unpaid ONLINE orders are rejected with 400.
 * 3. Validate status: reject already 'dispatched' with 409; reject 'cancelled' with 400.
 * 4. Deduct inventory atomically using deductOrderInventory (deadlock-free sorted locks, atomic rollback on stock shortage; idempotent for already-settled online orders).
 * 5. Record courier details (courierName, trackingNumber, trackingUrl) if provided.
 * 6. Update order status to 'dispatched'.
 * 7. Record order_status_history audit row with courier details.
 * 8. Record admin_audit_logs audit row.
 */
export async function dispatchOrderAdminService({
    orderNumber,
    adminUserId = null,
    courierName = null,
    trackingNumber = null,
    trackingUrl = null,
    notes = null,
}) {
    if (!orderNumber || typeof orderNumber !== 'string') {
        const error = new Error('Valid order number is required for dispatch.');
        error.statusCode = 400;
        throw error;
    }

    return await withTransaction(async (client) => {
        // 1. Lock parent order FIRST
        const orderResult = await client.query(
            `
            SELECT
                id,
                order_number,
                status,
                payment_status,
                payment_method,
                customer_name,
                total_amount,
                notes
            FROM orders
            WHERE order_number = $1
            FOR UPDATE
            `,
            [orderNumber.trim()]
        );

        if (!orderResult.rows.length) {
            const error = new Error(`Order ${orderNumber} not found.`);
            error.statusCode = 404;
            error.code = 'ORDER_NOT_FOUND';
            throw error;
        }

        const order = orderResult.rows[0];

        // 2. Validate dispatch eligibility based on payment method
        if (order.payment_method === 'COD') {
            if (order.status === 'dispatched') {
                const error = new Error(`Order ${orderNumber} has already been dispatched.`);
                error.statusCode = 409;
                error.code = 'ALREADY_DISPATCHED';
                throw error;
            }
            if (order.status !== 'confirmed') {
                const error = new Error(
                    `Order ${orderNumber} cannot be dispatched because its status is '${order.status}' (expected 'confirmed').`
                );
                error.statusCode = 400;
                error.code = 'ORDER_NOT_ELIGIBLE_FOR_DISPATCH';
                throw error;
            }
        } else if (order.payment_method === 'ONLINE') {
            if (order.status === 'dispatched') {
                const error = new Error(`Order ${orderNumber} has already been dispatched.`);
                error.statusCode = 409;
                error.code = 'ALREADY_DISPATCHED';
                throw error;
            }
            // Online orders MUST have payment_status === 'paid' to be dispatched
            if (order.payment_status !== 'paid') {
                const error = new Error(
                    `Only Cash on Delivery (COD) orders can be dispatched via this operation. Order ${orderNumber} has payment method: ${order.payment_method}.`
                );
                error.statusCode = 400;
                error.code = 'INVALID_PAYMENT_METHOD_FOR_COD_DISPATCH';
                throw error;
            }
            if (order.status !== 'confirmed' && order.status !== 'paid') {
                const error = new Error(
                    `Order ${orderNumber} cannot be dispatched because its status is '${order.status}' (expected 'confirmed' or 'paid').`
                );
                error.statusCode = 400;
                error.code = 'ORDER_NOT_ELIGIBLE_FOR_DISPATCH';
                throw error;
            }
        } else {
            const error = new Error(
                `Unsupported payment method for dispatch: ${order.payment_method}.`
            );
            error.statusCode = 400;
            error.code = 'INVALID_PAYMENT_METHOD_FOR_COD_DISPATCH';
            throw error;
        }

        // 3. Fetch line items
        const itemsResult = await client.query(
            `
            SELECT variant_id, quantity
            FROM order_items
            WHERE order_id = $1
            `,
            [order.id]
        );

        const items = itemsResult.rows.map((r) => ({
            variantId: r.variant_id,
            quantity: Number(r.quantity),
        }));

        if (!items.length) {
            const error = new Error(`Order ${orderNumber} contains no items to dispatch.`);
            error.statusCode = 400;
            error.code = 'EMPTY_ORDER_ITEMS';
            throw error;
        }

        // 4. Deduct inventory atomically (acquires sorted variant locks, validates all stock, records inventory_transactions)
        // Idempotent: if already deducted (e.g. during online payment success), returns existing records safely without double deduction
        const deductions = await deductOrderInventory(client, {
            orderId: order.id,
            items,
        });

        // 5. Courier and dispatch note formatting
        const courierDetails = [];
        if (courierName) courierDetails.push(`courier: ${courierName}`);
        if (trackingNumber) courierDetails.push(`tracking: ${trackingNumber}`);
        if (trackingUrl) courierDetails.push(`trackingUrl: ${trackingUrl}`);
        const courierSummary = courierDetails.length ? ` (${courierDetails.join(', ')})` : '';

        let updatedNotes = order.notes || '';
        if (courierDetails.length) {
            updatedNotes = updatedNotes ? `${updatedNotes}\n[DISPATCH] Dispatched with ${courierDetails.join(', ')}` : `[DISPATCH] Dispatched with ${courierDetails.join(', ')}`;
        }
        if (notes) {
            updatedNotes = updatedNotes ? `${updatedNotes}\n[NOTE] ${notes}` : `[NOTE] ${notes}`;
        }

        // 6. Update order status to 'dispatched'
        const updatedOrderResult = await client.query(
            `
            UPDATE orders
            SET
                status = 'dispatched',
                notes = $2,
                updated_at = NOW()
            WHERE id = $1
            RETURNING id, order_number, status, payment_method, payment_status, updated_at
            `,
            [order.id, updatedNotes || null]
        );

        const updatedOrder = updatedOrderResult.rows[0];

        // 7. Record in order_status_history
        const historyNote = `${order.payment_method} order dispatched by owner${adminUserId ? ` (admin: ${adminUserId})` : ''}${courierSummary}`;
        await client.query(
            `
            INSERT INTO order_status_history (
                order_id,
                status,
                note,
                created_at
            )
            VALUES ($1, 'dispatched', $2, NOW())
            `,
            [
                order.id,
                historyNote,
            ]
        );

        // 8. Record in admin_audit_logs
        await client.query(
            `
            INSERT INTO admin_audit_logs (
                admin_user_id,
                action,
                entity_type,
                entity_id,
                details,
                created_at
            )
            VALUES ($1, 'ORDER_DISPATCHED', 'order', $2, $3::jsonb, NOW())
            `,
            [
                adminUserId || null,
                order.order_number,
                JSON.stringify({
                    orderId: order.id,
                    orderNumber: order.order_number,
                    paymentMethod: order.payment_method,
                    itemCount: items.length,
                    deductionsCount: deductions.length,
                    courierName: courierName || null,
                    trackingNumber: trackingNumber || null,
                    trackingUrl: trackingUrl || null,
                    dispatchedAt: updatedOrder.updated_at,
                }),
            ]
        );

        return {
            success: true,
            orderNumber: updatedOrder.order_number,
            status: updatedOrder.status,
            previousStatus: order.status,
            paymentMethod: updatedOrder.payment_method,
            courierName: courierName || null,
            trackingNumber: trackingNumber || null,
            dispatchedAt: updatedOrder.updated_at,
            deductionsCount: deductions.length,
        };
    });
}

// Preserve backward-compatible alias and primary export
export const dispatchCodOrderAdmin = dispatchOrderAdminService;
export const dispatchOrderAdmin = dispatchOrderAdminService;

/**
 * List unresolved payment exceptions and pending refund reviews (read-only).
 * Includes:
 * - Orders with exception_stock_shortage notes or PAID_STOCK_UNAVAILABLE payments
 * - Sibling duplicate capture payments needing refund (PAID_DUPLICATE_ORDER_SETTLED)
 * - Refunds in 'pending' or 'processing' status
 */
export async function listPendingRefundsAdmin({ page = 1, limit = 20 } = {}) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
    const offset = (pageNum - 1) * limitNum;

    // Union query to capture all unresolved exception cases faithfully
    const exceptionsQuery = `
        WITH review_candidates AS (
            -- 1. Explicit refund records pending review
            SELECT
                r.id AS refund_id,
                r.order_id,
                r.payment_id,
                r.amount AS exception_amount,
                r.reason AS exception_reason,
                r.status AS refund_status,
                'REFUND_RECORD' AS exception_type,
                r.created_at AS exception_date
            FROM refunds r
            WHERE r.status IN ('pending', 'processing')

            UNION

            -- 2. Payments flagged as duplicate captured sibling attempts without confirmed refund
            SELECT
                r2.id AS refund_id,
                p.order_id,
                p.id AS payment_id,
                p.amount AS exception_amount,
                'Duplicate captured payment attempt requires refund review' AS exception_reason,
                COALESCE(r2.status, 'pending') AS refund_status,
                'DUPLICATE_PAYMENT_CAPTURED' AS exception_type,
                p.created_at AS exception_date
            FROM payments p
            LEFT JOIN refunds r2 ON r2.payment_id = p.id
            WHERE p.gateway_status = 'PAID_DUPLICATE_ORDER_SETTLED'
              AND (r2.status IS NULL OR r2.status IN ('pending', 'processing'))

            UNION

            -- 3. Payments flagged as stock unavailable
            SELECT
                r3.id AS refund_id,
                p3.order_id,
                p3.id AS payment_id,
                p3.amount AS exception_amount,
                'Paid order encountered stock shortage' AS exception_reason,
                COALESCE(r3.status, 'pending') AS refund_status,
                'PAID_STOCK_UNAVAILABLE' AS exception_type,
                p3.created_at AS exception_date
            FROM payments p3
            LEFT JOIN refunds r3 ON r3.payment_id = p3.id
            WHERE p3.gateway_status = 'PAID_STOCK_UNAVAILABLE'
              AND (r3.status IS NULL OR r3.status IN ('pending', 'processing'))
        )
        SELECT
            rc.refund_id,
            rc.exception_type,
            rc.exception_amount,
            rc.exception_reason,
            rc.refund_status,
            rc.exception_date,
            o.id AS order_id,
            o.order_number,
            o.customer_name,
            o.phone,
            o.email,
            o.status AS order_status,
            o.payment_status AS order_payment_status,
            o.payment_method,
            o.notes AS order_notes,
            p.provider_order_id,
            p.provider_payment_id,
            p.gateway_status AS payment_gateway_status,
            COUNT(*) OVER() AS total_count
        FROM review_candidates rc
        JOIN orders o ON o.id = rc.order_id
        LEFT JOIN payments p ON p.id = rc.payment_id
        ORDER BY rc.exception_date DESC
        LIMIT $1 OFFSET $2
    `;

    const result = await query(exceptionsQuery, [limitNum, offset]);
    const total = result.rows.length ? parseInt(result.rows[0].total_count, 10) : 0;
    const totalPages = Math.ceil(total / limitNum);

    const exceptions = result.rows.map((row) => ({
        refundId: row.refund_id,
        orderNumber: row.order_number,
        customerName: row.customer_name,
        phone: row.phone,
        email: row.email,
        amount: Number(row.exception_amount),
        reason: row.exception_reason,
        refundStatus: row.refund_status,
        exceptionType: row.exception_type,
        orderStatus: row.order_status,
        orderPaymentStatus: row.order_payment_status,
        paymentGatewayStatus: row.payment_gateway_status,
        providerPaymentId: row.provider_payment_id,
        orderNotes: row.order_notes,
        createdAt: row.exception_date,
    }));

    return {
        exceptions,
        pagination: {
            page: pageNum,
            limit: limitNum,
            total,
            totalPages,
        },
    };
}
