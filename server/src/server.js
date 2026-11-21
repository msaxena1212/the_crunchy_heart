
import express from 'express';
import cors from 'cors';
import checkoutRoutes from './routes/checkout.routes.js';
import orderRoutes from './routes/order.routes.js';
import paymentRoutes from './routes/payment.routes.js';
import adminRoutes from './routes/admin.routes.js';
import customerAuthRoutes from './routes/customer-auth.routes.js';
import { cashfreeWebhook } from './controllers/payment.controller.js';
import { securityHeadersMiddleware, createIpRateLimiter } from './middleware/security.js';
import { query } from './db/pool.js';
import { getPublicStoreInfo } from './services/store-settings.service.js';
import { env } from './config/env.js';
import { startConfiguredWorkers, stopAllWorkers } from './services/worker-bootstrap.js';
import { createGracefulShutdown, parseDrainTimeoutMs } from './services/graceful-shutdown.js';
import { pool } from './db/pool.js';

/*
|--------------------------------------------------------------------------
| Environment Configuration
|--------------------------------------------------------------------------
| Centralized configuration and validation defined in config/env.js
*/

const PORT = env.port;
const HOST = env.host;
const CLIENT_URL = env.clientUrl;

/*
|--------------------------------------------------------------------------
| Express and CORS
|--------------------------------------------------------------------------
*/

const app = express();

/*
|--------------------------------------------------------------------------
| Reverse Proxy Trust Configuration (OPS-01)
|--------------------------------------------------------------------------
| Safe environment-driven proxy trust. Defaults to false (direct access,
| ignores X-Forwarded-For). Strictly rejects blind true.
*/
app.set('trust proxy', env.trustProxy);
app.use(securityHeadersMiddleware);

const allowedOrigins = Array.from(new Set([
  CLIENT_URL,
  'https://thecrunchyheart.com',
  'https://www.thecrunchyheart.com',
  'https://staging.thecrunchyheart.com',
  'http://localhost:4200',
  'http://127.0.0.1:4200',
].filter(Boolean)));

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (like mobile apps, curl, server-to-server)
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(null, false);
    },
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

app.get('/api/store-info', async (req, res, next) => {
  try {
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.json({ success: true, ...(await getPublicStoreInfo()) });
  } catch (error) {
    next(error);
  }
});

app.get('/api/health', async (req, res) => {
  try {
    await query('SELECT 1');

    return res.json({
      ok: true,
      service: 'the-crunchy-heart-api',
      database: 'connected',
      environment: process.env.NODE_ENV || 'development',
    });
  } catch (error) {
    console.error('Health check failed:', error);

    return res.status(500).json({
      ok: false,
      service: 'the-crunchy-heart-api',
      database: 'error',
      environment: process.env.NODE_ENV || 'development',
    });
  }
});

/*
|--------------------------------------------------------------------------
| Checkout, Orders and Payments (with IP Rate Limiting)
|--------------------------------------------------------------------------
*/

const checkoutRateLimiter = createIpRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: 40,
  code: 'CHECKOUT_RATE_LIMIT',
  message: 'Too many checkout requests. Please wait a moment and try again.',
});

const ordersRateLimiter = createIpRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: 30,
  code: 'ORDER_RATE_LIMIT',
  message: 'Too many order requests. Please wait a moment and try again.',
});

const customerAuthRateLimiter = createIpRateLimiter({
  windowMs: 15 * 60 * 1000,
  maxRequests: 30,
  code: 'AUTH_RATE_LIMIT',
  message: 'Too many authentication attempts from this IP. Please try again in 15 minutes.',
});

app.use('/api/checkout', checkoutRateLimiter, checkoutRoutes);
app.use('/api/orders', ordersRateLimiter, orderRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/admin', adminRoutes);
// Only OTP send/verify is brute-forceable; session checks (/me), orders and cancel are not limited here.
app.use('/api/auth/customer/otp', customerAuthRateLimiter);
app.use('/api/auth/customer', customerAuthRoutes);

/*
|--------------------------------------------------------------------------
| Dynamic Sitemap XML (SEO / Google Merchant & Search Console)
|--------------------------------------------------------------------------
*/

async function buildDynamicSitemapXml(baseUrl) {
  const cleanBase = (baseUrl || 'https://thecrunchyheart.com').replace(/\/+$/, '');
  const nowIso = new Date().toISOString().split('T')[0];

  const [catRes, prodRes] = await Promise.all([
    query(`SELECT slug, updated_at FROM categories WHERE is_active = true ORDER BY sort_order ASC`),
    query(`SELECT slug, updated_at FROM products WHERE is_active = true ORDER BY sort_order ASC, name ASC`),
  ]);

  const staticRoutes = [
    { loc: `${cleanBase}/`, priority: '1.0', changefreq: 'daily' },
    { loc: `${cleanBase}/shop`, priority: '0.9', changefreq: 'daily' },
    { loc: `${cleanBase}/gifting`, priority: '0.8', changefreq: 'weekly' },
    { loc: `${cleanBase}/bulk`, priority: '0.8', changefreq: 'weekly' },
  ];

  const urls = [];
  for (const s of staticRoutes) {
    urls.push(
      `  <url>\n    <loc>${s.loc}</loc>\n    <lastmod>${nowIso}</lastmod>\n    <changefreq>${s.changefreq}</changefreq>\n    <priority>${s.priority}</priority>\n  </url>`
    );
  }

  for (const c of catRes.rows) {
    const lastmod = c.updated_at ? new Date(c.updated_at).toISOString().split('T')[0] : nowIso;
    urls.push(
      `  <url>\n    <loc>${cleanBase}/category/${encodeURIComponent(c.slug)}</loc>\n    <lastmod>${lastmod}</lastmod>\n    <changefreq>weekly</changefreq>\n    <priority>0.8</priority>\n  </url>`
    );
  }

  for (const p of prodRes.rows) {
    const lastmod = p.updated_at ? new Date(p.updated_at).toISOString().split('T')[0] : nowIso;
    urls.push(
      `  <url>\n    <loc>${cleanBase}/product/${encodeURIComponent(p.slug)}</loc>\n    <lastmod>${lastmod}</lastmod>\n    <changefreq>weekly</changefreq>\n    <priority>0.7</priority>\n  </url>`
    );
  }

  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>`;
}

app.get(['/api/sitemap.xml', '/sitemap.xml'], async (req, res, next) => {
  try {
    const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
    const host = req.headers['x-forwarded-host'] || req.headers.host || 'thecrunchyheart.com';
    const baseUrl = `${proto}://${host}`;
    const xml = await buildDynamicSitemapXml(baseUrl);
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    return res.send(xml);
  } catch (error) {
    next(error);
  }
});

