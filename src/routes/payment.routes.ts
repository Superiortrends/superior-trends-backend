import { Router } from 'express';
import {
  createThawaniSession,
  verifyThawaniPayment,
  listSavedCards,
  deleteSavedCard,
  payWithSavedCard,
  verifyThawaniPaymentIntent,
  refundThawaniPayment,
} from '../controllers/payment.controller.js';
import { protect, restrictTo } from '../middlewares/auth.middleware.js';

const router = Router();

router.use(protect);

router.post('/thawani/create-session', createThawaniSession);
router.post('/thawani/verify', verifyThawaniPayment);

router.get('/thawani/saved-cards', listSavedCards);
router.delete('/thawani/saved-cards/:cardId', deleteSavedCard);
router.post('/thawani/pay-with-card', payWithSavedCard);
router.post('/thawani/verify-card-payment', verifyThawaniPaymentIntent);

router.post('/thawani/refund/:orderId', restrictTo('ADMIN'), refundThawaniPayment);

export default router;
