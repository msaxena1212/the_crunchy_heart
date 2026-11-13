import {
    dashboardSummary,
    listProducts,
    listInventory,
    listCoupons,
    listCustomers,
    integrationsStatus,
    listSocialDrafts,
    createSocialDraft,
    updateSocialDraft,
    publishSocialDraft,
} from '../services/admin-modules.service.js';
import {
    getAdminProduct,
    updateAdminProduct,
    updateAdminVariant,
    setAdminProductRatePerKg,
} from '../services/admin-catalogue.service.js';

// Identity comes from the authenticated session (req.admin), never from the request body.
const actorOf = req => req.admin;

const handler = fn => async (req, res, next) => {
    try {
        return res.json({ success: true, ...(await fn(req)) });
    } catch (error) {
        next(error);
    }
};

export const getDashboard = handler(req => dashboardSummary({ actor: actorOf(req) }));
export const getProducts = handler(req => listProducts({ actor: actorOf(req), search: req.query?.search, limit: req.query?.limit, category: req.query?.category }));
export const getProduct = handler(req => getAdminProduct({ actor: actorOf(req), productId: req.params.productId }));
export const putProduct = handler(req => updateAdminProduct({ actor: actorOf(req), productId: req.params.productId, input: req.body || {} }));
export const putProductRatePerKg = handler(req => setAdminProductRatePerKg({ actor: actorOf(req), productId: req.params.productId, ratePerKg: req.body?.ratePerKg }));
export const putVariant = handler(req => updateAdminVariant({ actor: actorOf(req), variantId: req.params.variantId, input: req.body || {} }));
export const getInventory = handler(req => listInventory({ actor: actorOf(req), lowStockOnly: req.query?.lowStock === 'true', limit: req.query?.limit }));
export const getCoupons = handler(req => listCoupons({ actor: actorOf(req), limit: req.query?.limit }));
export const getCustomers = handler(req => listCustomers({ actor: actorOf(req), search: req.query?.search, limit: req.query?.limit }));
export const getIntegrations = handler(req => integrationsStatus({ actor: actorOf(req) }));
export const getSocialDrafts = handler(req => listSocialDrafts({ actor: actorOf(req), platform: req.query?.platform }));
export const postSocialDraft = handler(req => createSocialDraft({ actor: actorOf(req), input: req.body || {} }));
export const putSocialDraft = handler(req => updateSocialDraft({ actor: actorOf(req), draftId: req.params.draftId, input: req.body || {} }));
export const postPublishSocialDraft = handler(req => publishSocialDraft({ actor: actorOf(req), draftId: req.params.draftId }));
