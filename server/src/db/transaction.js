import { pool } from './pool.js';

export async function withTransaction(
    callback
) {
    const client =
        await pool.connect();

    try {
        await client.query('BEGIN');

        const result =
            await callback(client);

        await client.query('COMMIT');

        return result;

    } catch (error) {

        try {
            await client.query(
                'ROLLBACK'
            );
        } catch (rollbackError) {
            console.error(
                'Rollback failed:',
                rollbackError
            );
        }

        throw error;

    } finally {
        client.release();
    }
}