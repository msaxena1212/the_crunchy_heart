/*
| Store-wide business settings kept in store_settings (key 'business').
| Currently: the FSSAI licence number, managed from the admin portal.
*/
import { query } from '../db/pool.js';

const KEY = 'business';
// An FSSAI licence / registration number is 14 digits.
const FSSAI_PATTERN = /^\d{14}$/;

async function loadBusiness() {
    const res = await query(`SELECT setting_value FROM store_settings WHERE setting_key = $1 LIMIT 1`, [KEY]);
    return res.rows[0]?.setting_value || {};
}

/** Public, non-sensitive store info shown on the storefront. */
export async function getPublicStoreInfo() {
    const business = await loadBusiness();
    return { fssaiLicenseNumber: business.fssai_license_number || null };
}

export async function getBusinessSettings() {
    return getPublicStoreInfo();
}

export async function updateBusinessSettings({ fssaiLicenseNumber }) {
    const raw = String(fssaiLicenseNumber ?? '').replace(/\s+/g, '');
    if (raw && !FSSAI_PATTERN.test(raw)) {
        const error = new Error('FSSAI licence number must be exactly 14 digits.');
        error.statusCode = 400;
        error.code = 'INVALID_FSSAI_NUMBER';
        throw error;
    }
    const business = await loadBusiness();
    const next = { ...business, fssai_license_number: raw || null };
    await query(
        `INSERT INTO store_settings (setting_key, setting_value, description)
         VALUES ($1, $2::jsonb, 'Business details (FSSAI licence)')
         ON CONFLICT (setting_key)
         DO UPDATE SET setting_value = EXCLUDED.setting_value, updated_at = NOW()`,
        [KEY, JSON.stringify(next)]
    );
    return { fssaiLicenseNumber: next.fssai_license_number };
}
