import { Request, Response, NextFunction } from 'express';
import { prisma } from '../config/db.js';
import { AppError } from '../middlewares/error.middleware.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LENGTH = 254;

/** Public: POST /newsletter/subscribe */
export const subscribe = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const raw = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';

    if (!raw || raw.length > MAX_EMAIL_LENGTH || !EMAIL_RE.test(raw)) {
      return next(new AppError('Please provide a valid email address', 400));
    }

    // Idempotent: a repeat sign-up (or a re-subscribe) succeeds quietly, so the response
    // never reveals whether an address is already on the list.
    await prisma.newsletterSubscriber.upsert({
      where: { email: raw },
      update: { isActive: true },
      create: { email: raw },
    });

    res.status(200).json({
      status: 'success',
      message: 'Thank you for subscribing!',
    });
  } catch (error) {
    next(error);
  }
};

/** Admin: GET /newsletter/admin */
export const getSubscribers = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const subscribers = await prisma.newsletterSubscriber.findMany({
      orderBy: { createdAt: 'desc' },
      take: 10000,
    });

    res.status(200).json({
      status: 'success',
      results: subscribers.length,
      data: { subscribers },
    });
  } catch (error) {
    next(error);
  }
};

/** Admin: DELETE /newsletter/:id */
export const deleteSubscriber = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { id } = req.params;
    try {
      await prisma.newsletterSubscriber.delete({ where: { id } });
    } catch (err: any) {
      if (err?.code === 'P2025') return next(new AppError('Subscriber not found', 404));
      throw err;
    }

    res.status(200).json({ status: 'success', message: 'Subscriber removed' });
  } catch (error) {
    next(error);
  }
};
