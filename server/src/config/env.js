import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const envPath = path.resolve(__dirname, '../../../.env.local');

dotenv.config({ path: envPath });

if (!process.env.DATABASE_URL) {
    throw new Error(
        `DATABASE_URL is missing. Expected environment file at: ${envPath}`
    );
}

export const env = {
    nodeEnv: process.env.NODE_ENV || 'development',

    port: Number(process.env.PORT || 5000),

    clientUrl:
        process.env.CLIENT_URL ||
        'http://localhost:4200',

    databaseUrl:
        process.env.DATABASE_URL,

    databaseUrlUnpooled:
        process.env.DATABASE_URL_UNPOOLED ||
        process.env.DATABASE_URL,

    cashfreeClientId:
        process.env.CASHFREE_CLIENT_ID || '',

    cashfreeClientSecret:
        process.env.CASHFREE_CLIENT_SECRET || '',

    cashfreeEnvironment:
        process.env.CASHFREE_ENVIRONMENT || 'sandbox',

    cashfreeApiVersion:
        process.env.CASHFREE_API_VERSION || '2025-01-01',

    cashfreeReturnUrl:
        process.env.CASHFREE_RETURN_URL ||
        'http://localhost:4200/payment/callback',

    cashfreeWebhookUrl:
        process.env.CASHFREE_WEBHOOK_URL ||
        'http://localhost:5000/api/payments/cashfree/webhook',

    envPath,
};