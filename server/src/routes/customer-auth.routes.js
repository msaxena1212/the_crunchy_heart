import { Router } from 'express';
import {
    requestOtpController,
    verifyOtpController,
    getMeController,
    getOrdersController,
    updateProfileController,
    logoutController,
    cancelOrderController
} from '../controllers/customer-auth.controller.js';

const router = Router();

router.post('/otp/request', requestOtpController);
router.post('/otp/verify', verifyOtpController);
router.get('/me', getMeController);
router.get('/orders', getOrdersController);
router.put('/profile', updateProfileController);
router.post('/logout', logoutController);
router.post('/orders/:orderNumber/cancel', cancelOrderController);

export default router;
