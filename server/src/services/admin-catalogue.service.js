import { query } from '../db/pool.js';
import { withTransaction } from '../db/transaction.js';
import { assertActiveAdmin } from './admin-refund.service.js';

/*
|--------------------------------------------------------------------------
| Admin catalogue editing
|--------------------------------------------------------------------------
| Lets the owner change product details, the product image, pack prices, stock and visibility.
| Every write is validated, runs in a transaction, and is recorded in admin_audit_logs.
| Identity always comes from the authenticated session, never from the request body.
|--------------------------------------------------------------------------
*/

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IMAGE_PATH_RE = /^assets\/[a-z0-9][a-z0-9/_.-]*\.(webp|png|jpe?g|svg)$/i;
const MAX_MONEY = 1_000_000;
const MAX_STOCK = 1_000_000;

const toNumber = value => Number(value || 0);
const badRequest = message => Object.assign(new Error(message), { statusCode: 400, code: 'VALIDATION' });
const notFound = message => Object.assign(new Error(message), { statusCode: 404, code: 'NOT_FOUND' });
const conflict = message => Object.assign(new Error(message), { statusCode: 409, code: 'CONFLICT' });

function assertUuid(value, label) {
    if (!UUID_RE.test(String(value || ''))) {
        throw notFound(`${label} not found.`);
    }
    return String(value);
}

function parseMoney(value, label) {
    if (value === '' || value === null || value === undefined) {
        throw badRequest(`${label} is required.`);
    }
    const amount = Number(value);
    if (!Number.isFinite(amount) || amount < 0 || amount > MAX_MONEY) {
        throw badRequest(`${label} must be a number between 0 and ${MAX_MONEY.toLocaleString('en-IN')}.`);
    }
    return Math.round(amount * 100) / 100;
}

function parseCount(value, label) {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 0 || n > MAX_STOCK) {
        throw badRequest(`${label} must be a whole number between 0 and ${MAX_STOCK.toLocaleString('en-IN')}.`);
    }
    return n;
}

/** Image paths must point at the storefront's assets folder or be an https URL. Nothing else is accepted. */
export function parseImageUrl(value) {
    if (value === null || value === undefined || String(value).trim() === '') {
        return null;
    }
    const text = String(value).trim();
    if (text.length > 500) {
        throw badRequest('Image URL is too long.');
    }
    if (text.startsWith('assets/')) {
        if (text.includes('..') || !IMAGE_PATH_RE.test(text)) {
            throw badRequest('Image path must look like assets/products/name.webp (webp, png, jpg or svg).');
        }
        return text;
    }
    let url;
    try {
        url = new URL(text);
    } catch {
        throw badRequest('Image must be an assets/... path or a full https:// URL.');
    }
    if (url.protocol !== 'https:') {
        throw badRequest('Image URLs must use https.');
    }
    return url.toString();
}

