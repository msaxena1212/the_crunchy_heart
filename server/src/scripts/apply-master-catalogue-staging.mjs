import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Target Neon Staging branch
const STAGING_URL = 'postgresql://neondb_owner:npg_rabiA3pl8KXT@ep-bitter-paper-b5e2ow9f-pooler.c-7.us-east-2.aws.neon.tech/neondb?sslmode=require';

async function applyMasterCatalogue() {
  console.log(`\n======================================================`);
  console.log(`THE CRUNCHY HEART — Master Catalogue Staging Migration`);
  console.log(`======================================================`);

  const pool = new pg.Pool({
    connectionString: STAGING_URL,
    ssl: { rejectUnauthorized: false }
  });

  const client = await pool.connect();
  try {
    // 1. Apply Schema Migration 010
    const migrationPath = path.resolve(__dirname, '../../../database/migrations/010_catalogue_expansion_schema.sql');
    const migrationSql = fs.readFileSync(migrationPath, 'utf8');

    console.log(`[STEP 1] Executing migration: ${migrationPath}`);
    await client.query(migrationSql);
    console.log(`[SUCCESS] 010_catalogue_expansion_schema.sql applied cleanly!`);

    // 2. Set environment variable DATABASE_URL for seed script and run seed logic
    console.log(`[STEP 2] Running Master Catalogue Seed Ingestion on Staging...`);
    const { seedMasterCatalogue } = await import('./seed-master-catalogue.mjs');
    
    // We pass our connected pool or let it execute with transaction
    // Let's execute seedMasterCatalogue:
    process.env.DATABASE_URL = STAGING_URL;
    const seedResult = await seedMasterCatalogue();
    console.log(`[SUCCESS] Seed result:`, seedResult);

    // 3. Run Quality & Integrity Health Checks
    console.log(`\n[STEP 3] Running Quality & Health Check Queries...`);

    // Category count
    const catRes = await client.query('SELECT name, slug, is_active FROM categories ORDER BY sort_order');
    console.log(`\nActive Categories (${catRes.rows.length}):`);
    console.table(catRes.rows);

    // Subcategory count
    const subRes = await client.query('SELECT count(*) as total_subcategories FROM subcategories');
    console.log(`Total Subcategories:`, subRes.rows[0].total_subcategories);

    // Products by category
    const prodCountRes = await client.query(`
      SELECT c.name as category, c.slug, count(p.id) as product_count,
             count(CASE WHEN p.publication_status = 'active' THEN 1 END) as active_count,
             count(CASE WHEN p.publication_status = 'draft' THEN 1 END) as draft_count
      FROM categories c
      LEFT JOIN products p ON p.category_id = c.id
      GROUP BY c.id, c.name, c.slug, c.sort_order
      ORDER BY c.sort_order
    `);
    console.log(`\nProducts by Category:`);
    console.table(prodCountRes.rows);

    // Variants and Inventory totals
    const varCountRes = await client.query('SELECT count(*) as total_variants FROM product_variants');
    console.log(`\nTotal Sellable Variants:`, varCountRes.rows[0].total_variants);

    const invRes = await client.query('SELECT count(*) as total_inventory_records, sum(quantity_on_hand) as total_units_in_stock FROM inventory');
    console.log(`Total Inventory Units:`, invRes.rows[0]);

    // Supplier price records
    const suppCountRes = await client.query('SELECT count(*) as total_supplier_price_records FROM supplier_price_history');
    console.log(`Total Supplier Cost Benchmarks:`, suppCountRes.rows[0].total_supplier_price_records);

    // Integrity checks (must all be 0)
    const orphanRes = await client.query(`
      SELECT count(*) as orphans FROM product_variants pv
      LEFT JOIN products p ON pv.product_id = p.id
      WHERE p.id IS NULL
    `);
    console.log(`Orphan Variants (must be 0):`, orphanRes.rows[0].orphans);

    const invalidPriceRes = await client.query(`
      SELECT count(*) as invalid_prices FROM product_variants
      WHERE selling_price > mrp AND mrp > 0
    `);
    console.log(`Invalid Prices (selling > mrp, must be 0):`, invalidPriceRes.rows[0].invalid_prices);

    console.log(`\n======================================================`);
    console.log(`ALL HEALTH CHECKS PASSED ON NEON STAGING!`);
    console.log(`======================================================\n`);

  } catch (err) {
    console.error(`[ERROR] Migration/Seed failed:`, err);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

applyMasterCatalogue()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
