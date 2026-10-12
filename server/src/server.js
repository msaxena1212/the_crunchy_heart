
import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { neon } from '@neondatabase/serverless';

import checkoutRoutes from './routes/checkout.routes.js';
import orderRoutes from './routes/order.routes.js';
import paymentRoutes from './routes/payment.routes.js';
import { cashfreeWebhook } from './controllers/payment.controller.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/*
|--------------------------------------------------------------------------
| Environment
|--------------------------------------------------------------------------
*/

const envPath = path.resolve(__dirname, '../../.env.local');

dotenv.config({ path: envPath });

const DATABASE_URL = process.env.DATABASE_URL;
const PORT = Number(process.env.PORT || 5000);
const CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:4200';

if (!DATABASE_URL) {
  throw new Error(
    `DATABASE_URL is missing. Expected environment file at: ${envPath}`
  );
}

/*
|--------------------------------------------------------------------------
| Database
|--------------------------------------------------------------------------
*/

const sql = neon(DATABASE_URL);

/*
|--------------------------------------------------------------------------
| Express and CORS
|--------------------------------------------------------------------------
*/

const app = express();

app.use(
  cors({
    origin: [
      CLIENT_URL,
      'http://localhost:4200',
      'http://127.0.0.1:4200',
    ],
    credentials: true,
  })
);

/*
|--------------------------------------------------------------------------
| Cashfree Webhook
|--------------------------------------------------------------------------
|
| Must be registered before express.json() to preserve the raw body
| required for Cashfree webhook signature verification.
|
*/

app.post(
  '/api/payments/cashfree/webhook',
  express.raw({ type: 'application/json' }),
  (req, res, next) => {
    try {
      req.rawBody = req.body?.toString('utf8') || '';

      if (!req.rawBody) {
        return res.status(400).json({
          success: false,
          message: 'Empty Cashfree webhook body.',
        });
      }

      req.body = JSON.parse(req.rawBody);

      return cashfreeWebhook(req, res, next);
    } catch (error) {
      console.error('Cashfree webhook parsing error:', error);

      return res.status(400).json({
        success: false,
        message: 'Invalid Cashfree webhook JSON payload.',
      });
    }
  }
);

/*
|--------------------------------------------------------------------------
| JSON Body Parser
|--------------------------------------------------------------------------
*/

app.use(express.json({ limit: '2mb' }));

/*
|--------------------------------------------------------------------------
| Request Logging
|--------------------------------------------------------------------------
*/

app.use((req, res, next) => {
  console.log(
    `${new Date().toISOString()} ${req.method} ${req.path}`
  );

  next();
});

/*
|--------------------------------------------------------------------------
| Health Check
|--------------------------------------------------------------------------
*/

app.get('/api/health', async (req, res) => {
  try {
    await sql`SELECT 1`;

    return res.json({
      ok: true,
      service: 'the-crunchy-heart-api',
      database: 'neon_connected',
      environment: process.env.NODE_ENV || 'development',
    });
  } catch (error) {
    console.error('Health check failed:', error);

    return res.status(500).json({
      ok: false,
      service: 'the-crunchy-heart-api',
      database: 'neon_error',
      environment: process.env.NODE_ENV || 'development',
    });
  }
});

/*
|--------------------------------------------------------------------------
| Checkout, Orders and Payments
|--------------------------------------------------------------------------
*/

