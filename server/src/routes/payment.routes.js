import { Router } from 'express';

import {
    getPaymentStatus,
} from '../controllers/payment.controller.js';


const router =
    Router();


/*
|--------------------------------------------------------------------------
| Payment Status
|--------------------------------------------------------------------------
|
| GET /api/payments/status/:orderId
|
|--------------------------------------------------------------------------
*/

router.get(
    '/status/:orderId',
    getPaymentStatus
);


export default router;