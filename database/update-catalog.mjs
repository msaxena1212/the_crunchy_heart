import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config({
  path: '.env.local'
});

const { Client } = pg;

const databaseUrl =
  process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error(
    'DATABASE_URL is not configured in .env.local'
  );
}

const client = new Client({
  connectionString: databaseUrl,
  ssl: {
    rejectUnauthorized: false
  }
});

try {

  await client.connect();

  console.log(
    'Connected to Neon PostgreSQL.'
  );


  /*
   * ========================================================
   * RAW MAKHANA PRICING
   * ========================================================
   */

  const rawPricing = [

    ['TCH-RAW-100', 229],
    ['TCH-RAW-200', 399],
    ['TCH-RAW-500', 899],
    ['TCH-RAW-1KG', 1649]

  ];


  for (const [sku, price] of rawPricing) {

    await client.query(
      `
      UPDATE product_variants
      SET
        selling_price = $2,
        updated_at = NOW()
      WHERE sku = $1
      `,
      [sku, price]
    );

  }


  /*
   * ========================================================
   * EXISTING FLAVOUR PRICING
   * ========================================================
   */

  const existingFlavours = [

    ['TCH-FLV-HIMALAYAN', 'Himalayan Salt', 199],
    ['TCH-FLV-PERI', 'Peri Peri', 199],
    ['TCH-FLV-PUDINA', 'Mint Pudina', 199],
    ['TCH-FLV-ONION', 'Cream & Onion', 195]

  ];


  for (
    const [sku, name, price]
    of existingFlavours
  ) {

    await client.query(
      `
      UPDATE product_variants
      SET
        variant_name = $2,
        flavor = $2,
        selling_price = $3,
        updated_at = NOW()
      WHERE sku = $1
      `,
      [sku, name, price]
    );

  }


  /*
   * ========================================================
   * FIND FLAVOURED PRODUCT
   * ========================================================
   */

  const productResult =
    await client.query(
      `
      SELECT id
      FROM products
      WHERE slug = 'flavoured-makhana'
      LIMIT 1
      `
    );


  if (!productResult.rows.length) {

    throw new Error(
      'Flavoured Makhana product not found.'
    );

  }


  const flavouredProductId =
    productResult.rows[0].id;


  /*
   * ========================================================
   * NEW FLAVOURS
   * ========================================================
   */

  const newFlavours = [

    {
      sku: 'TCH-FLV-TOMATO',
      name: 'Tomato Tangy',
      price: 199,
      tone: 'tomato'
    },

    {
      sku: 'TCH-FLV-CHILLI',
      name: 'Chilli Garlic',
      price: 199,
      tone: 'chilli'
    },

    {
      sku: 'TCH-FLV-BIHARI',
      name: 'Bihari Chat',
      price: 229,
      tone: 'bihari'
    }

  ];


  for (
    const flavour
    of newFlavours
  ) {

    const existing =
      await client.query(
        `
        SELECT id
        FROM product_variants
        WHERE sku = $1
        LIMIT 1
        `,
        [flavour.sku]
      );


    if (existing.rows.length) {

      await client.query(
        `
        UPDATE product_variants
        SET
          variant_name = $2,
          flavor = $2,
          weight_grams = 70,
          selling_price = $3,
          tone = $4,
          is_active = true,
          updated_at = NOW()
        WHERE sku = $1
        `,
        [
          flavour.sku,
          flavour.name,
          flavour.price,
          flavour.tone
        ]
      );

    } else {

      await client.query(
        `
        INSERT INTO product_variants (
          product_id,
          sku,
          variant_name,
          weight_grams,
          flavor,
          mrp,
          selling_price,
          cost_price,
          tax_rate,
          badge,
          tone,
          is_active,
          sort_order
        )
        VALUES (
          $1,
          $2,
          $3,
          70,
          $3,
          0,
          $4,
          0,
          0,
          NULL,
          $5,
          true,
          $6
        )
        `,
        [
          flavouredProductId,
          flavour.sku,
          flavour.name,
          flavour.price,
          flavour.tone,
          flavour.sku === 'TCH-FLV-TOMATO'
            ? 5
            : flavour.sku === 'TCH-FLV-CHILLI'
              ? 6
              : 7
        ]
      );

    }

  }


  /*
   * ========================================================
   * INVENTORY FOR NEW FLAVOURS
   * ========================================================
   */

  for (
    const flavour
    of newFlavours
  ) {

    const variantResult =
      await client.query(
        `
        SELECT id
        FROM product_variants
        WHERE sku = $1
        LIMIT 1
        `,
        [flavour.sku]
      );


    if (!variantResult.rows.length) {
      continue;
    }


    const variantId =
      variantResult.rows[0].id;


    await client.query(
      `
      INSERT INTO inventory (
        variant_id,
        quantity_on_hand,
        quantity_reserved,
        reorder_level
      )
      VALUES (
        $1,
        0,
        0,
        10
      )
      ON CONFLICT (variant_id)
      DO NOTHING
      `,
      [variantId]
    );

  }


  /*
   * ========================================================
   * VERIFY CATALOG
   * ========================================================
   */

  const result =
    await client.query(
      `
      SELECT
        pv.sku,
        p.name AS product_name,
        pv.variant_name,
        pv.weight_grams,
        pv.selling_price,
        pv.is_active,
        COALESCE(
          i.quantity_on_hand,
          0
        ) AS quantity_on_hand
      FROM product_variants pv
      INNER JOIN products p
        ON p.id = pv.product_id
      LEFT JOIN inventory i
        ON i.variant_id = pv.id
      WHERE pv.is_active = true
      ORDER BY
        p.sort_order,
        pv.sort_order
      `
    );


  console.table(
    result.rows
  );


  console.log(
    '\nCatalog update completed successfully.'
  );


} catch (error) {

  console.error(
    '\nCatalog update failed:'
  );

  console.error(error);

  process.exitCode = 1;

} finally {

  await client.end();

}