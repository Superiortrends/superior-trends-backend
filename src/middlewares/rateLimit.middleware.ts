import { Request, Response, NextFunction } from 'express';
import { AppError } from './error.middleware.js';

/**
 * Tiny in-memory fixed-window rate limiter (per client IP) for public write endpoints.
 * Good enough for a single instance; swap for a shared store (e.g. Redis) if the API is scaled out.
 */
export const rateLimit = ({ windowMs, max }: { windowMs: number; max: number }) => {
  const hits = new Map<string, { count: number; resetAt: number }>();

  // Drop expired entries so the map can't grow forever
  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) {
      if (entry.resetAt <= now) hits.delete(key);
    }
  }, windowMs).unref();

  return (req: Request, _res: Response, next: NextFunction): void => {
    const key = req.ip || 'unknown';
    const now = Date.now();
    const entry = hits.get(key);

    if (!entry || entry.resetAt <= now) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }

    entry.count += 1;
    if (entry.count > max) {
      return next(new AppError('Too many requests. Please try again later.', 429));
    }
    next();
  };
};
