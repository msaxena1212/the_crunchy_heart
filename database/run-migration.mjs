import fs from 'fs';
import pg from 'pg';

const connectionString = process.env.DATABASE_URL || 'postgresql://neondb_owner:npg_rabiA3pl8KXT@ep-bitter-paper-b5e2ow9f-pooler.c-7.us-east-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require';

const pool = new pg.Pool({ connectionString });

async function main() {
  const file = process.argv[2] || 'database/migrations/update_bulk_suta_grades.sql';
  console.log(`Running migration from ${file}...`);
  const sql = fs.readFileSync(file, 'utf8');
  await pool.query(sql);
  console.log('MIGRATION_SUCCESS');
  await pool.end();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
