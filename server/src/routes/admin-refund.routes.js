import { Router } from 'express';
import {
    listRefunds,
    getRefund,
    approveRefund,
    reconcileRefund,
    listQueue,
    retryQueueItem,
    listIncidents,
    resolveIncident,
    getAuditHistory,
    getWorkerHealth,
    lateReconcileRefund,
} from '../controllers/admin-refund.controller.js';

/*
 * Mounted AFTER requireAdminAuth in admin.routes.js, so every route here is
 * authenticated. Owner-only actions are also enforced in the service layer.
 */
const router = Router();

// Defence in depth: refuse anything without an authenticated identity.
router.use((req, res, next) => {
    if (!req.admin?.id) {
        return res.status(401).json({ success: false, code: 'UNAUTHENTICATED', message: 'Authentication required.' });
    }
    return next();
});

router.get('/refunds', listRefunds);
router.get('/refunds/:refundId', getRefund);
router.post('/refunds/:refundId/approve', approveRefund);
router.post('/refunds/:refundId/reconcile', reconcileRefund);
router.post('/refunds/:refundId/late-reconcile', lateReconcileRefund);

router.get('/reconciliation/queue', listQueue);
router.post('/reconciliation/queue/:queueId/retry', retryQueueItem);

router.get('/reconciliation/incidents', listIncidents);
router.post('/reconciliation/incidents/:incidentId/resolve', resolveIncident);

router.get('/audit/:entityType/:entityId', getAuditHistory);

router.get('/workers/health', getWorkerHealth);

export default router;
