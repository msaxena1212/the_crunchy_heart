import fs from 'fs';
import pg from 'pg';

const connectionString = process.env.DATABASE_URL || 'postgresql://neondb_owner:npg_rabiA3pl8KXT@ep-bitter-paper-b5e2ow9f-pooler.c-7.us-east-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require';

const pool = new pg.Pool({ connectionString });

async function main() {
  const sql = fs.readFileSync('database/migrations/add_festive_and_bulk_products.sql', 'utf8');
  await pool.query(sql);
  console.log('MIGRATION_SUCCESS');
  await pool.end();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
