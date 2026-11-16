import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Target Neon branches
const STAGING_URL = 'postgresql://neondb_owner:npg_rabiA3pl8KXT@ep-bitter-paper-b5e2ow9f-pooler.c-7.us-east-2.aws.neon.tech/neondb?sslmode=require';
const PROD_URL = 'postgresql://neondb_owner:npg_rabiA3pl8KXT@ep-solitary-block-b5rcxpu7-pooler.c-7.us-east-2.aws.neon.tech/neondb?sslmode=require';

async function migrateBranch(name, connStr) {
  console.log(`\n========================================`);
  console.log(`Applying catalogue migration to: ${name}`);
  console.log(`========================================`);
  const pool = new pg.Pool({
    connectionString: connStr,
    ssl: { rejectUnauthorized: false }
  });

  const client = await pool.connect();
  try {
    const migrationPath = path.resolve(__dirname, '../../../database/migrations/add_dry_fruits_and_spices.sql');
    const sql = fs.readFileSync(migrationPath, 'utf8');

    console.log(`Reading migration: ${migrationPath}`);
    await client.query(sql);
    console.log(`Migration executed successfully on ${name}!`);

    // Verify
    const catRes = await client.query('SELECT name, slug, is_active FROM categories ORDER BY sort_order');
    console.log(`Categories in ${name}:`, catRes.rows);

    const prodCount = await client.query('SELECT c.name as category, count(p.id) as product_count FROM categories c LEFT JOIN products p ON p.category_id = c.id GROUP BY c.id, c.name, c.sort_order ORDER BY c.sort_order');
    console.log(`Product counts by category in ${name}:`, prodCount.rows);

    const varCount = await client.query('SELECT count(*) as total_variants FROM product_variants');
    console.log(`Total variants in ${name}:`, varCount.rows[0]);

    const invCount = await client.query('SELECT count(*) as total_inventory, sum(quantity_on_hand) as total_stock FROM inventory');
    console.log(`Inventory in ${name}:`, invCount.rows[0]);

  } catch (err) {
    console.error(`Error on ${name}:`, err);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

async function main() {
  await migrateBranch('STAGING (br-icy-glade-b5g747q0)', STAGING_URL);
  try {
    await migrateBranch('PRODUCTION (br-aged-term-b5hwkow2)', PROD_URL);
  } catch (err) {
    console.warn('Production branch might be paused/archived, error:', err.message);
  }
}

main().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
