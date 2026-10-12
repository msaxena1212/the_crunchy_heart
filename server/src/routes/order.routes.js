import { Router } from 'express';

import {
    createCheckoutOrder,
} from '../controllers/order.controller.js';


const router = Router();


router.post(
    '/create',
    createCheckoutOrder
);


export default router;