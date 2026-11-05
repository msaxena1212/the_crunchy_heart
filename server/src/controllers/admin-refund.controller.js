import {
    listRefundsAdmin,
    getRefundAdmin,
    approveRefundAdmin,
    requestReconcileRefundAdmin,
    listQueueAdmin,
    retryQueueItemAdmin,
    listIncidentsAdmin,
    resolveIncidentAdmin,
    auditHistory,
    lateReconcileRefundAdmin,
} from '../services/admin-refund.service.js';

// Identity is taken from the authenticated session (req.admin), never the body.
const actorOf = req => req.admin;

export async function listRefunds(req, res, next) {
    try {
        return res.json({ success: true, ...(await listRefundsAdmin(req.query)) });
    } catch (error) {
        next(error);
    }
}

export async function getRefund(req, res, next) {
    try {
        return res.json({ success: true, ...(await getRefundAdmin(req.params.refundId)) });
    } catch (error) {
        next(error);
    }
}

export async function approveRefund(req, res, next) {
    try {
        const result = await approveRefundAdmin({ actor: actorOf(req), refundId: req.params.refundId });
        return res.json({ success: true, ...result });
    } catch (error) {
        next(error);
    }
}

export async function reconcileRefund(req, res, next) {
    try {
        const result = await requestReconcileRefundAdmin({ actor: actorOf(req), refundId: req.params.refundId });
        return res.json({ success: true, ...result });
    } catch (error) {
        next(error);
    }
}

export async function listQueue(req, res, next) {
    try {
        return res.json({ success: true, ...(await listQueueAdmin(req.query)) });
    } catch (error) {
        next(error);
    }
}

export async function retryQueueItem(req, res, next) {
    try {
        const result = await retryQueueItemAdmin({ actor: actorOf(req), queueId: req.params.queueId });
        return res.json({ success: true, ...result });
    } catch (error) {
        next(error);
    }
}

export async function listIncidents(req, res, next) {
    try {
        const resolved = req.query.resolved === 'true';
        return res.json({ success: true, ...(await listIncidentsAdmin({ ...req.query, resolved })) });
    } catch (error) {
        next(error);
    }
}

export async function resolveIncident(req, res, next) {
    try {
        const result = await resolveIncidentAdmin({
            actor: actorOf(req),
            incidentId: req.params.incidentId,
            note: req.body?.note,
        });
        return res.json({ success: true, ...result });
    } catch (error) {
        next(error);
    }
}

export async function getAuditHistory(req, res, next) {
    try {
        const { entityType, entityId } = req.params;
        const allowed = new Set(['refund', 'payment_reconciliation_queue', 'payment_reconciliation_incident']);
        if (!allowed.has(entityType)) {
            return res.status(400).json({ success: false, message: 'Unknown audit entity type.' });
        }
        return res.json({ success: true, items: await auditHistory(entityType, entityId) });
    } catch (error) {
        next(error);
    }
}

export async function lateReconcileRefund(req, res, next) {
    try {
        const result = await lateReconcileRefundAdmin({ actor: actorOf(req), refundId: req.params.refundId });
        return res.json({ success: true, ...result });
    } catch (error) {
        next(error);
    }
}

// Worker and alert health for operators. Read-only, no secrets.
export async function getWorkerHealth(req, res, next) {
    try {
        const { assertActiveAdmin } = await import('../services/admin-refund.service.js');
        const { workerHealth } = await import('../services/worker-registry.js');
        const { alertHealth } = await import('../services/ops-alert.service.js');
        await assertActiveAdmin(actorOf(req));
        return res.json({
            success: true,
            workers: workerHealth(),
            alerts: await alertHealth(),
        });
    } catch (error) {
        next(error);
    }
}
