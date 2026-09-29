import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { neon } from '@neondatabase/serverless';


/* =========================================================
   ENVIRONMENT CONFIGURATION
   ========================================================= */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const envPath = path.resolve(
  __dirname,
  '../../.env.local'
);

dotenv.config({
  path: envPath
});


/* =========================================================
   DATABASE
   ========================================================= */

const DATABASE_URL =
  process.env.DATABASE_URL;

if (!DATABASE_URL) {

  console.error(
    'DATABASE_URL is not configured.'
  );

  console.error(
    `Expected environment file at: ${envPath}`
  );

  process.exit(1);

}

const sql = neon(DATABASE_URL);


/* =========================================================
   EXPRESS APP
   ========================================================= */

const app = express();

const PORT =
  Number(
    process.env.PORT || 5000
  );

const CLIENT_URL =
  process.env.CLIENT_URL ||
  'http://localhost:4200';


/* =========================================================
   MIDDLEWARE
   ========================================================= */

app.use(
  cors({
    origin: CLIENT_URL,
    credentials: true
  })
);

app.use(
  express.json({
    limit: '2mb'
  })
);


/* =========================================================
   REQUEST LOGGING
   ========================================================= */

app.use(
  (req, res, next) => {

    console.log(
      `${new Date().toISOString()} ${req.method} ${req.path}`
    );

    next();

  }
);


/* =========================================================
   HEALTH CHECK
   ========================================================= */

app.get(
  '/api/health',
  async (req, res) => {

    try {

      await sql`
        SELECT 1
      `;

      res.json({

        ok: true,

        service:
          'the-crunchy-heart-api',

        database:
          'neon_connected'

      });

    } catch (error) {

      console.error(
        'Health check failed:',
        error
      );

      res.status(500).json({

        ok: false,

        service:
          'the-crunchy-heart-api',

        database:
          'neon_disconnected'

      });

    }

  }
);


/* =========================================================
   CATEGORIES
   ========================================================= */

app.get(
  '/api/categories',
  async (req, res) => {

    try {

      const categories =
        await sql`

          SELECT
            id,
            name,
            slug,
            description,
            image_url,
            sort_order

          FROM categories

          WHERE is_active = true

          ORDER BY
            sort_order ASC,
            name ASC

        `;

      res.json(categories);

    } catch (error) {

      console.error(
        'Unable to load categories:',
        error
      );

      res.status(500).json({

        message:
          'Unable to load categories.'

      });

    }

  }
);


/* =========================================================
   PRODUCTS
   ========================================================= */

app.get(
  '/api/products',
  async (req, res) => {

    try {

      const category =
        typeof req.query.category === 'string'
          ? req.query.category
          : null;


      const featured =
        typeof req.query.featured === 'string'
          ? req.query.featured === 'true'
          : null;


      let rows;


      /* -----------------------------------------------------
         ALL PRODUCTS
         ----------------------------------------------------- */

      if (
        category === null &&
        featured === null
      ) {

        rows =
          await sql`

            SELECT

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

              v.is_active AS variant_active,

              COALESCE(
                i.quantity_on_hand,
                0
              ) AS quantity_on_hand,

              COALESCE(
                i.quantity_reserved,
                0
              ) AS quantity_reserved

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

            ORDER BY

              c.sort_order ASC,

              p.sort_order ASC,

              v.sort_order ASC

          `;

      }


      /* -----------------------------------------------------
         CATEGORY FILTER
         ----------------------------------------------------- */

      else if (
        category !== null &&
        featured === null
      ) {

        rows =
          await sql`

            SELECT

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

              v.is_active AS variant_active,

              COALESCE(
                i.quantity_on_hand,
                0
              ) AS quantity_on_hand,

              COALESCE(
                i.quantity_reserved,
                0
              ) AS quantity_reserved

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

              AND c.slug = ${category}

            ORDER BY

              p.sort_order ASC,

              v.sort_order ASC

          `;

      }


      /* -----------------------------------------------------
         FEATURED FILTER
         ----------------------------------------------------- */

      else if (
        category === null &&
        featured !== null
      ) {

        rows =
          await sql`

            SELECT

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

              v.is_active AS variant_active,

              COALESCE(
                i.quantity_on_hand,
                0
              ) AS quantity_on_hand,

              COALESCE(
                i.quantity_reserved,
                0
              ) AS quantity_reserved

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

              AND p.is_featured = ${featured}

            ORDER BY

              c.sort_order ASC,

              p.sort_order ASC,

              v.sort_order ASC

          `;

      }


      /* -----------------------------------------------------
         CATEGORY + FEATURED
         ----------------------------------------------------- */

      else {

        rows =
          await sql`

            SELECT

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

              v.is_active AS variant_active,

              COALESCE(
                i.quantity_on_hand,
                0
              ) AS quantity_on_hand,

              COALESCE(
                i.quantity_reserved,
                0
              ) AS quantity_reserved

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

              AND c.slug = ${category}

              AND p.is_featured = ${featured}

            ORDER BY

              p.sort_order ASC,

              v.sort_order ASC

          `;

      }


      /* -----------------------------------------------------
         FORMAT RESPONSE
         ----------------------------------------------------- */

      const products =
        rows.map(row => {

          const quantityOnHand =
            Number(
              row.quantity_on_hand || 0
            );


          const reservedQuantity =
            Number(
              row.quantity_reserved || 0
            );


          const availableQuantity =
            Math.max(
              quantityOnHand -
                reservedQuantity,
              0
            );


          return {

            id:
              row.id,

            name:
              row.name,

            slug:
              row.slug,

            description:
              row.description,

            shortDescription:
              row.short_description,

            brand:
              row.brand,

            featured:
              Boolean(
                row.is_featured
              ),

            category: {

              id:
                row.category_id,

              name:
                row.category_name,

              slug:
                row.category_slug

            },

            variant: {

              id:
                row.variant_id,

              sku:
                row.sku,

              name:
                row.variant_name,

              weightGrams:
                row.weight_grams,

              flavor:
                row.flavor,

              mrp:
                Number(
                  row.mrp || 0
                ),

              sellingPrice:
                Number(
                  row.selling_price || 0
                ),

              taxRate:
                Number(
                  row.tax_rate || 0
                ),

              badge:
                row.badge,

              tone:
                row.tone,

              inventory: {

                quantityOnHand,

                reservedQuantity,

                availableQuantity

              }

            }

          };

        });


      res.json(products);

    } catch (error) {

      console.error(
        'Unable to load products:',
        error
      );

      res.status(500).json({

        message:
          'Unable to load products.'

      });

    }

  }
);


