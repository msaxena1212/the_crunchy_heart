import type { Config } from '@netlify/functions';
import { getDatabase } from '@netlify/database';


/* =========================================================
   THE CRUNCHY HEART — STOREFRONT API
   Serves the catalogue and accepts orders from the
   Angular storefront. Backed by Netlify Database.
   ========================================================= */

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MAX_QUANTITY_PER_ITEM = 50;


type Row = Record<string, any>;


const json = (
  body: unknown,
  status = 200
) =>
  Response.json(body, { status });


const query = async (
  text: string,
  params: unknown[] = []
): Promise<Row[]> => {

  const { pool } = getDatabase();
  const result = await pool.query(text, params);

  return result.rows;

};


/* =========================================================
   PRODUCT FORMATTING
   ========================================================= */

const PRODUCT_COLUMNS = `
  p.id,
  p.name,
  p.slug,
  p.description,
  p.short_description,
  p.brand,
  p.is_featured,
  c.id AS category_id,
  c.name AS category_name,
  c.slug AS category_slug,
  v.id AS variant_id,
  v.sku,
  v.variant_name,
  v.weight_grams,
  v.flavor,
  v.mrp,
  v.selling_price,
  v.tax_rate,
  v.badge,
  v.tone,
  COALESCE(i.quantity_on_hand, 0) AS quantity_on_hand,
  COALESCE(i.quantity_reserved, 0) AS quantity_reserved
`;

const PRODUCT_JOINS = `
  FROM products p
  INNER JOIN categories c ON c.id = p.category_id
  INNER JOIN product_variants v ON v.product_id = p.id
  LEFT JOIN inventory i ON i.variant_id = v.id
  WHERE p.is_active = true
    AND c.is_active = true
    AND v.is_active = true
`;


const toVariant = (row: Row) => {

  const quantityOnHand = Number(row.quantity_on_hand || 0);
  const reservedQuantity = Number(row.quantity_reserved || 0);

  return {
    id: row.variant_id,
    sku: row.sku,
    name: row.variant_name,
    weightGrams: row.weight_grams,
    flavor: row.flavor,
    mrp: Number(row.mrp || 0),
    sellingPrice: Number(row.selling_price || 0),
    taxRate: Number(row.tax_rate || 0),
    badge: row.badge,
    tone: row.tone,
    inventory: {
      quantityOnHand,
      reservedQuantity,
      availableQuantity: Math.max(quantityOnHand - reservedQuantity, 0)
    }
  };

};


const toProductBase = (row: Row) => ({
  id: row.id,
  name: row.name,
  slug: row.slug,
  description: row.description,
  shortDescription: row.short_description,
  brand: row.brand,
  featured: Boolean(row.is_featured),
  category: {
    id: row.category_id,
    name: row.category_name,
    slug: row.category_slug
  }
});


/* =========================================================
   HANDLERS
   ========================================================= */

const getHealth = async () => {

  try {

    await query('SELECT 1');

    return json({ ok: true, service: 'the-crunchy-heart-api', database: 'connected' });

  } catch (error) {

    console.error('Health check failed:', error);

    return json({ ok: false, service: 'the-crunchy-heart-api', database: 'disconnected' }, 500);

  }

};


const getCategories = async () => {

  const categories = await query(`
    SELECT id, name, slug, description, image_url, sort_order
    FROM categories
    WHERE is_active = true
    ORDER BY sort_order ASC, name ASC
  `);

  return json(categories);

};


const getProducts = async (url: URL) => {

  const category = url.searchParams.get('category');
  const featuredParam = url.searchParams.get('featured');
  const featured = featuredParam === null ? null : featuredParam === 'true';

  const rows = await query(
    `
    SELECT ${PRODUCT_COLUMNS}
    ${PRODUCT_JOINS}
      AND ($1::text IS NULL OR c.slug = $1)
      AND ($2::boolean IS NULL OR p.is_featured = $2)
    ORDER BY c.sort_order ASC, p.sort_order ASC, v.sort_order ASC
    `,
    [category, featured]
  );

  return json(
    rows.map(row => ({ ...toProductBase(row), variant: toVariant(row) }))
  );

};


