import { Router } from 'express';
import {
    getDashboard,
    getProducts,
    getProduct,
    putProduct,
    putProductRatePerKg,
    putVariant,
    getInventory,
    getCoupons,
    getCustomers,
    getIntegrations,
    getSocialDrafts,
    postSocialDraft,
    putSocialDraft,
    postPublishSocialDraft,
} from '../controllers/admin-modules.controller.js';

/*
 * Mounted AFTER requireAdminAuth in admin.routes.js, so every route here is authenticated.
 * The services also check for an active ADMIN account.
 */
const router = Router();

router.use((req, res, next) => {
    if (!req.admin?.id) {
        return res.status(401).json({ success: false, code: 'UNAUTHENTICATED', message: 'Authentication required.' });
    }
    return next();
});

router.get('/dashboard', getDashboard);
router.get('/catalogue/products', getProducts);
router.get('/catalogue/products/:productId', getProduct);
router.put('/catalogue/products/:productId', putProduct);
router.put('/catalogue/products/:productId/rate-per-kg', putProductRatePerKg);
router.put('/catalogue/variants/:variantId', putVariant);
router.get('/catalogue/inventory', getInventory);
router.get('/catalogue/coupons', getCoupons);
router.get('/customers', getCustomers);
router.get('/integrations', getIntegrations);

router.get('/social/drafts', getSocialDrafts);
router.post('/social/drafts', postSocialDraft);
router.put('/social/drafts/:draftId', putSocialDraft);
router.post('/social/drafts/:draftId/publish', postPublishSocialDraft);

export default router;
