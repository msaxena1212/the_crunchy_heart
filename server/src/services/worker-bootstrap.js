import { startWorker, workerEnabled, stopAllWorkers } from './worker-registry.js';
import { runReconciliationSweep } from './payment-reconciliation-retry.service.js';
import { runRefundSweep } from './refund.service.js';
import { raiseRefundAlerts, deliverOperationalAlerts } from './ops-alert.service.js';
import { createEmailAlertSender, readEmailConfig } from './ops-alert-email.service.js';
import { expireOverdueHolds } from './inventory-hold.service.js';

export const DEFAULT_ALERT_INTERVAL_MS = 60 * 1000;
export const MIN_ALERT_INTERVAL_MS = 5 * 1000;
export const MAX_ALERT_INTERVAL_MS = 24 * 60 * 60 * 1000;

/*
 * Alert evaluation interval. Controls how often alerts are evaluated and
 * delivered, not a guaranteed delivery time. Invalid values stop startup.
 */
export function parseAlertIntervalMs(raw) {
    if (raw === undefined || raw === null || String(raw).trim() === '') {
        return DEFAULT_ALERT_INTERVAL_MS;
    }
    const value = Number(String(raw).trim());
    if (!Number.isInteger(value) || value < MIN_ALERT_INTERVAL_MS || value > MAX_ALERT_INTERVAL_MS) {
        throw new Error(
            `OPS_ALERTS_INTERVAL_MS must be an integer between ${MIN_ALERT_INTERVAL_MS} and ${MAX_ALERT_INTERVAL_MS} milliseconds.`
        );
    }
    return value;
}

/*
 * Starts every worker whose flag is explicitly enabled. Nothing starts by
 * default. Each run calls the same service functions the tests exercise.
 */
export function startConfiguredWorkers({ env = process.env, intervalMs } = {}) {
    const started = [];
    const interval = Number(intervalMs || env.WORKER_INTERVAL_MS || 60000);
    // Alerts use their own interval so changing it never changes provider lookup frequency.
    const alertInterval = intervalMs ? Number(intervalMs) : parseAlertIntervalMs(env.OPS_ALERTS_INTERVAL_MS);

    if (workerEnabled('reconciliation_sweep', env)) {
        startWorker({ name: 'reconciliation_sweep', intervalMs: interval, run: () => runReconciliationSweep({ limit: 10 }) });
        started.push('reconciliation_sweep');
    }

    if (workerEnabled('refund_sweep', env)) {
        // Provider is fail-closed by default. Automatic submission is only
        // possible once an adapter is explicitly wired in.
        startWorker({ name: 'refund_sweep', intervalMs: interval, run: () => runRefundSweep({ limit: 10 }) });
        started.push('refund_sweep');
    }

    if (workerEnabled('operational_alerts', env)) {
        const emailConfig = readEmailConfig(env);
        if (!emailConfig.configured) {
            // Alerts are still recorded and retried. Delivery stays unavailable until configured.
            console.error('[HIGH] Email alerting is not configured; alerts will be recorded but not delivered.', {
                missing: emailConfig.missing,
                invalid: emailConfig.invalid,
            });
        }
        const sender = createEmailAlertSender({ config: emailConfig });

        startWorker({
            name: 'operational_alerts',
            intervalMs: alertInterval,
            run: async () => {
                const raised = await raiseRefundAlerts();
                const delivered = await deliverOperationalAlerts({ sender });
                return { raised: raised.raised, delivered: delivered.delivered, failed: delivered.failed, skipped: delivered.skipped };
            },
        });
        started.push('operational_alerts');
    }

    if (workerEnabled('inventory_hold_expiry', env)) {
        startWorker({
            name: 'inventory_hold_expiry',
            intervalMs: 60 * 1000, // Sweep every 60 seconds
            run: async () => {
                return await expireOverdueHolds();
            }
        });
        started.push('inventory_hold_expiry');
    }

    return started;
}

export { stopAllWorkers };
