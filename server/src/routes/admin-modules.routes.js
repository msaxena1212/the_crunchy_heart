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
    postCoupon,
    putCoupon,
    getCustomers,
    getIntegrations,
    getBusinessSettingsCtl,
    putBusinessSettings,
    getSocialDrafts,
    postSocialDraft,
    putSocialDraft,
    postPublishSocialDraft,
    getExportCatalogueCsv,
    postImportCatalogueCsv,
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
router.get('/catalogue/export', getExportCatalogueCsv);
router.post('/catalogue/import', postImportCatalogueCsv);
router.get('/catalogue/products', getProducts);
router.get('/catalogue/products/:productId', getProduct);
router.put('/catalogue/products/:productId', putProduct);
router.put('/catalogue/products/:productId/rate-per-kg', putProductRatePerKg);
router.put('/catalogue/variants/:variantId', putVariant);
router.get('/catalogue/inventory', getInventory);
router.get('/catalogue/coupons', getCoupons);
router.post('/catalogue/coupons', postCoupon);
router.put('/catalogue/coupons/:couponId', putCoupon);
router.get('/customers', getCustomers);
router.get('/integrations', getIntegrations);
router.get('/settings/business', getBusinessSettingsCtl);
router.put('/settings/business', putBusinessSettings);

router.get('/social/drafts', getSocialDrafts);
router.post('/social/drafts', postSocialDraft);
router.put('/social/drafts/:draftId', putSocialDraft);
router.post('/social/drafts/:draftId/publish', postPublishSocialDraft);

export default router;
