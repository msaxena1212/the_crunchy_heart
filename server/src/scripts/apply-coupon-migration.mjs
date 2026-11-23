import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
    console.error('DATABASE_URL is not set.');
    process.exit(1);
}

const pool = new pg.Pool({
    connectionString: databaseUrl,
    ssl: databaseUrl.includes('neon.tech') ? { rejectUnauthorized: false } : undefined,
});

async function run() {
    const client = await pool.connect();
    try {
        const migrationPath = path.resolve(__dirname, '../../../database/migrations/add_coupon_redemption_phone.sql');
        const sql = fs.readFileSync(migrationPath, 'utf8');

        console.log('Applying coupon redemption migration...');
        await client.query(sql);
        console.log('Coupon redemption migration applied successfully.');

        const res = await client.query(
            "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'coupon_redemptions' AND column_name = 'phone'"
        );
        console.log('Verified column:', res.rows);
    } finally {
        client.release();
        await pool.end();
    }
}

run().catch(err => {
    console.error('Migration failed:', err);
    process.exit(1);
});
