import { Pool } from '@neondatabase/serverless';
import { env } from '../config/env.js';

export const pool = new Pool({
    connectionString: env.databaseUrl
});

export async function query(
    text,
    params = []
) {
    return pool.query(text, params);
}