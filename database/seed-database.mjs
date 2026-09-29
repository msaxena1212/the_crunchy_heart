import fs from 'node:fs';
import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });

const { Client } = pg;

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error('DATABASE_URL is not configured in .env.local');
}

const client = new Client({
  connectionString: databaseUrl,
  ssl: {
    rejectUnauthorized: false
  }
});

try {
  await client.connect();

  console.log('Connected to Neon PostgreSQL.');

  const seed = fs.readFileSync('./database/seed.sql', 'utf8');

  await client.query(seed);

  console.log('Initial catalog seeded successfully.');
} catch (error) {
  console.error('Seed failed:');
  console.error(error);
  process.exitCode = 1;
} finally {
  await client.end();
}
