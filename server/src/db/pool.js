import fs from 'node:fs';
import pg from 'pg';
import { env } from '../config/env.js';

/*
|--------------------------------------------------------------------------
| PostgreSQL Pool
|--------------------------------------------------------------------------
| Uses the standard `pg` driver for any PostgreSQL host (AWS RDS, local
| test DB, or Neon during the migration window). TLS is taken from the
| connection string (`sslmode=...`). To verify the RDS server certificate,
| set DATABASE_SSL_CA_PATH to the AWS RDS CA bundle file.
*/

const sslCaPath = process.env.DATABASE_SSL_CA_PATH || '';

const ssl = sslCaPath
    ? { ca: fs.readFileSync(sslCaPath, 'utf8'), rejectUnauthorized: true }
    : undefined;

export const pool = new pg.Pool({
    connectionString: env.databaseUrl,
    ...(ssl ? { ssl } : {}),
});

export async function query(
    text,
    params = []
) {
    return pool.query(text, params);
}
