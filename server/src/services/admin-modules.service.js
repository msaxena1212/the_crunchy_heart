import { query } from '../db/pool.js';
import { assertActiveAdmin } from './admin-refund.service.js';

/*
|--------------------------------------------------------------------------
| Admin modules: dashboard, catalogue, inventory, coupons, customers,
| analytics status, and social media drafts
|--------------------------------------------------------------------------
| Read endpoints return identifiers, names, counts, and statuses. Credentials are never returned:
| integration status reports which configuration NAMES are present, never their values.
| Social posts are drafts only. Publishing is not implemented, and an account must be connected
| before the platform is reported as ready.
|--------------------------------------------------------------------------
*/

export const SOCIAL_PLATFORMS = Object.freeze(['instagram', 'tiktok', 'youtube', 'pinterest']);

// Environment names each integration needs. Only presence is reported.
const INTEGRATION_ENV = Object.freeze({
    analytics: ['GA_PROPERTY_ID', 'GOOGLE_APPLICATION_CREDENTIALS'],
    instagram: ['INSTAGRAM_ACCESS_TOKEN', 'INSTAGRAM_BUSINESS_ACCOUNT_ID'],
    tiktok: ['TIKTOK_ACCESS_TOKEN'],
    youtube: ['YOUTUBE_CLIENT_ID', 'YOUTUBE_CLIENT_SECRET', 'YOUTUBE_REFRESH_TOKEN'],
    pinterest: ['PINTEREST_ACCESS_TOKEN'],
});

function integrationStatus(names) {
    const missing = names.filter(name => !process.env[name] || !String(process.env[name]).trim());
    return { connected: missing.length === 0, missingConfig: missing };
}

const toNumber = value => Number(value || 0);

export async function dashboardSummary({ actor }) {
    await assertActiveAdmin(actor);

    const orders = await query(
        `SELECT
            COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '1 day')::int AS orders_24h,
            COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days')::int AS orders_7d,
            COUNT(*)::int AS orders_total,
            COALESCE(SUM(total_amount) FILTER (
                WHERE payment_status = 'paid' AND created_at > NOW() - INTERVAL '30 days'
            ), 0) AS paid_revenue_30d,
            COUNT(*) FILTER (
                WHERE payment_method = 'ONLINE' AND payment_status <> 'paid' AND status <> 'cancelled'
            )::int AS awaiting_online_payment
         FROM orders`
    );

    const attention = await query(
        `SELECT
            (SELECT COUNT(*)::int FROM payments
               WHERE gateway_status IN ('ATTEMPT_INITIATED', 'GATEWAY_AMBIGUOUS_TIMEOUT')
                  OR (gateway_status = 'CASHFREE_PENDING' AND provider_order_id IS NULL)) AS payments_to_review,
            (SELECT COUNT(*)::int FROM refunds
               WHERE status IN ('manual_review', 'reconciliation_required')) AS refund_exceptions,
            (SELECT COUNT(*)::int FROM inventory i
               JOIN product_variants v ON v.id = i.variant_id
               WHERE v.is_active AND (i.quantity_on_hand - i.quantity_reserved) <= i.reorder_level) AS low_stock_variants,
            (SELECT COUNT(*)::int FROM coupons WHERE is_active) AS active_coupons,
            (SELECT COUNT(*)::int FROM products WHERE is_active) AS active_products`
    );

    const row = orders.rows[0];
    const flags = attention.rows[0];
    return {
        orders: {
            last24Hours: row.orders_24h,
            last7Days: row.orders_7d,
            total: row.orders_total,
            awaitingOnlinePayment: row.awaiting_online_payment,
        },
        revenue: { paidLast30Days: toNumber(row.paid_revenue_30d) },
        attention: {
            paymentsToReview: flags.payments_to_review,
            refundExceptions: flags.refund_exceptions,
            lowStockVariants: flags.low_stock_variants,
        },
        catalogue: { activeProducts: flags.active_products, activeCoupons: flags.active_coupons },
    };
}

