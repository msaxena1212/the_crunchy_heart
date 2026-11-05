import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TEST_DB_URL =
    process.env.TEST_DATABASE_URL ||
    process.env.DATABASE_URL ||
    'postgresql://postgres:postgres@127.0.0.1:5432/crunchy_heart_test';

// --------------------------------------------------------------------------
// HARD SAFETY ASSERTION: REFUSE TO RUN AGAINST NEON OR NON-LOCAL TEST DB
// --------------------------------------------------------------------------
if (
    TEST_DB_URL.includes('neon.tech') ||
    TEST_DB_URL.includes('aws.neon.tech') ||
    TEST_DB_URL.includes('ep-solitary-block')
) {
    throw new Error('FATAL SAFETY VIOLATION: Refusing to run DDL migration against live Neon database!');
}

if (!TEST_DB_URL.includes('crunchy_heart_test')) {
    throw new Error(`FATAL SAFETY VIOLATION: Migration must strictly run against 'crunchy_heart_test'. Given: ${TEST_DB_URL}`);
}

const pool = new pg.Pool({ connectionString: TEST_DB_URL });

async function run() {
    const client = await pool.connect();
    try {
        console.log('Connected to target database:', TEST_DB_URL);
        const dbCheck = await client.query('SELECT current_database() AS db, current_user AS usr');
        console.log('Confirmed database target:', dbCheck.rows[0]);

        if (dbCheck.rows[0].db !== 'crunchy_heart_test') {
            throw new Error(`Expected crunchy_heart_test but connected to ${dbCheck.rows[0].db}`);
        }

        const migrationPath = path.resolve(__dirname, '../../../database/migrations/add_payment_reconciliation_queue.sql');
        const sql = fs.readFileSync(migrationPath, 'utf8');

        console.log('Applying migration from:', migrationPath);
        await client.query(sql);
        console.log('Migration applied successfully!');

        // Verify table exists
        const tableCheck = await client.query(
            "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'payment_reconciliation_queue'"
        );
        console.log('Table check result:', tableCheck.rows);

        // Verify columns
        const cols = await client.query(
            "SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_name = 'payment_reconciliation_queue' ORDER BY ordinal_position"
        );
        console.log('Columns:');
        for (const c of cols.rows) {
            console.log(` - ${c.column_name}: ${c.data_type} (nullable: ${c.is_nullable}, default: ${c.column_default})`);
        }

        // Verify foreign keys
        const fks = await client.query(
            `SELECT tc.constraint_name, kcu.column_name, ccu.table_name AS foreign_table_name, ccu.column_name AS foreign_column_name, rc.delete_rule 
             FROM information_schema.table_constraints tc 
             JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name 
             JOIN information_schema.referential_constraints rc ON tc.constraint_name = rc.constraint_name 
             JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name 
             WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_name = 'payment_reconciliation_queue'`
        );
        console.log('Foreign Keys:', fks.rows);

        // Verify constraints
        const cons = await client.query(
            `SELECT constraint_name, constraint_type 
             FROM information_schema.table_constraints 
             WHERE table_name = 'payment_reconciliation_queue'`
        );
        console.log('Constraints:', cons.rows);

        // Verify indexes
        const idxs = await client.query(
            `SELECT indexname, indexdef 
             FROM pg_indexes 
             WHERE tablename = 'payment_reconciliation_queue'`
        );
        console.log('Indexes:');
        for (const idx of idxs.rows) {
            console.log(` - ${idx.indexname}: ${idx.indexdef}`);
        }
    } finally {
        client.release();
        await pool.end();
    }
}

run().catch(err => {
    console.error('Migration failed:', err);
    process.exit(1);
});
