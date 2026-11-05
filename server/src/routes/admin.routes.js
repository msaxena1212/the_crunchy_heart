import { Router } from 'express';
import adminRefundRouter from './admin-refund.routes.js';
import adminPaymentAttemptsRouter from './admin-payment-attempts.routes.js';
import adminModulesRouter from './admin-modules.routes.js';
import { requireAdminAuth } from '../middleware/admin-auth.js';
import {
    loginAdmin,
    logoutAdmin,
    getMeAdmin,
    getOrdersAdmin,
    getOrderAdmin,
    dispatchOrderAdmin,
    getPendingRefundsAdmin,
} from '../controllers/admin.controller.js';

const router = Router();

// Public login endpoint (protected by rate limiting and generic error responses)
router.post('/auth/login', loginAdmin);

// All subsequent routes require authenticated ADMIN role
router.use(requireAdminAuth);

router.post('/auth/logout', logoutAdmin);
router.get('/auth/me', getMeAdmin);

// Order management
router.get('/orders', getOrdersAdmin);
router.get('/orders/:orderNumber', getOrderAdmin);
router.post('/orders/:orderNumber/dispatch', dispatchOrderAdmin);

// Refund exception reviews (read-only)
router.get('/refunds/pending', getPendingRefundsAdmin);

// Refund approval, reconciliation queue, incidents and audit history
router.use(adminRefundRouter);

// Operator resolution of unresolved payment attempts (lookup, verified reconcile, attested close)
router.use(adminPaymentAttemptsRouter);

// Dashboard, catalogue, inventory, coupons, customers, integrations, and social drafts
router.use(adminModulesRouter);

export default router;