/*
|--------------------------------------------------------------------------
| Categories
|--------------------------------------------------------------------------
*/

app.get('/api/categories', async (req, res, next) => {
  try {
    const { rows } = await query(`
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
    `);

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

    const { rows } = await query(
      `
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
          sc.name AS subcategory_name,
          sc.slug AS subcategory_slug,
          img.image_url AS image_url,

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

      LEFT JOIN subcategories sc
          ON sc.id = p.subcategory_id

      LEFT JOIN LATERAL (
          SELECT pi.image_url
          FROM product_images pi
          WHERE pi.product_id = p.id
            AND pi.variant_id IS NULL
          ORDER BY pi.is_primary DESC, pi.sort_order ASC
          LIMIT 1
      ) img ON TRUE

      INNER JOIN product_variants v
          ON v.product_id = p.id

      LEFT JOIN inventory i
          ON i.variant_id = v.id

      WHERE
          p.is_active = true
          AND c.is_active = true
          AND v.is_active = true

          AND (
              $1::text IS NULL
              OR c.slug = $1::text
          )

          AND (
              $2::boolean IS NULL
              OR p.is_featured = $2::boolean
          )

      ORDER BY
          p.sort_order ASC,
          v.sort_order ASC,
          p.name ASC,
          v.weight_grams ASC
      `,
      [categoryFilter, featuredFilter]
    );

    const response = rows.map((row) => ({
      id: row.id,
      name: row.name,
      slug: row.slug,
      description: row.description,
      shortDescription: row.short_description,
      brand: row.brand,
      featured: row.is_featured,
      imageUrl: row.image_url ?? null,

      category: {
        id: row.category_id,
        name: row.category_name,
        slug: row.category_slug,
      },

      subcategory: row.subcategory_slug
        ? { name: row.subcategory_name, slug: row.subcategory_slug }
        : null,

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

    const { rows } = await query(
      `
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
          sc.name AS subcategory_name,
          sc.slug AS subcategory_slug,
          img.image_url AS image_url,

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

      LEFT JOIN subcategories sc
          ON sc.id = p.subcategory_id

      LEFT JOIN LATERAL (
          SELECT pi.image_url
          FROM product_images pi
          WHERE pi.product_id = p.id
            AND pi.variant_id IS NULL
          ORDER BY pi.is_primary DESC, pi.sort_order ASC
          LIMIT 1
      ) img ON TRUE

      INNER JOIN product_variants v
          ON v.product_id = p.id

      LEFT JOIN inventory i
          ON i.variant_id = v.id

      WHERE
          p.slug = $1
          AND p.is_active = true
          AND c.is_active = true
          AND v.is_active = true

      ORDER BY
          v.sort_order ASC,
          v.weight_grams ASC
      `,
      [slug]
    );

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
      imageUrl: first.image_url ?? null,

      category: {
        id: first.category_id,
        name: first.category_name,
        slug: first.category_slug,
      },

      subcategory: first.subcategory_slug
        ? { name: first.subcategory_name, slug: first.subcategory_slug }
        : null,

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

const httpServer = app.listen(PORT, HOST, () => {
  console.log(`Server running on http://${HOST}:${PORT}`);
  console.log(`Environment: ${env.nodeEnv}`);
  console.log(`Client URL: ${CLIENT_URL}`);
  console.log(`Trust Proxy: ${JSON.stringify(env.trustProxy)}`);
  console.log('Database: PostgreSQL');

  // Background workers start only when their flag is exactly 'true'.
  const workers = startConfiguredWorkers();
  console.log(`Background workers enabled: ${workers.length ? workers.join(', ') : 'none'}`);
});

// Graceful shutdown: drain HTTP, stop workers, close the pool, then exit.
const shutdown = createGracefulShutdown({
  server: httpServer,
  stopWorkers: stopAllWorkers,
  closePool: () => pool.end(),
  drainTimeoutMs: parseDrainTimeoutMs(process.env.SHUTDOWN_DRAIN_TIMEOUT_MS),
});

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
