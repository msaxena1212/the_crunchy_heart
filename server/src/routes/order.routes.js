import { Router } from 'express';

import {
    createCheckoutOrder,
    retryOrderPayment,
    cancelOrderByGuest,
    getOrderDetails,
    requestOrderRecoveryController,
    verifyOrderRecoveryController,
} from '../controllers/order.controller.js';


const router = Router();


router.post(
    '/create',
    createCheckoutOrder
);

router.post(
    '/recovery/request',
    requestOrderRecoveryController
);

router.post(
    '/recovery/verify',
    verifyOrderRecoveryController
);

router.get(
    '/:orderNumber',
    getOrderDetails
);

router.post(
    '/:orderNumber/cancel',
    cancelOrderByGuest
);

router.post(
    '/:orderNumber/retry-payment',
    retryOrderPayment
);


export default router;