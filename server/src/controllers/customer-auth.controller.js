import {
    sendCustomerOtp,
    verifyCustomerOtp,
    getSessionCustomer,
    logoutCustomer
} from '../services/customer-auth.service.js';

export async function requestOtpController(req, res, next) {
    try {
        const { phone, channel, purpose } = req.body;
        const result = await sendCustomerOtp({ phone, channel, purpose });
        return res.json(result);
    } catch (error) {
        return res.status(error.statusCode || 400).json({
            success: false,
            message: error.message
        });
    }
}

export async function verifyOtpController(req, res, next) {
    try {
        const { phone, otp } = req.body;
        const ipAddress = req.ip || req.connection.remoteAddress;
        const userAgent = req.headers['user-agent'] || '';

        const result = await verifyCustomerOtp({
            phone,
            otp,
            ipAddress,
            userAgent
        });

        return res.json(result);
    } catch (error) {
        return res.status(error.statusCode || 400).json({
            success: false,
            message: error.message
        });
    }
}

export async function getMeController(req, res, next) {
    try {
        const authHeader = req.headers.authorization || '';
        const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

        if (!token) {
            return res.status(401).json({ success: false, message: 'Unauthorized' });
        }

        const customer = await getSessionCustomer(token);
        if (!customer) {
            return res.status(401).json({ success: false, message: 'Session expired or invalid.' });
        }

        return res.json({ success: true, customer });
    } catch (error) {
        next(error);
    }
}

export async function logoutController(req, res, next) {
    try {
        const authHeader = req.headers.authorization || '';
        const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
        if (token) {
            await logoutCustomer(token);
        }
        return res.json({ success: true, message: 'Logged out successfully.' });
    } catch (error) {
        next(error);
    }
}
