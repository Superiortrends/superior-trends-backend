import { Router } from 'express';
import {
  createThawaniSession,
  verifyThawaniPayment,
} from '../controllers/payment.controller.js';
import { protect } from '../middlewares/auth.middleware.js';

const router = Router();

router.use(protect);

router.post('/thawani/create-session', createThawaniSession);
router.post('/thawani/verify', verifyThawaniPayment);

export default router;
