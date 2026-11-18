import express from 'express';
import {
    requestOtpController,
    verifyOtpController,
    getSessionController,
    neonAuthWebhookController,
} from '../controllers/auth.controller.js';
import { authenticateCustomer } from '../utils/customer-token.js';

const router = express.Router();

router.post('/otp/send', requestOtpController);
router.post('/otp/verify', verifyOtpController);
router.get('/session', authenticateCustomer, getSessionController);
router.get('/me', authenticateCustomer, getSessionController);
router.post('/neon/webhook', neonAuthWebhookController);

export default router;