const getProduct = async (slug: string) => {

  const rows = await query(
    `
    SELECT ${PRODUCT_COLUMNS}
    ${PRODUCT_JOINS}
      AND p.slug = $1
    ORDER BY v.sort_order ASC
    `,
    [slug]
  );

  if (!rows.length) {
    return json({ message: 'Product not found.' }, 404);
  }

  return json({ ...toProductBase(rows[0]), variants: rows.map(toVariant) });

};


class OrderError extends Error {

  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }

}


const text = (value: unknown, maxLength = 255) =>
  typeof value === 'string' ? value.trim().slice(0, maxLength) : '';


const createOrder = async (req: Request) => {

  let body: Row;

  try {
    body = await req.json();
  } catch {
    return json({ message: 'Invalid request body.' }, 400);
  }

  const customerName = text(body?.customerName, 200);
  const phone = text(body?.phone, 30);
  const email = text(body?.email) || null;
  const notes = text(body?.notes, 1000) || null;
  const address = body?.shippingAddress ?? {};

  const shippingAddress = {
    line1: text(address.line1, 500),
    line2: text(address.line2, 500),
    landmark: text(address.landmark),
    city: text(address.city, 100),
    state: text(address.state, 100),
    postalCode: text(address.postalCode, 20),
    country: text(address.country, 100) || 'India'
  };

  const items = Array.isArray(body?.items) ? body.items : [];

  if (
    !customerName ||
    !phone ||
    !shippingAddress.line1 ||
    !shippingAddress.city ||
    !shippingAddress.state ||
    !shippingAddress.postalCode ||
    items.length === 0
  ) {
    return json(
      { message: 'Customer details, shipping address and cart items are required.' },
      400
    );
  }

  const quantityMap = new Map<string, number>();

  for (const item of items) {

    const variantId = String(item?.variantId || '');
    const quantity = Number(item?.quantity || 0);

    if (
      !UUID_PATTERN.test(variantId) ||
      !Number.isInteger(quantity) ||
      quantity <= 0
    ) {
      return json({ message: 'Invalid cart item.' }, 400);
    }

    const total = (quantityMap.get(variantId) || 0) + quantity;

    if (total > MAX_QUANTITY_PER_ITEM) {
      return json(
        { message: `A maximum of ${MAX_QUANTITY_PER_ITEM} packs per product can be ordered.` },
        400
      );
    }

    quantityMap.set(variantId, total);

  }

  const variantIds = [...quantityMap.keys()];

  const { pool } = getDatabase();
  const client = await pool.connect();

  try {

    await client.query('BEGIN');

    /*
     * Lock the inventory rows so two simultaneous orders
     * cannot both claim the last packs in stock.
     */
    const { rows: variants } = await client.query(
      `
      SELECT
        v.id,
        v.sku,
        v.variant_name,
        v.selling_price,
        v.tax_rate,
        p.name AS product_name,
        i.quantity_on_hand,
        i.quantity_reserved
      FROM product_variants v
      INNER JOIN products p ON p.id = v.product_id
      INNER JOIN inventory i ON i.variant_id = v.id
      WHERE v.id = ANY($1::uuid[])
        AND v.is_active = true
        AND p.is_active = true
      FOR UPDATE OF i
      `,
      [variantIds]
    );

    if (variants.length !== variantIds.length) {
      throw new OrderError('One or more products in your cart are no longer available.', 400);
    }

    let subtotal = 0;
    let taxAmount = 0;

    const orderItems = variants.map((variant: Row) => {

      const quantity = quantityMap.get(variant.id)!;

      const available = Math.max(
        Number(variant.quantity_on_hand || 0) - Number(variant.quantity_reserved || 0),
        0
      );

      if (quantity > available) {
        throw new OrderError(
          `${variant.product_name} (${variant.variant_name}) is not available in the requested quantity.`,
          409
        );
      }

      const unitPrice = Number(variant.selling_price || 0);
      const taxRate = Number(variant.tax_rate || 0);
      const lineSubtotal = unitPrice * quantity;
      const lineTax = lineSubtotal * (taxRate / 100);

      subtotal += lineSubtotal;
      taxAmount += lineTax;

      return { variant, quantity, unitPrice, taxRate, lineSubtotal, lineTax };

    });

    /*
     * Shipping is currently free on every order.
     * Final shipping policy can be configured here.
     */
    const shippingAmount = 0;
    const discountAmount = 0;
    const totalAmount = subtotal + taxAmount + shippingAmount - discountAmount;

    const orderNumber =
      `TCH-${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 5).toUpperCase()}`;

    const { rows: [order] } = await client.query(
      `
      INSERT INTO orders (
        order_number, customer_name, phone, email,
        shipping_address, billing_address,
        subtotal, discount_amount, shipping_amount, tax_amount, total_amount,
        currency, status, payment_status, notes
      )
      VALUES ($1, $2, $3, $4, $5::jsonb, NULL, $6, $7, $8, $9, $10, 'INR', 'pending', 'pending', $11)
      RETURNING
        id, order_number, subtotal, discount_amount, shipping_amount,
        tax_amount, total_amount, currency, status, payment_status, created_at
      `,
      [
        orderNumber, customerName, phone, email,
        JSON.stringify(shippingAddress),
        subtotal, discountAmount, shippingAmount, taxAmount, totalAmount,
        notes
      ]
    );

    for (const item of orderItems) {

      await client.query(
        `
        INSERT INTO order_items (
          order_id, product_variant_id, sku, product_name, variant_name,
          quantity, unit_price, tax_rate, tax_amount, line_total
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        `,
        [
          order.id, item.variant.id, item.variant.sku,
          item.variant.product_name, item.variant.variant_name,
          item.quantity, item.unitPrice, item.taxRate,
          item.lineTax, item.lineSubtotal + item.lineTax
        ]
      );

      await client.query(
        `
        UPDATE inventory
        SET quantity_reserved = quantity_reserved + $2
        WHERE variant_id = $1
        `,
        [item.variant.id, item.quantity]
      );

      await client.query(
        `
        INSERT INTO inventory_transactions (
          variant_id, transaction_type, quantity, reference_type, reference_id
        )
        VALUES ($1, 'reserve', $2, 'order', $3)
        `,
        [item.variant.id, item.quantity, order.order_number]
      );

    }

    await client.query(
      `
      INSERT INTO order_status_history (order_id, status, notes)
      VALUES ($1, 'pending', 'Order created from storefront.')
      `,
      [order.id]
    );

    await client.query('COMMIT');

    return json(
      {
        success: true,
        order: {
          id: order.id,
          orderNumber: order.order_number,
          subtotal: Number(order.subtotal),
          discountAmount: Number(order.discount_amount),
          shippingAmount: Number(order.shipping_amount),
          taxAmount: Number(order.tax_amount),
          totalAmount: Number(order.total_amount),
          currency: order.currency,
          status: order.status,
          paymentStatus: order.payment_status,
          createdAt: order.created_at
        }
      },
      201
    );

  } catch (error) {

    await client.query('ROLLBACK').catch(() => undefined);

    if (error instanceof OrderError) {
      return json({ message: error.message }, error.status);
    }

    throw error;

  } finally {

    client.release();

  }

};


/* =========================================================
   ROUTER
   ========================================================= */

export default async (req: Request) => {

  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/api/, '').replace(/\/+$/, '') || '/';

  try {

    if (req.method === 'GET') {

      if (path === '/health') return await getHealth();
      if (path === '/categories') return await getCategories();
      if (path === '/products') return await getProducts(url);

      const productMatch = path.match(/^\/products\/([^/]+)$/);

      if (productMatch) {
        return await getProduct(decodeURIComponent(productMatch[1]));
      }

    }

    if (req.method === 'POST' && path === '/orders') {
      return await createOrder(req);
    }

    return json({ message: 'API endpoint not found.' }, 404);

  } catch (error) {

    console.error(`Unhandled API error on ${req.method} ${url.pathname}:`, error);

    return json({ message: 'Internal server error.' }, 500);

  }

};


export const config: Config = {
  path: '/api/*'
};
