import { Router } from 'express';
import {
    listReview,
    listOrders,
    lookupAttempt,
    reconcileOneAttempt,
    closeAttempt,
} from '../controllers/admin-payment-attempts.controller.js';

/*
 * Mounted AFTER requireAdminAuth in admin.routes.js, so every route here is authenticated.
 * The services also check for an active ADMIN, so the check does not depend on the router.
 */
const router = Router();

router.use((req, res, next) => {
    if (!req.admin?.id) {
        return res.status(401).json({ success: false, code: 'UNAUTHENTICATED', message: 'Authentication required.' });
    }
    return next();
});

router.get('/payment-attempts/review', listReview);
router.get('/payment-attempts/orders', listOrders);
router.post('/payment-attempts/:paymentId/lookup', lookupAttempt);
router.post('/payment-attempts/:paymentId/reconcile', reconcileOneAttempt);
router.post('/payment-attempts/:paymentId/close-not-submitted', closeAttempt);

export default router;
