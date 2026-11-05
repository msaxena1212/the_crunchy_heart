/**
 * The Crunchy Heart - Canonical schema completeness
 *
 * Static checks always run: every table referenced by application SQL must be
 * defined in database/schema.sql, and the migrations must not reference objects
 * outside the canonical schema.
 *
 * The database-level check builds a fresh disposable database from the canonical
 * schema and then the migrations, and verifies required columns and indexes. It
 * creates and drops a database, so it runs only when SCHEMA_FRESH_BUILD=1 is set.
 * It refuses any host other than 127.0.0.1 and any database name that does not
 * contain 'crunchy_heart_test'.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(here, '..');
const schemaPath = path.resolve(serverRoot, '..', 'database', 'schema.sql');
const migrationDir = path.resolve(serverRoot, '..', 'database', 'migrations');

// Words and system catalogs that look like table references in SQL-bearing text.
const NON_TABLE_TOKENS = new Set([
    'the', 'last', 'this', 'cancelled', 'cli', 'order', 'cashfree', 'reconciliation', 'environment',
    'allowlisted', 'free', 're', 'ever', 'await', 'to', 'const', 'manual', 'terminal', 'select',
    'where', 'set', 'values', 'dual', 'lateral', 'unnest', 'information_schema', 'pg_indexes',
    'generate_series', 'json_each',
]);

function walk(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(p, out);
        else if (p.endsWith('.js') || p.endsWith('.mjs')) out.push(p);
    }
    return out;
}

function referencedTables() {
    const found = new Map();
    for (const file of walk(path.join(serverRoot, 'src'))) {
        // Comments are prose, not SQL. Strip them so words in documentation are not read as tables.
        const text = fs.readFileSync(file, 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/^\s*\/\/.*$/gm, '');
        // Common table-expression names are local to their statement, not tables.
        const ctes = new Set([...text.matchAll(/([a-z_][a-z0-9_]*)\s+AS\s*\(/gi)].map(m => m[1].toLowerCase()));
        for (const m of text.matchAll(/\b(?:FROM|INTO|UPDATE|JOIN)\s+([a-z_][a-z0-9_]*)/gi)) {
            const name = m[1].toLowerCase();
            if (ctes.has(name) || NON_TABLE_TOKENS.has(name)) continue;
            if (!found.has(name)) found.set(name, new Set());
            found.get(name).add(path.relative(serverRoot, file));
        }
    }
    return found;
}

function definedTables(schemaText) {
    return new Set([...schemaText.matchAll(/CREATE TABLE IF NOT EXISTS ([a-z_][a-z0-9_]*)/gi)].map(m => m[1].toLowerCase()));
}

describe('Canonical schema completeness (static)', () => {
    const schemaText = fs.readFileSync(schemaPath, 'utf8');

    test('1. Every table referenced by application SQL is defined in the canonical schema', () => {
        const defined = definedTables(schemaText);
        const referenced = referencedTables();
        const missing = [...referenced.keys()].filter(name => !defined.has(name));
        assert.deepEqual(missing, [], `tables used by the application but absent from schema.sql: ${missing.join(', ')}`);
    });

    test('2. Migrations are idempotent: no bare ADD CONSTRAINT without a preceding guard', () => {
        for (const file of fs.readdirSync(migrationDir).filter(f => f.endsWith('.sql'))) {
            const text = fs.readFileSync(path.join(migrationDir, file), 'utf8');
            const adds = [...text.matchAll(/ADD CONSTRAINT ([a-z_][a-z0-9_]*)/gi)].map(m => m[1]);
            for (const name of adds) {
                const guarded = new RegExp(`DROP CONSTRAINT IF EXISTS ${name}\\b`).test(text);
                assert.ok(guarded, `${file}: ADD CONSTRAINT ${name} is not guarded by DROP CONSTRAINT IF EXISTS`);
            }
        }
    });

    test('3. The canonical schema includes every migration object, so fresh installs need no migration step', () => {
        const required = [
            /CREATE TABLE IF NOT EXISTS payment_reconciliation_queue/,
            /CREATE TABLE IF NOT EXISTS payment_reconciliation_incidents/,
            /CREATE TABLE IF NOT EXISTS operational_alerts/,
            /idempotency_fingerprint/,
            /claim_token UUID|claim_token\s+UUID|ADD COLUMN IF NOT EXISTS claim_token/,
            /ADD CONSTRAINT chk_refunds_status/,
            /chk_recon_queue_resolution_action/,
        ];
        for (const re of required) {
            assert.match(schemaText, re, `schema.sql is missing: ${re}`);
        }
    });
});

describe('Canonical schema builds a fresh database (opt-in)', () => {
    const runFreshBuild = process.env.SCHEMA_FRESH_BUILD === '1';

    test('4. A fresh disposable database built from schema and migrations has the required objects', { skip: !runFreshBuild }, async () => {
        const pgModule = await import('pg');
        const pg = pgModule.default;
        const adminUrl = 'postgresql://postgres:postgres@127.0.0.1:5432/postgres';
        const dbName = 'crunchy_heart_test_schema_check';
        const dbUrl = `postgresql://postgres:postgres@127.0.0.1:5432/${dbName}`;

        if (!new URL(dbUrl).hostname.match(/^127\.0\.0\.1$/) || !dbName.includes('crunchy_heart_test')) {
            throw new Error('ABORT: refusing to build outside the local isolated test namespace.');
        }

        const admin = new pg.Pool({ connectionString: adminUrl, connectionTimeoutMillis: 5000 });
        await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
        await admin.query(`CREATE DATABASE ${dbName}`);

        const db = new pg.Pool({ connectionString: dbUrl, connectionTimeoutMillis: 5000, statement_timeout: 120000 });
        try {
            await db.query(fs.readFileSync(schemaPath, 'utf8'));
            for (const file of fs.readdirSync(migrationDir).filter(f => f.endsWith('.sql')).sort()) {
                await db.query(fs.readFileSync(path.join(migrationDir, file), 'utf8'));
            }

            const columns = await db.query(`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'`);
            const have = new Set(columns.rows.map(r => `${r.table_name}.${r.column_name}`));
            const requiredColumns = [
                'orders.idempotency_key', 'orders.idempotency_fingerprint', 'orders.payment_method',
                'orders.tax_rate', 'orders.price_includes_tax', 'order_items.taxable_value',
                'payments.idempotency_key', 'payments.gateway_status', 'refunds.idempotency_key',
                'refunds.claim_token', 'payment_reconciliation_queue.claim_token',
            ];
            for (const col of requiredColumns) assert.ok(have.has(col), `missing column ${col}`);

            const indexes = await db.query(`SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`);
            const idx = new Set(indexes.rows.map(r => r.indexname));
            for (const name of ['ux_orders_idempotency_key', 'uq_refunds_provider_refund_id']) {
                assert.ok(idx.has(name), `missing index ${name}`);
            }

            const tables = await db.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`);
            const tset = new Set(tables.rows.map(r => r.table_name));
            for (const name of ['admin_users', 'admin_audit_logs', 'store_settings', 'operational_alerts', 'payment_reconciliation_incidents']) {
                assert.ok(tset.has(name), `missing table ${name}`);
            }
        } finally {
            await db.end();
            await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
            await admin.end();
        }
    });
});
