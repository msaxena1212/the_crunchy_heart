import {
    Router
} from 'express';

import {
    previewCheckout
} from '../controllers/checkout.controller.js';

const router =
    Router();

router.post(
    '/preview',
    previewCheckout
);

export default router;