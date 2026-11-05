import nodemailer from 'nodemailer';
import { redactErrorText } from './ops-alert.service.js';

/*
|--------------------------------------------------------------------------
| Email delivery for operational alerts (SMTP via nodemailer)
|--------------------------------------------------------------------------
| An email adapter for the existing database-backed alert lifecycle. It never
| changes refund state. It reports success only after the transport accepts the
| message. Failures throw, and deliverOperationalAlerts() records them with the
| existing retry and undeliverable policy.
|
| Configuration comes from environment variables or the deployment secret
| manager. Secret values are never returned, logged, or included in messages.
|--------------------------------------------------------------------------
*/

export const EMAIL_PROVIDER_SMTP = 'smtp';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Only these payload fields are used to build a message.
const ALLOWED_PAYLOAD_FIELDS = ['refundId', 'orderId', 'status', 'ageMinutes', 'attemptCount', 'maxAttempts', 'lastError'];

function parseRecipients(raw) {
    return String(raw || '')
        .split(',')
        .map(v => v.trim())
        .filter(Boolean);
}

/*
 * Reads and validates non-secret configuration. Returns the missing field names
 * and never the values of secret fields.
 */
export function readEmailConfig(env = process.env) {
    const provider = (env.OPS_ALERT_EMAIL_PROVIDER || EMAIL_PROVIDER_SMTP).toLowerCase();
    const from = (env.OPS_ALERT_EMAIL_FROM || '').trim();
    const to = parseRecipients(env.OPS_ALERT_EMAIL_TO);
    const missing = [];
    const invalid = [];

    if (provider !== EMAIL_PROVIDER_SMTP) {
        invalid.push('OPS_ALERT_EMAIL_PROVIDER');
    }

    if (!from) missing.push('OPS_ALERT_EMAIL_FROM');
    else if (!EMAIL_PATTERN.test(from)) invalid.push('OPS_ALERT_EMAIL_FROM');

    if (!to.length) missing.push('OPS_ALERT_EMAIL_TO');
    else if (to.some(addr => !EMAIL_PATTERN.test(addr))) invalid.push('OPS_ALERT_EMAIL_TO');

    const host = (env.SMTP_HOST || '').trim();
    const port = Number(env.SMTP_PORT || 587);
    if (!host) missing.push('SMTP_HOST');
    if (!Number.isInteger(port) || port <= 0 || port > 65535) invalid.push('SMTP_PORT');

    // SMTP_USER and SMTP_PASSWORD are optional: only needed when the server requires login.
    const user = env.SMTP_USER || '';
    const pass = env.SMTP_PASSWORD || '';

    return {
        configured: missing.length === 0 && invalid.length === 0,
        provider,
        missing,
        invalid,
        from,
        to,
        smtp: { host, port, secure: port === 465, auth: user ? { user, pass } : undefined },
    };
}

/*
 * Builds the message from allowlisted fields only. Error text is redacted again
 * here, so nothing sensitive reaches an inbox even if it reached the database.
 */
export function buildAlertEmail(alert, config) {
    const payload = alert.payload || {};
    const safe = Object.fromEntries(
        ALLOWED_PAYLOAD_FIELDS.filter(k => payload[k] !== undefined).map(k => [k, payload[k]])
    );

    const lines = [
        `Alert: ${alert.alert_type}`,
        `Severity: ${alert.severity}`,
        `Refund ID: ${safe.refundId ?? alert.entity_id}`,
        `Order ID: ${safe.orderId ?? '-'}`,
        `Status: ${safe.status ?? '-'}`,
        `Age (minutes): ${safe.ageMinutes ?? '-'}`,
        `Attempts: ${safe.attemptCount ?? '-'} of ${safe.maxAttempts ?? '-'}`,
        `Last error: ${safe.lastError ? redactErrorText(safe.lastError) : '-'}`,
        '',
        'No refund has been submitted or changed by this alert.',
        'Review the refund in the admin console before taking any action.',
    ];

    return {
        from: config.from,
        to: config.to.join(', '),
        subject: `[${String(alert.severity).toUpperCase()}] ${alert.alert_type} — refund ${safe.refundId ?? alert.entity_id}`,
        text: lines.join('\n'),
    };
}

export function createSmtpTransport(config) {
    return nodemailer.createTransport({
        host: config.smtp.host,
        port: config.smtp.port,
        secure: config.smtp.secure,
        auth: config.smtp.auth,
        connectionTimeout: 15000,
        greetingTimeout: 15000,
        socketTimeout: 20000,
    });
}

/*
 * Returns an alert sender for deliverOperationalAlerts(). The transport is
 * injectable so tests never send real mail.
 */
export function createEmailAlertSender({ config = readEmailConfig(), transport } = {}) {
    return async function sendAlertEmail(alert) {
        if (!config.configured) {
            const detail = [...config.missing, ...config.invalid.map(k => `${k} (invalid)`)].join(', ');
            throw Object.assign(new Error(`Email alerting is not configured: ${detail}`), { code: 'EMAIL_NOT_CONFIGURED' });
        }

        const mailTransport = transport ?? createSmtpTransport(config);
        const message = buildAlertEmail(alert, config);

        let info;
        try {
            info = await mailTransport.sendMail(message);
        } catch (error) {
            // Keep the transport code for observability. Never include the raw error text.
            throw Object.assign(new Error(`Email transport failed (${error.code || 'UNKNOWN'})`), {
                code: 'EMAIL_TRANSPORT_FAILED',
                transportCode: error.code || null,
            });
        }

        // Accepted means the transport took responsibility for at least one recipient.
        if (!info?.accepted?.length) {
            throw Object.assign(new Error('Email was not accepted for any recipient.'), { code: 'EMAIL_NOT_ACCEPTED' });
        }

        return { accepted: info.accepted.length };
    };
}

/*
 * Safe status for health output. Never includes credentials or raw addresses.
 */
export function emailHealth(config = readEmailConfig()) {
    return {
        configured: config.configured,
        provider: config.provider,
        missing: config.missing,
        invalid: config.invalid,
    };
}
