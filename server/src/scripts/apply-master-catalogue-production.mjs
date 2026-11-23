import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Target Neon Production branch
const PROD_URL = process.env.PRODUCTION_DATABASE_URL || 'postgresql://neondb_owner:npg_rabiA3pl8KXT@ep-solitary-block-b5rcxpu7-pooler.c-7.us-east-2.aws.neon.tech/neondb?sslmode=require';

async function applyMasterCatalogueProduction() {
  console.log(`\n======================================================`);
  console.log(`THE CRUNCHY HEART — Master Catalogue Production Migration`);
  console.log(`======================================================`);

  const pool = new pg.Pool({
    connectionString: PROD_URL,
    ssl: { rejectUnauthorized: false }
  });

  const client = await pool.connect();
  try {
    // 1. Apply Schema Migration 010 (idempotent IF NOT EXISTS)
    const migration010 = path.resolve(__dirname, '../../../database/migrations/010_catalogue_expansion_schema.sql');
    const sql010 = fs.readFileSync(migration010, 'utf8');
    console.log(`[STEP 1] Executing migration: ${migration010}`);
    await client.query(sql010);
    console.log(`[SUCCESS] 010_catalogue_expansion_schema.sql applied cleanly!`);

    // 2. Set environment variable DATABASE_URL for seed script and run seed logic
    console.log(`[STEP 2] Running Master Catalogue Seed Ingestion on Production...`);
    process.env.DATABASE_URL = PROD_URL;
    process.env.DATABASE_URL_UNPOOLED = PROD_URL;
    const { seedMasterCatalogue } = await import('./seed-master-catalogue.mjs');
    const seedResult = await seedMasterCatalogue();
    console.log(`[SUCCESS] Seed result:`, seedResult);

    // 3. Apply product images migration
    const imagesMigration = path.resolve(__dirname, '../../../database/migrations/add_missing_product_images.sql');
    const imagesSql = fs.readFileSync(imagesMigration, 'utf8');
    console.log(`[STEP 3] Executing image migration: ${imagesMigration}`);
    await client.query(imagesSql);
    console.log(`[SUCCESS] add_missing_product_images.sql applied cleanly!`);

    // 4. Run Quality & Integrity Health Checks
    console.log(`\n[STEP 4] Running Health Checks...`);
    const prodCountRes = await client.query('SELECT count(*) as total_products FROM products');
    console.log(`Total Products on Production:`, prodCountRes.rows[0].total_products);

    const imgCountRes = await client.query('SELECT count(*) as total_images FROM product_images');
    console.log(`Total Product Images on Production:`, imgCountRes.rows[0].total_images);

    const varCountRes = await client.query('SELECT count(*) as total_variants FROM product_variants');
    console.log(`Total Product Variants on Production:`, varCountRes.rows[0].total_variants);

    console.log(`\n======================================================`);
    console.log(`MASTER CATALOGUE & IMAGES SUCCESSFULLY APPLIED TO PRODUCTION!`);
    console.log(`======================================================\n`);
  } catch (err) {
    console.error(`[ERROR] Production migration failed:`, err);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

applyMasterCatalogueProduction()
  .then(() => process.exit(0))
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