export async function listProducts({ actor, search = '', limit = 100, category = '' }) {
    await assertActiveAdmin(actor);
    const cappedLimit = Math.min(Math.max(Number(limit) || 100, 1), 200);
    const term = `%${String(search || '').trim()}%`;
    const categorySlug = String(category || '').trim() || null;

    const result = await query(
        `SELECT p.id, p.name, p.slug, p.brand, p.is_active, p.is_featured, p.updated_at,
                c.name AS category_name, c.slug AS category_slug,
                sc.name AS subcategory_name,
                img.image_url,
                COUNT(v.id)::int AS variant_count,
                MIN(v.selling_price) FILTER (WHERE v.is_active) AS min_price,
                COALESCE(SUM(i.quantity_on_hand - i.quantity_reserved), 0)::int AS available_units
         FROM products p
         LEFT JOIN categories c ON c.id = p.category_id
         LEFT JOIN subcategories sc ON sc.id = p.subcategory_id
         LEFT JOIN LATERAL (
             SELECT pi.image_url FROM product_images pi
             WHERE pi.product_id = p.id AND pi.variant_id IS NULL
             ORDER BY pi.is_primary DESC, pi.sort_order ASC LIMIT 1
         ) img ON TRUE
         LEFT JOIN product_variants v ON v.product_id = p.id
         LEFT JOIN inventory i ON i.variant_id = v.id
         WHERE ($1 = '%%' OR p.name ILIKE $1 OR p.slug ILIKE $1)
           AND ($3::text IS NULL OR c.slug = $3)
         GROUP BY p.id, c.name, c.slug, c.sort_order, sc.name, img.image_url
         ORDER BY c.sort_order ASC NULLS LAST, p.sort_order ASC, p.name ASC
         LIMIT $2`,
        [term, cappedLimit, categorySlug]
    );

    return {
        products: result.rows.map(row => ({
            id: row.id,
            name: row.name,
            slug: row.slug,
            brand: row.brand,
            category: row.category_name,
            categorySlug: row.category_slug,
            subcategory: row.subcategory_name,
            imageUrl: row.image_url,
            isActive: row.is_active,
            isFeatured: row.is_featured,
            variantCount: row.variant_count,
            fromPrice: row.min_price === null ? null : toNumber(row.min_price),
            availableUnits: row.available_units,
            updatedAt: row.updated_at,
        })),
    };
}

export async function listInventory({ actor, lowStockOnly = false, limit = 200 }) {
    await assertActiveAdmin(actor);
    const cappedLimit = Math.min(Math.max(Number(limit) || 200, 1), 500);

    const result = await query(
        `SELECT v.id, v.sku, v.variant_name, v.is_active, p.name AS product_name,
                i.quantity_on_hand, i.quantity_reserved, i.reorder_level,
                (i.quantity_on_hand - i.quantity_reserved) AS available
         FROM inventory i
         JOIN product_variants v ON v.id = i.variant_id
         JOIN products p ON p.id = v.product_id
         WHERE ($1::boolean = FALSE OR (i.quantity_on_hand - i.quantity_reserved) <= i.reorder_level)
         ORDER BY available ASC, p.name ASC
         LIMIT $2`,
        [Boolean(lowStockOnly), cappedLimit]
    );

    return {
        variants: result.rows.map(row => ({
            id: row.id,
            sku: row.sku,
            productName: row.product_name,
            variantName: row.variant_name,
            isActive: row.is_active,
            onHand: row.quantity_on_hand,
            reserved: row.quantity_reserved,
            available: row.available,
            reorderLevel: row.reorder_level,
            lowStock: row.available <= row.reorder_level,
        })),
    };
}

export async function listCoupons({ actor, limit = 200 }) {
    await assertActiveAdmin(actor);
    const cappedLimit = Math.min(Math.max(Number(limit) || 200, 1), 500);

    const result = await query(
        `SELECT id, code, description, discount_type, discount_value, minimum_order_value,
                maximum_discount, usage_limit, usage_count, per_customer_limit,
                starts_at, expires_at, is_active, created_at
         FROM coupons
         ORDER BY created_at DESC
         LIMIT $1`,
        [cappedLimit]
    );

    return {
        coupons: result.rows.map(row => ({
            id: row.id,
            code: row.code,
            description: row.description,
            discountType: row.discount_type,
            discountValue: toNumber(row.discount_value),
            minimumOrderValue: toNumber(row.minimum_order_value),
            maximumDiscount: row.maximum_discount === null ? null : toNumber(row.maximum_discount),
            usageLimit: row.usage_limit,
            usageCount: row.usage_count,
            perCustomerLimit: row.per_customer_limit,
            startsAt: row.starts_at,
            expiresAt: row.expires_at,
            isActive: row.is_active,
        })),
    };
}

export async function listCustomers({ actor, search = '', limit = 100 }) {
    await assertActiveAdmin(actor);
    const cappedLimit = Math.min(Math.max(Number(limit) || 100, 1), 200);
    const term = `%${String(search || '').trim()}%`;

    // Customers are derived from orders. Only checkout details are used, never sessions or tokens.
    const result = await query(
        `SELECT phone,
                (ARRAY_AGG(customer_name ORDER BY created_at DESC))[1] AS customer_name,
                (ARRAY_AGG(email ORDER BY created_at DESC) FILTER (WHERE email IS NOT NULL))[1] AS email,
                COUNT(*)::int AS order_count,
                COALESCE(SUM(total_amount) FILTER (WHERE payment_status = 'paid'), 0) AS paid_total,
                MAX(created_at) AS last_order_at
         FROM orders
         WHERE phone IS NOT NULL
           AND ($1 = '%%' OR customer_name ILIKE $1 OR phone ILIKE $1 OR email ILIKE $1)
         GROUP BY phone
         ORDER BY MAX(created_at) DESC
         LIMIT $2`,
        [term, cappedLimit]
    );

    return {
        customers: result.rows.map(row => ({
            phone: row.phone,
            name: row.customer_name,
            email: row.email,
            orderCount: row.order_count,
            paidTotal: toNumber(row.paid_total),
            lastOrderAt: row.last_order_at,
        })),
    };
}

