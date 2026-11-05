/*
|--------------------------------------------------------------------------
| Explicit, one-time SMTP test email
|--------------------------------------------------------------------------
| Sends ONE non-sensitive test alert to an approved test mailbox. It never runs
| at startup, never runs in automated tests, and never touches the database or
| any refund. It is invoked by hand, with both confirmation values set:
|
|   OPS_ALERT_TEST_CONFIRM=SEND-ONE-TEST-EMAIL
|   OPS_ALERT_TEST_RECIPIENT=<the same single address as OPS_ALERT_EMAIL_TO>
|   OPS_ALERT_EMAIL_FROM, OPS_ALERT_EMAIL_TO, SMTP_HOST, SMTP_PORT
|   (plus SMTP_USER and SMTP_PASSWORD if the mail host requires login, from the
|    secret manager only)
|
|   node src/scripts/send-test-alert-email.mjs
|
| Output is limited to accepted and rejected counts. It never prints the host,
| user, password, or addresses.
|
| SMTP acceptance is not inbox delivery. Confirm receipt in the mailbox yourself.
|--------------------------------------------------------------------------
*/

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readEmailConfig, createEmailAlertSender } from '../services/ops-alert-email.service.js';

export const TEST_CONFIRM_PHRASE = 'SEND-ONE-TEST-EMAIL';

// Non-sensitive synthetic alert. It refers to no real refund or order.
export function buildTestAlert() {
    return {
        alert_type: 'OPS_EMAIL_TEST',
        severity: 'high',
        entity_type: 'test',
        entity_id: 'TEST-ONLY',
        payload: {
            refundId: 'TEST-ONLY',
            orderId: 'TEST-ONLY',
            status: 'test',
            ageMinutes: 0,
            attemptCount: 0,
            maxAttempts: 0,
            lastError: null,
        },
    };
}

/*
 * Guards, then sends exactly one message. The sender and transport are
 * injectable so this can be verified without a real mail server.
 */
export async function sendTestAlertEmail({ env = process.env, sender } = {}) {
    if (env.OPS_ALERT_TEST_CONFIRM !== TEST_CONFIRM_PHRASE) {
        throw new Error('ABORT: OPS_ALERT_TEST_CONFIRM is not set to the required phrase.');
    }

    const config = readEmailConfig(env);
    if (!config.configured) {
        throw new Error(`ABORT: email configuration incomplete (${[...config.missing, ...config.invalid].join(', ')}).`);
    }

    if (config.to.length !== 1) {
        throw new Error('ABORT: exactly one test recipient is required.');
    }

    if ((env.OPS_ALERT_TEST_RECIPIENT || '').trim().toLowerCase() !== config.to[0].toLowerCase()) {
        throw new Error('ABORT: OPS_ALERT_TEST_RECIPIENT must match OPS_ALERT_EMAIL_TO exactly.');
    }

    const send = sender ?? createEmailAlertSender({ config });
    const result = await send(buildTestAlert());
    return { accepted: result.accepted };
}

// Runs only when executed directly.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    sendTestAlertEmail()
        .then(result => {
            console.log(JSON.stringify({ sent: true, acceptedRecipients: result.accepted }));
        })
        .catch(error => {
            console.error(error.message);
            process.exitCode = 1;
        });
}
