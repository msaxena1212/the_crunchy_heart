import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { env } from '../config/env.js';

const connectionString = env.databaseUrlUnpooled || env.databaseUrl;

const client = new pg.Client({
  connectionString,
  ssl: { rejectUnauthorized: false },
});

async function dumpData() {
  await client.connect();

  const tables = [
    'categories',
    'products',
    'product_variants',
    'inventory',
    'store_settings',
    'admin_users',
    'orders',
    'order_items',
    'payments',
    'inventory_transactions',
  ];

  let sql = '-- THE CRUNCHY HEART - LIVE NEON BACKUP DATA\n';
  sql += 'SET session_replication_role = replica;\n\n';

  for (const table of tables) {
    const { rows } = await client.query(`SELECT * FROM "${table}"`);
    if (rows.length === 0) continue;

    console.log(`Exporting ${table} (${rows.length} rows)...`);
    const cols = Object.keys(rows[0]);
    const colList = cols.map((c) => `"${c}"`).join(', ');

    for (const row of rows) {
      const values = cols
        .map((c) => {
          const val = row[c];
          if (val === null || val === undefined) return 'NULL';
          if (typeof val === 'number' || typeof val === 'boolean') return val;
          if (val instanceof Date) return `'${val.toISOString()}'`;
          if (typeof val === 'object')
            return `'${JSON.stringify(val).replace(/'/g, "''")}'`;
          return `'${String(val).replace(/'/g, "''")}'`;
        })
        .join(', ');

      sql += `INSERT INTO "${table}" (${colList}) VALUES (${values}) ON CONFLICT DO NOTHING;\n`;
    }
    sql += '\n';
  }

  sql += 'SET session_replication_role = DEFAULT;\n';

  const outPath = path.resolve('..', 'database', 'neon_data_backup.sql');
  fs.writeFileSync(outPath, sql, 'utf8');
  console.log(`Saved clean data dump to: ${outPath}`);

  await client.end();
}

dumpData().catch((err) => {
  console.error('Data dump error:', err);
  process.exit(1);
});
