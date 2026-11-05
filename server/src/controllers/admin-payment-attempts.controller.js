import {
    listAttemptsForReview,
    listOrderPaymentStates,
    resolveAttemptByLookup,
    reconcileAttempt,
    closeAttemptNotSubmitted,
} from '../services/payment-attempt-admin.service.js';

// Identity comes from the authenticated session (req.admin), never from the request body.
const actorOf = req => req.admin;

export async function listReview(req, res, next) {
    try {
        return res.json({ success: true, ...(await listAttemptsForReview({ actor: actorOf(req), limit: req.query?.limit })) });
    } catch (error) {
        next(error);
    }
}

export async function listOrders(req, res, next) {
    try {
        return res.json({
            success: true,
            ...(await listOrderPaymentStates({ actor: actorOf(req), state: req.query?.state, limit: req.query?.limit })),
        });
    } catch (error) {
        next(error);
    }
}

export async function lookupAttempt(req, res, next) {
    try {
        const result = await resolveAttemptByLookup({ actor: actorOf(req), paymentId: req.params.paymentId });
        return res.json({ success: true, ...result });
    } catch (error) {
        next(error);
    }
}

export async function reconcileOneAttempt(req, res, next) {
    try {
        const result = await reconcileAttempt({ actor: actorOf(req), paymentId: req.params.paymentId });
        return res.json({ success: true, ...result });
    } catch (error) {
        next(error);
    }
}

export async function closeAttempt(req, res, next) {
    try {
        const result = await closeAttemptNotSubmitted({
            actor: actorOf(req),
            paymentId: req.params.paymentId,
            confirmation: req.body?.confirmation,
            note: req.body?.note,
        });
        return res.json({ success: true, ...result });
    } catch (error) {
        next(error);
    }
}