const audit = (client, actor, action, entityType, entityId, details) =>
    client.query(
        `INSERT INTO admin_audit_logs (admin_user_id, action, entity_type, entity_id, details)
         VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [actor.id, action, entityType, String(entityId), JSON.stringify(details || {})]
    );

function toAdminVariant(row) {
    const onHand = row.quantity_on_hand ?? 0;
    const reserved = row.quantity_reserved ?? 0;
    const price = toNumber(row.selling_price);
    return {
        id: row.id,
        sku: row.sku,
        name: row.variant_name,
        weightGrams: row.weight_grams,
        mrp: toNumber(row.mrp),
        sellingPrice: price,
        taxRate: toNumber(row.tax_rate),
        badge: row.badge,
        isActive: row.is_active,
        onHand,
        reserved,
        available: onHand - reserved,
        reorderLevel: row.reorder_level ?? 0,
        pricePerKg: row.weight_grams ? Math.round(((price * 1000) / row.weight_grams) * 100) / 100 : null,
    };
}

async function loadAdminProduct(runner, productId) {
    const product = await runner.query(
        `SELECT p.id, p.name, p.slug, p.description, p.short_description, p.brand, p.is_active, p.is_featured,
                p.updated_at, c.name AS category_name, c.slug AS category_slug, sc.name AS subcategory_name,
                img.image_url
         FROM products p
         LEFT JOIN categories c ON c.id = p.category_id
         LEFT JOIN subcategories sc ON sc.id = p.subcategory_id
         LEFT JOIN LATERAL (
             SELECT pi.image_url FROM product_images pi
             WHERE pi.product_id = p.id AND pi.variant_id IS NULL
             ORDER BY pi.is_primary DESC, pi.sort_order ASC LIMIT 1
         ) img ON TRUE
         WHERE p.id = $1`,
        [productId]
    );
    if (!product.rows.length) {
        throw notFound('Product not found.');
    }

    const variants = await runner.query(
        `SELECT v.id, v.sku, v.variant_name, v.weight_grams, v.mrp, v.selling_price, v.tax_rate, v.badge, v.is_active,
                i.quantity_on_hand, i.quantity_reserved, i.reorder_level
         FROM product_variants v
         LEFT JOIN inventory i ON i.variant_id = v.id
         WHERE v.product_id = $1
         ORDER BY v.sort_order ASC, v.weight_grams ASC NULLS LAST, v.variant_name ASC`,
        [productId]
    );

    const row = product.rows[0];
    return {
        product: {
            id: row.id,
            name: row.name,
            slug: row.slug,
            description: row.description,
            shortDescription: row.short_description,
            brand: row.brand,
            category: row.category_name,
            categorySlug: row.category_slug,
            subcategory: row.subcategory_name,
            imageUrl: row.image_url,
            isActive: row.is_active,
            isFeatured: row.is_featured,
            updatedAt: row.updated_at,
        },
        variants: variants.rows.map(toAdminVariant),
    };
}

export async function getAdminProduct({ actor, productId }) {
    await assertActiveAdmin(actor);
    return loadAdminProduct({ query }, assertUuid(productId, 'Product'));
}

export async function updateAdminProduct({ actor, productId, input }) {
    await assertActiveAdmin(actor);
    const id = assertUuid(productId, 'Product');
    const body = input || {};

    const name = String(body.name ?? '').trim();
    if (!name || name.length > 200) {
        throw badRequest('Name is required (max 200 characters).');
    }
    const shortDescription = String(body.shortDescription ?? '').trim();
    if (shortDescription.length > 500) {
        throw badRequest('Short description must be at most 500 characters.');
    }
    const description = String(body.description ?? '').trim();
    if (description.length > 5000) {
        throw badRequest('Description must be at most 5000 characters.');
    }
    if (typeof body.isActive !== 'boolean' || typeof body.isFeatured !== 'boolean') {
        throw badRequest('isActive and isFeatured must be true or false.');
    }
    const imageUrl = parseImageUrl(body.imageUrl);

    return withTransaction(async client => {
        const updated = await client.query(
            `UPDATE products
             SET name = $2, short_description = $3, description = $4, is_active = $5, is_featured = $6, updated_at = NOW()
             WHERE id = $1 RETURNING id`,
            [id, name, shortDescription || null, description || null, body.isActive, body.isFeatured]
        );
        if (!updated.rows.length) {
            throw notFound('Product not found.');
        }

        // The primary product image: update it, create it, or remove it.
        const existing = await client.query(
            `SELECT id FROM product_images WHERE product_id = $1 AND variant_id IS NULL AND is_primary = TRUE LIMIT 1`,
            [id]
        );
        const altText = `${name} by The Crunchy Heart`;
        if (imageUrl === null) {
            await client.query(`DELETE FROM product_images WHERE product_id = $1 AND variant_id IS NULL AND is_primary = TRUE`, [id]);
        } else if (existing.rows.length) {
            await client.query(`UPDATE product_images SET image_url = $2, alt_text = $3 WHERE id = $1`, [existing.rows[0].id, imageUrl, altText]);
        } else {
            await client.query(
                `INSERT INTO product_images (product_id, image_url, alt_text, image_type, sort_order, is_primary)
                 VALUES ($1, $2, $3, 'product', 0, TRUE)`,
                [id, imageUrl, altText]
            );
        }

        await audit(client, actor, 'product.updated', 'product', id, {
            name,
            isActive: body.isActive,
            isFeatured: body.isFeatured,
            imageUrl,
        });
        return loadAdminProduct(client, id);
    });
}

export async function updateAdminVariant({ actor, variantId, input }) {
    await assertActiveAdmin(actor);
    const id = assertUuid(variantId, 'Pack size');
    const body = input || {};

    const sellingPrice = parseMoney(body.sellingPrice, 'Price');
    const mrp = body.mrp === undefined || body.mrp === '' || body.mrp === null ? 0 : parseMoney(body.mrp, 'MRP');
    if (mrp !== 0 && mrp < sellingPrice) {
        throw badRequest('MRP must be 0 (no strike-through) or at least the selling price.');
    }
    if (typeof body.isActive !== 'boolean') {
        throw badRequest('isActive must be true or false.');
    }
    const onHand = parseCount(body.quantityOnHand, 'Stock quantity');
    const reorderLevel = parseCount(body.reorderLevel ?? 0, 'Reorder level');
    const badge = String(body.badge ?? '').trim();
    if (badge.length > 100) {
        throw badRequest('Badge must be at most 100 characters.');
    }

    return withTransaction(async client => {
        const current = await client.query(
            `SELECT v.id, v.product_id, v.selling_price, v.mrp, v.is_active,
                    COALESCE(i.quantity_on_hand, 0) AS on_hand, COALESCE(i.quantity_reserved, 0) AS reserved
             FROM product_variants v LEFT JOIN inventory i ON i.variant_id = v.id
             WHERE v.id = $1 FOR UPDATE OF v`,
            [id]
        );
        if (!current.rows.length) {
            throw notFound('Pack size not found.');
        }
        const before = current.rows[0];
        if (onHand < Number(before.reserved)) {
            throw conflict(`Stock cannot be set below the ${before.reserved} unit(s) currently reserved for open orders.`);
        }

        await client.query(
            `UPDATE product_variants
             SET selling_price = $2, mrp = $3, is_active = $4, badge = $5, updated_at = NOW()
             WHERE id = $1`,
            [id, sellingPrice, mrp, body.isActive, badge || null]
        );

        const lockedInventory = await client.query(`SELECT quantity_on_hand FROM inventory WHERE variant_id = $1 FOR UPDATE`, [id]);
        if (lockedInventory.rows.length) {
            await client.query(
                `UPDATE inventory SET quantity_on_hand = $2, reorder_level = $3, updated_at = NOW() WHERE variant_id = $1`,
                [id, onHand, reorderLevel]
            );
        } else {
            await client.query(
                `INSERT INTO inventory (variant_id, quantity_on_hand, quantity_reserved, reorder_level) VALUES ($1, $2, 0, $3)`,
                [id, onHand, reorderLevel]
            );
        }

        const delta = onHand - Number(before.on_hand);
        if (delta !== 0) {
            await client.query(
                `INSERT INTO inventory_transactions (variant_id, transaction_type, quantity, reference_type, reference_id, notes)
                 VALUES ($1, 'admin_adjustment', $2, 'admin', $3, $4)`,
                [id, delta, String(actor.id), `Stock set to ${onHand} in the owner console`]
            );
        }

        await audit(client, actor, 'variant.updated', 'product_variant', id, {
            sellingPrice: { from: toNumber(before.selling_price), to: sellingPrice },
            mrp: { from: toNumber(before.mrp), to: mrp },
            isActive: { from: before.is_active, to: body.isActive },
            stock: { from: Number(before.on_hand), to: onHand },
        });

        return loadAdminProduct(client, before.product_id);
    });
}

/**
 * Sets one per-kg rate for a product and re-prices every weight-based pack size from it
 * (price = rate x weight, rounded to the nearest rupee). If a pack's MRP would then be below its
 * price, its MRP is cleared (no strike-through) so the database rule selling_price <= mrp holds.
 */
export async function setAdminProductRatePerKg({ actor, productId, ratePerKg }) {
    await assertActiveAdmin(actor);
    const id = assertUuid(productId, 'Product');
    const rate = parseMoney(ratePerKg, 'Rate per kg');

    return withTransaction(async client => {
        const variants = await client.query(
            `SELECT id, weight_grams, selling_price, mrp FROM product_variants
             WHERE product_id = $1 AND weight_grams IS NOT NULL AND weight_grams > 0 FOR UPDATE`,
            [id]
        );
        if (!variants.rows.length) {
            throw badRequest('This product has no weight-based pack sizes to price per kg.');
        }

        const changes = [];
        for (const row of variants.rows) {
            const price = Math.floor((rate * row.weight_grams) / 1000 + 0.5);
            const mrp = toNumber(row.mrp);
            const nextMrp = mrp !== 0 && mrp < price ? 0 : mrp;
            await client.query(`UPDATE product_variants SET selling_price = $2, mrp = $3, updated_at = NOW() WHERE id = $1`, [row.id, price, nextMrp]);
            changes.push({ variantId: row.id, from: toNumber(row.selling_price), to: price });
        }

        await audit(client, actor, 'product.rate_per_kg_set', 'product', id, { ratePerKg: rate, changes });
        return loadAdminProduct(client, id);
    });
}