export async function integrationsStatus({ actor }) {
    await assertActiveAdmin(actor);
    return {
        analytics: integrationStatus(INTEGRATION_ENV.analytics),
        socialAccounts: Object.fromEntries(
            SOCIAL_PLATFORMS.map(platform => [platform, integrationStatus(INTEGRATION_ENV[platform])])
        ),
    };
}

const POST_LIMITS = { title: 200, body: 2200 };

function validatePostInput(input) {
    const errors = [];
    const platform = String(input.platform || '').toLowerCase();
    if (!SOCIAL_PLATFORMS.includes(platform)) errors.push('platform must be one of: ' + SOCIAL_PLATFORMS.join(', '));
    const title = String(input.title || '').trim();
    if (!title || title.length > POST_LIMITS.title) errors.push(`title is required (max ${POST_LIMITS.title} characters)`);
    const body = String(input.body || '').trim();
    if (!body || body.length > POST_LIMITS.body) errors.push(`body is required (max ${POST_LIMITS.body} characters)`);
    let mediaUrl = null;
    if (input.mediaUrl) {
        try {
            const url = new URL(String(input.mediaUrl));
            if (url.protocol !== 'https:') errors.push('mediaUrl must use https');
            mediaUrl = url.toString();
        } catch {
            errors.push('mediaUrl must be a valid URL');
        }
    }
    if (errors.length) {
        throw Object.assign(new Error(errors.join('; ')), { statusCode: 400, code: 'VALIDATION' });
    }
    return { platform, title, body, mediaUrl };
}

// Maps a social_post_drafts row to the camelCase shape the console reads.
function toDraft(row) {
    return {
        id: row.id,
        platform: row.platform,
        title: row.title,
        body: row.body,
        mediaUrl: row.media_url,
        status: row.status,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

export async function listSocialDrafts({ actor, platform }) {
    await assertActiveAdmin(actor);
    const filter = platform ? String(platform).toLowerCase() : null;
    const result = await query(
        `SELECT id, platform, title, body, media_url, status, created_at, updated_at
         FROM social_post_drafts
         WHERE ($1::text IS NULL OR platform = $1)
         ORDER BY updated_at DESC
         LIMIT 200`,
        [filter]
    );
    return {
        drafts: result.rows.map(toDraft),
    };
}

export async function createSocialDraft({ actor, input }) {
    await assertActiveAdmin(actor);
    const post = validatePostInput(input);
    const result = await query(
        `INSERT INTO social_post_drafts (platform, title, body, media_url, status, created_by)
         VALUES ($1, $2, $3, $4, 'draft', $5)
         RETURNING id, platform, title, body, media_url, status, created_at, updated_at`,
        [post.platform, post.title, post.body, post.mediaUrl, actor.id]
    );
    await query(
        `INSERT INTO admin_audit_logs (admin_user_id, action, entity_type, entity_id, details)
         VALUES ($1, 'social_post.draft_created', 'social_post', $2, $3::jsonb)`,
        [actor.id, String(result.rows[0].id), JSON.stringify({ platform: post.platform })]
    );
    return { draft: toDraft(result.rows[0]) };
}

export async function updateSocialDraft({ actor, draftId, input }) {
    await assertActiveAdmin(actor);
    const post = validatePostInput(input);
    const updated = await query(
        `UPDATE social_post_drafts
         SET platform = $2, title = $3, body = $4, media_url = $5, updated_at = NOW()
         WHERE id = $1 AND status = 'draft'
         RETURNING id, platform, title, body, media_url, status, created_at, updated_at`,
        [draftId, post.platform, post.title, post.body, post.mediaUrl]
    );
    if (!updated.rows.length) {
        throw Object.assign(new Error('Draft not found, or it is no longer a draft.'), { statusCode: 404, code: 'NOT_FOUND' });
    }
    await query(
        `INSERT INTO admin_audit_logs (admin_user_id, action, entity_type, entity_id, details)
         VALUES ($1, 'social_post.draft_updated', 'social_post', $2, $3::jsonb)`,
        [actor.id, String(draftId), JSON.stringify({ platform: post.platform })]
    );
    return { draft: toDraft(updated.rows[0]) };
}

/*
 * Publishing is not implemented in this build. The request is refused for every platform, and the
 * reason says whether the account is connected, so the operator knows what is missing.
 */
export async function publishSocialDraft({ actor, draftId }) {
    await assertActiveAdmin(actor);
    const draft = await query(`SELECT platform FROM social_post_drafts WHERE id = $1`, [draftId]);
    if (!draft.rows.length) {
        throw Object.assign(new Error('Draft not found.'), { statusCode: 404, code: 'NOT_FOUND' });
    }
    const status = integrationStatus(INTEGRATION_ENV[draft.rows[0].platform]);
    throw Object.assign(
        new Error(status.connected
            ? 'Publishing is not available in this build yet. The draft is saved.'
            : `Publishing is disabled until the ${draft.rows[0].platform} account is connected. Missing configuration: ${status.missingConfig.join(', ')}.`),
        { statusCode: 409, code: 'PUBLISHING_UNAVAILABLE' }
    );
}