/* =========================================================
   PRODUCT DETAIL
   ========================================================= */

app.get(
  '/api/products/:slug',
  async (req, res) => {

    try {

      const slug =
        req.params.slug;


      const rows =
        await sql`

          SELECT

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

            COALESCE(
              i.quantity_on_hand,
              0
            ) AS quantity_on_hand,

            COALESCE(
              i.quantity_reserved,
              0
            ) AS quantity_reserved

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
            v.sort_order ASC

        `;


      if (!rows.length) {

        return res.status(404).json({

          message:
            'Product not found.'

        });

      }


      const first =
        rows[0];


      const variants =
        rows.map(row => {

          const quantityOnHand =
            Number(
              row.quantity_on_hand || 0
            );


          const reservedQuantity =
            Number(
              row.quantity_reserved || 0
            );


          return {

            id:
              row.variant_id,

            sku:
              row.sku,

            name:
              row.variant_name,

            weightGrams:
              row.weight_grams,

            flavor:
              row.flavor,

            mrp:
              Number(
                row.mrp || 0
              ),

            sellingPrice:
              Number(
                row.selling_price || 0
              ),

            taxRate:
              Number(
                row.tax_rate || 0
              ),

            badge:
              row.badge,

            tone:
              row.tone,

            inventory: {

              quantityOnHand,

              reservedQuantity,

              availableQuantity:
                Math.max(
                  quantityOnHand -
                    reservedQuantity,
                  0
                )

            }

          };

        });


      res.json({

        id:
          first.id,

        name:
          first.name,

        slug:
          first.slug,

        description:
          first.description,

        shortDescription:
          first.short_description,

        brand:
          first.brand,

        featured:
          Boolean(
            first.is_featured
          ),

        category: {

          id:
            first.category_id,

          name:
            first.category_name,

          slug:
            first.category_slug

        },

        variants

      });

    } catch (error) {

      console.error(
        'Unable to load product:',
        error
      );

      res.status(500).json({

        message:
          'Unable to load product.'

      });

    }

  }
);


/* =========================================================
   CREATE ORDER
   ========================================================= */

