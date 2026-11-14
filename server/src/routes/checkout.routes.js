import {
    Router
} from 'express';

import {
    previewCheckout,
    createHoldController,
    releaseHoldController
} from '../controllers/checkout.controller.js';

const router =
    Router();

router.post(
    '/preview',
    previewCheckout
);

router.post(
    '/hold',
    createHoldController
);

router.post(
    '/hold/release',
    releaseHoldController
);

export default router;