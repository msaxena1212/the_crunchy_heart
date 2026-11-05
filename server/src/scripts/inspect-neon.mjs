import pg from 'pg';
import { env } from '../config/env.js';

const connectionString = env.databaseUrlUnpooled || env.databaseUrl;

const client = new pg.Client({
  connectionString,
  ssl: connectionString.includes('sslmode=require') || connectionString.includes('neon.tech')
    ? { rejectUnauthorized: false }
    : undefined,
});

async function inspectNeon() {
  try {
    await client.connect();

    const { rows: tableRows } = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      ORDER BY table_name;
    `);

    const tableNames = tableRows.map(r => r.table_name);
    console.log('--- NEON PUBLIC TABLES ---');
    console.log(tableNames.join(', '));

    console.log('\n--- LIVE ROW COUNTS ---');
    for (const table of tableNames) {
      try {
        const res = await client.query(`SELECT count(*)::int AS count FROM "${table}"`);
        console.log(`${table.padEnd(28)}: ${res.rows[0].count} rows`);
      } catch (err) {
        console.log(`${table.padEnd(28)}: ERROR (${err.message})`);
      }
    }
  } catch (err) {
    console.error('Inspection failed:', err);
  } finally {
    await client.end().catch(() => {});
    process.exit(0);
  }
}

inspectNeon();