app.post(
  '/api/orders',
  async (req, res) => {

    try {

      const {

        customerName,

        phone,

        email,

        shippingAddress,

        billingAddress,

        items,

        notes

      } = req.body;


      if (
        !customerName ||
        !phone ||
        !shippingAddress ||
        !Array.isArray(items) ||
        items.length === 0
      ) {

        return res.status(400).json({

          message:
            'Customer details, shipping address and cart items are required.'

        });

      }


      const quantityMap =
        new Map();


      for (
        const item of items
      ) {

        const variantId =
          String(
            item?.variantId || ''
          );


        const quantity =
          Number(
            item?.quantity || 0
          );


        if (
          !variantId ||
          !Number.isInteger(quantity) ||
          quantity <= 0
        ) {

          return res.status(400).json({

            message:
              'Invalid cart item.'

          });

        }


        quantityMap.set(

          variantId,

          (
            quantityMap.get(
              variantId
            ) || 0
          ) + quantity

        );

      }


      const variantIds =
        [...quantityMap.keys()];


      const variants =
        await sql`

          SELECT

            v.id,

            v.product_id,

            v.sku,

            v.variant_name,

            v.weight_grams,

            v.flavor,

            v.mrp,

            v.selling_price,

            v.tax_rate,

            v.badge,

            v.tone,

            p.name AS product_name,

            COALESCE(
              i.quantity_on_hand,
              0
            ) AS quantity_on_hand,

            COALESCE(
              i.quantity_reserved,
              0
            ) AS quantity_reserved

          FROM product_variants v

          INNER JOIN products p
            ON p.id = v.product_id

          LEFT JOIN inventory i
            ON i.variant_id = v.id

          WHERE

            v.id = ANY(${variantIds})

            AND v.is_active = true

            AND p.is_active = true

        `;


      if (
        variants.length !==
        variantIds.length
      ) {

        return res.status(400).json({

          message:
            'One or more products in your cart are no longer available.'

        });

      }


      let subtotal = 0;

      let taxAmount = 0;


      const orderItems = [];


      for (
        const variant of variants
      ) {

        const requestedQuantity =
          quantityMap.get(
            variant.id
          );


        const quantityOnHand =
          Number(
            variant.quantity_on_hand || 0
          );


        const quantityReserved =
          Number(
            variant.quantity_reserved || 0
          );


        const availableQuantity =
          Math.max(
            quantityOnHand -
              quantityReserved,
            0
          );


        if (
          requestedQuantity >
          availableQuantity
        ) {

          return res.status(409).json({

            message:
              `${variant.product_name} is not available in the requested quantity.`

          });

        }


        const unitPrice =
          Number(
            variant.selling_price || 0
          );


        const taxRate =
          Number(
            variant.tax_rate || 0
          );


        const lineSubtotal =
          unitPrice *
          requestedQuantity;


        const lineTax =
          lineSubtotal *
          (
            taxRate / 100
          );


        subtotal +=
          lineSubtotal;


        taxAmount +=
          lineTax;


        orderItems.push({

          variant,

          quantity:
            requestedQuantity,

          unitPrice,

          lineSubtotal,

          lineTax

        });

      }


      /*
       * Shipping is temporarily zero.
       * Final shipping policy will be
       * configured before launch.
       */

      const shippingAmount = 0;

      const discountAmount = 0;


      const totalAmount =
        subtotal +
        taxAmount +
        shippingAmount -
        discountAmount;


      const orderNumber =
        `TCH-${Date.now()
          .toString(36)
          .toUpperCase()}`;


      const orderRows =
        await sql`

          INSERT INTO orders (

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

            notes

          )

          VALUES (

            ${orderNumber},

            ${customerName},

            ${phone},

            ${email || null},

            ${JSON.stringify(
              shippingAddress
            )}::jsonb,

            ${
              billingAddress
                ? JSON.stringify(
                    billingAddress
                  )
                : null
            }::jsonb,

            ${subtotal},

            ${discountAmount},

            ${shippingAmount},

            ${taxAmount},

            ${totalAmount},

            'INR',

            'pending',

            'pending',

            ${notes || null}

          )

          RETURNING

            id,

            order_number,

            subtotal,

            discount_amount,

            shipping_amount,

            tax_amount,

            total_amount,

            currency,

            status,

            payment_status,

            created_at

        `;


      const order =
        orderRows[0];


      for (
        const item of orderItems
      ) {

        await sql`

          INSERT INTO order_items (

            order_id,

            product_variant_id,

            sku,

            product_name,

            variant_name,

            quantity,

            unit_price,

            tax_rate,

            tax_amount,

            line_total

          )

          VALUES (

            ${order.id},

            ${item.variant.id},

            ${item.variant.sku},

            ${item.variant.product_name},

            ${item.variant.variant_name},

            ${item.quantity},

            ${item.unitPrice},

            ${Number(
              item.variant.tax_rate || 0
            )},

            ${item.lineTax},

            ${
              item.lineSubtotal +
              item.lineTax
            }

          )

        `;

      }


      await sql`

        INSERT INTO order_status_history (

          order_id,

          status,

          notes

        )

        VALUES (

          ${order.id},

          'pending',

          'Order created from storefront.'

        )

      `;


      res.status(201).json({

        success: true,

        order: {

          id:
            order.id,

          orderNumber:
            order.order_number,

          subtotal:
            Number(
              order.subtotal
            ),

          discountAmount:
            Number(
              order.discount_amount
            ),

          shippingAmount:
            Number(
              order.shipping_amount
            ),

          taxAmount:
            Number(
              order.tax_amount
            ),

          totalAmount:
            Number(
              order.total_amount
            ),

          currency:
            order.currency,

          status:
            order.status,

          paymentStatus:
            order.payment_status,

          createdAt:
            order.created_at

        }

      });

    } catch (error) {

      console.error(
        'Unable to create order:',
        error
      );

      res.status(500).json({

        message:
          'Unable to create order.'

      });

    }

  }
);


/* =========================================================
   404
   ========================================================= */

app.use(
  (req, res) => {

    res.status(404).json({

      message:
        'API endpoint not found.'

    });

  }
);


/* =========================================================
   GLOBAL ERROR HANDLER
   ========================================================= */

app.use(
  (error, req, res, next) => {

    console.error(
      'Unhandled server error:',
      error
    );

    res.status(500).json({

      message:
        'Internal server error.'

    });

  }
);


/* =========================================================
   START SERVER
   ========================================================= */

app.listen(
  PORT,
  () => {

    console.log(
      `The Crunchy Heart API running on http://localhost:${PORT}`
    );

    console.log(
      `Environment file: ${envPath}`
    );

  }
);