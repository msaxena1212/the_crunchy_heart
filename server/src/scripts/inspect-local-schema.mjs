import pg from 'pg';

const connectionString = process.env.DATABASE_URL || 'postgresql://postgres:postgres@127.0.0.1:5432/crunchy_heart_test';
const pool = new pg.Pool({ connectionString });

async function run() {
  const tables = ['orders', 'payments', 'refunds', 'order_status_history', 'admin_users', 'admin_audit_logs'];
  for (const t of tables) {
    const cols = await pool.query(
      `SELECT column_name, data_type, is_nullable, column_default 
       FROM information_schema.columns 
       WHERE table_schema = 'public' AND table_name = $1 
       ORDER BY ordinal_position`,
      [t]
    );
    const fks = await pool.query(
      `SELECT tc.constraint_name, kcu.column_name, ccu.table_name AS foreign_table_name, ccu.column_name AS foreign_column_name, rc.delete_rule 
       FROM information_schema.table_constraints tc 
       JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name 
       JOIN information_schema.referential_constraints rc ON tc.constraint_name = rc.constraint_name 
       JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name 
       WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_name = $1`,
      [t]
    );
    const uqs = await pool.query(
      `SELECT tc.constraint_name, kcu.column_name 
       FROM information_schema.table_constraints tc 
       JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name 
       WHERE tc.constraint_type = 'UNIQUE' AND tc.table_name = $1`,
      [t]
    );
    console.log('=== TABLE:', t);
    console.log('COLUMNS:', cols.rows.map(c => `${c.column_name} (${c.data_type}, nullable: ${c.is_nullable}, default: ${c.column_default})`));
    console.log('FKS:', fks.rows);
    console.log('UNIQUES:', uqs.rows);
  }
  await pool.end();
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});

