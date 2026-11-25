import { Request, Response, NextFunction } from 'express';

export class AppError extends Error {
  statusCode: number;
  constructor(message: string, statusCode: number) {
    super(message);
    this.statusCode = statusCode;
    Error.captureStackTrace(this, this.constructor);
  }
}

export const errorHandler = (
  err: any,
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  const statusCode = err.statusCode || 500;

  // Never leak internals (Prisma / JS error text, stack) to clients on server errors.
  // Intentional AppErrors and 4xx client errors keep their message; real details go to the server log.
  const isDev = process.env.NODE_ENV === 'development';
  const safeToExpose = err instanceof AppError || statusCode < 500 || isDev;
  if (statusCode >= 500) console.error('[error]', req.method, req.originalUrl, err);
  const message = safeToExpose
    ? err.message || 'Internal Server Error'
    : 'Something went wrong. Please try again later.';

  res.status(statusCode).json({
    status: 'error',
    statusCode,
    message,
    stack: process.env.NODE_ENV === 'development' ? err.stack : undefined,
  });
};
