import { Router } from 'express';
import {
    requestOtpController,
    verifyOtpController,
    getMeController,
    logoutController
} from '../controllers/customer-auth.controller.js';

const router = Router();

router.post('/otp/request', requestOtpController);
router.post('/otp/verify', verifyOtpController);
router.get('/me', getMeController);
router.post('/logout', logoutController);

export default router;