app.use('/api/checkout', checkoutRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/payments', paymentRoutes);

/*
|--------------------------------------------------------------------------
| Categories
|--------------------------------------------------------------------------
*/

app.get('/api/categories', async (req, res, next) => {
  try {
    const rows = await sql`
            SELECT
                id,
                name,
                slug,
                description,
                is_active,
                sort_order
            FROM categories
            WHERE is_active = true
            ORDER BY sort_order ASC, name ASC
        `;

    return res.json(rows);
  } catch (error) {
    next(error);
  }
});

/*
|--------------------------------------------------------------------------
| Products
|--------------------------------------------------------------------------
|
| GET /api/products
| Optional:
|   ?category=raw-makhana
|   ?featured=true
|
|--------------------------------------------------------------------------
*/

app.get('/api/products', async (req, res, next) => {
  try {
    const categoryFilter =
      typeof req.query.category === 'string' &&
        req.query.category.trim()
        ? req.query.category.trim()
        : null;

    let featuredFilter = null;

    if (req.query.featured !== undefined) {
      if (
        req.query.featured !== 'true' &&
        req.query.featured !== 'false'
      ) {
        return res.status(400).json({
          success: false,
          message: 'featured must be true or false.',
        });
      }

      featuredFilter = req.query.featured === 'true';
    }

    const rows = await sql`
            SELECT
                p.id,
                p.name,
                p.slug,
                p.description,
                p.short_description,
                p.brand,
                p.is_featured,
                p.sort_order,

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
                COALESCE(i.quantity_reserved, 0) AS quantity_reserved,

                GREATEST(
                    COALESCE(i.quantity_on_hand, 0)
                    - COALESCE(i.quantity_reserved, 0),
                    0
                ) AS available_quantity

            FROM products p

            INNER JOIN categories c
                ON c.id = p.category_id

            INNER JOIN product_variants v
                ON v.product_id = p.id

            LEFT JOIN inventory i
                ON i.variant_id = v.id

            WHERE
                p.is_active = true
                AND c.is_active = true
                AND v.is_active = true

                AND (
                    ${categoryFilter}::text IS NULL
                    OR c.slug = ${categoryFilter}::text
                )

                AND (
                    ${featuredFilter}::boolean IS NULL
                    OR p.is_featured = ${featuredFilter}::boolean
                )

            ORDER BY
                p.sort_order ASC,
                v.sort_order ASC,
                p.name ASC,
                v.weight_grams ASC
        `;

    const response = rows.map((row) => ({
      id: row.id,
      name: row.name,
      slug: row.slug,
      description: row.description,
      shortDescription: row.short_description,
      brand: row.brand,
      featured: row.is_featured,

      category: {
        id: row.category_id,
        name: row.category_name,
        slug: row.category_slug,
      },

      variant: {
        id: row.variant_id,
        sku: row.sku,
        name: row.variant_name,
        weightGrams: Number(row.weight_grams || 0),
        flavor: row.flavor,
        mrp: Number(row.mrp || 0),
        sellingPrice: Number(row.selling_price || 0),
        taxRate: Number(row.tax_rate ?? 18),
        badge: row.badge,
        tone: row.tone,

        inventory: {
          quantityOnHand: Number(row.quantity_on_hand || 0),
          quantityReserved: Number(row.quantity_reserved || 0),
          availableQuantity: Number(row.available_quantity || 0),
        },
      },
    }));

    return res.json(response);
  } catch (error) {
    next(error);
  }
});

/*
|--------------------------------------------------------------------------
| Product Details
|--------------------------------------------------------------------------
|
| GET /api/products/:slug
|
|--------------------------------------------------------------------------
*/

app.get('/api/products/:slug', async (req, res, next) => {
  try {
    const { slug } = req.params;

    const rows = await sql`
            SELECT
                p.id,
                p.name,
                p.slug,
                p.description,
                p.short_description,
                p.brand,
                p.is_featured,
                p.sort_order,

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
                COALESCE(i.quantity_reserved, 0) AS quantity_reserved,

                GREATEST(
                    COALESCE(i.quantity_on_hand, 0)
                    - COALESCE(i.quantity_reserved, 0),
                    0
                ) AS available_quantity

            FROM products p

            INNER JOIN categories c
                ON c.id = p.category_id

            INNER JOIN product_variants v
                ON v.product_id = p.id

            LEFT JOIN inventory i
                ON i.variant_id = v.id

            WHERE
                p.slug = ${slug}
                AND p.is_active = true
                AND c.is_active = true
                AND v.is_active = true

            ORDER BY
                v.sort_order ASC,
                v.weight_grams ASC
        `;

    if (!rows.length) {
      return res.status(404).json({
        success: false,
        message: 'Product not found.',
      });
    }

    const first = rows[0];

    return res.json({
      id: first.id,
      name: first.name,
      slug: first.slug,
      description: first.description,
      shortDescription: first.short_description,
      brand: first.brand,
      featured: first.is_featured,

      category: {
        id: first.category_id,
        name: first.category_name,
        slug: first.category_slug,
      },

      variants: rows.map((row) => ({
        id: row.variant_id,
        sku: row.sku,
        name: row.variant_name,
        weightGrams: Number(row.weight_grams || 0),
        flavor: row.flavor,
        mrp: Number(row.mrp || 0),
        sellingPrice: Number(row.selling_price || 0),
        taxRate: Number(row.tax_rate ?? 18),
        badge: row.badge,
        tone: row.tone,

        inventory: {
          quantityOnHand: Number(row.quantity_on_hand || 0),
          quantityReserved: Number(row.quantity_reserved || 0),
          availableQuantity: Number(row.available_quantity || 0),
        },
      })),
    });
  } catch (error) {
    next(error);
  }
});

/*
|--------------------------------------------------------------------------
| 404 Handler
|--------------------------------------------------------------------------
*/

app.use((req, res) => {
  return res.status(404).json({
    success: false,
    message: 'API endpoint not found.',
  });
});

/*
|--------------------------------------------------------------------------
| Global Error Handler
|--------------------------------------------------------------------------
*/

app.use((error, req, res, next) => {
  console.error('API Error:', error);

  const statusCode = error.statusCode || 500;

  return res.status(statusCode).json({
    success: false,
    message: error.message || 'Internal server error.',

    ...(process.env.NODE_ENV !== 'production'
      ? { error: error.stack }
      : {}),
  });
});

/*
|--------------------------------------------------------------------------
| Start Server
|--------------------------------------------------------------------------
*/

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`Client URL: ${CLIENT_URL}`);
  console.log('Database: Neon PostgreSQL');
});
