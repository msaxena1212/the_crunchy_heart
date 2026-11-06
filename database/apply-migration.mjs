import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from '../server/node_modules/@neondatabase/serverless/index.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Read connection string from environment or .env.local
let connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  try {
    const envLocalPath = path.resolve(__dirname, '../.env.local');
    if (fs.existsSync(envLocalPath)) {
      const content = fs.readFileSync(envLocalPath, 'utf8');
      const match = content.match(/DATABASE_URL=["']?([^"'\r\n]+)["']?/);
      if (match) {
        connectionString = match[1];
      }
    }
  } catch (e) {
    // ignore
  }
}

if (!connectionString) {
  console.error('ERROR: DATABASE_URL is not set.');
  process.exit(1);
}

const pool = new Pool({ connectionString });

async function run() {
  try {
    console.log('Applying migration...');
    const migrationFile = process.argv[2] || 'database/migrations/add_cheese_herbs_and_stock.sql';
    const sql = fs.readFileSync(migrationFile, 'utf8');
    await pool.query(sql);
    console.log('Migration executed successfully!');

    const check = await pool.query(`
      SELECT
        p.name AS product_category,
        pv.variant_name,
        pv.sku,
        pv.weight_grams,
        pv.selling_price,
        pv.mrp,
        pv.badge,
        pv.tone,
        i.quantity_on_hand,
        (i.quantity_on_hand - i.quantity_reserved) AS available_quantity
      FROM product_variants pv
      INNER JOIN products p ON p.id = pv.product_id
      LEFT JOIN inventory i ON i.variant_id = pv.id
      WHERE pv.is_active = TRUE
      ORDER BY p.sort_order ASC, pv.sort_order ASC;
    `);

    console.table(check.rows);
  } catch (err) {
    console.error('Migration failed:', err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

run();
