import { env } from '../config/env.js';
import { AppError } from '../middlewares/error.middleware.js';

export const getThawaniApiBaseUrl = (): string =>
  env.THAWANI_ENV === 'prod' ? 'https://checkout.thawani.om/api/v1' : 'https://uatcheckout.thawani.om/api/v1';

export const getThawaniCheckoutBaseUrl = (): string =>
  env.THAWANI_ENV === 'prod' ? 'https://checkout.thawani.om' : 'https://uatcheckout.thawani.om';

export async function thawaniRequest<T = any>(
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: Record<string, unknown>
): Promise<T> {
  const response = await fetch(`${getThawaniApiBaseUrl()}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'thawani-api-key': env.THAWANI_API_KEY,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const result = (await response.json()) as any;

  if (!response.ok || !result.success) {
    throw new AppError(result.description || result.message || 'Thawani API request failed', response.status >= 400 ? response.status : 400);
  }

  return result as T;
}
