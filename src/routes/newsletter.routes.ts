import { Router } from 'express';
import { subscribe, getSubscribers, deleteSubscriber } from '../controllers/newsletter.controller.js';
import { protect, restrictTo } from '../middlewares/auth.middleware.js';
import { rateLimit } from '../middlewares/rateLimit.middleware.js';

const router = Router();

// Public — rate limited (5 sign-ups per 10 min per IP) so it can't be used to flood the list
router.post('/subscribe', rateLimit({ windowMs: 10 * 60 * 1000, max: 5 }), subscribe);

router.use(protect, restrictTo('ADMIN'));
router.get('/admin', getSubscribers);
router.delete('/:id', deleteSubscriber);

export default router;
