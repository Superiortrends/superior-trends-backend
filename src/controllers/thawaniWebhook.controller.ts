import crypto from 'node:crypto';
import { Request, Response } from 'express';
import { prisma } from '../config/db.js';
import { env } from '../config/env.js';
import logger from '../config/logger.js';
import { settleThawaniSession } from '../services/orderPayment.service.js';

/** Max accepted clock difference between Thawani's timestamp and ours (replay protection). */
const MAX_SKEW_SECONDS = 10 * 60;

/**
 * Thawani signs every webhook with HMAC-SHA256 over "{raw body}-{thawani-timestamp}"
 * using the webhook secret from the merchant portal; the hex digest is sent in the
 * `thawani-signature` header.
 */
const isValidSignature = (rawBody: Buffer, signature: string, timestamp: string): boolean => {
  const secret = env.THAWANI_WEBHOOK_SECRET;
  if (!secret || !signature || !timestamp) return false;

  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${rawBody.toString('utf8')}-${timestamp}`)
    .digest('hex');

  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature.trim().toLowerCase(), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

const isFreshTimestamp = (timestamp: string): boolean => {
  if (!/^\d+$/.test(timestamp)) return false;
  let ts = Number(timestamp);
  if (ts > 1e12) ts = Math.floor(ts / 1000); // tolerate milliseconds
  return Math.abs(Math.floor(Date.now() / 1000) - ts) <= MAX_SKEW_SECONDS;
};

const asString = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);

/** Events that can mean "money received". Everything else (checkout.created, payment.pending, payment.failed…) is acknowledged and ignored. */
const HANDLED_EVENTS = new Set(['checkout.completed', 'payment.succeeded']);

/**
 * Per Thawani's docs the body is `{ event_type, data }`:
 *  - checkout.*  → data.session_id, data.client_reference_id (= our order id), data.invoice
 *  - payment.*   → data.payment_id, data.checkout_invoice (= the invoice stored on our Payment row)
 * The payload is NOT trusted for payment status — we only pull identifiers from it and then
 * ask Thawani's API for the real session state.
 */
const extractIdentifiers = (payload: any) => {
  const d = payload?.data ?? {};
  return {
    sessionId: asString(d.session_id),
    clientReferenceId: asString(d.client_reference_id),
    invoice: asString(d.invoice) ?? asString(d.checkout_invoice),
  };
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /api/v1/payment/thawani/webhook
 * Mounted BEFORE express.json() with express.raw() — the signature is computed over the raw bytes.
 * Public endpoint: authenticity comes from the HMAC signature, not from a login.
 */
export const thawaniWebhook = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!env.THAWANI_WEBHOOK_SECRET) {
      logger.error('Thawani webhook received but THAWANI_WEBHOOK_SECRET is not configured');
      res.status(503).json({ status: 'error', message: 'Webhook not configured' });
      return;
    }

    const rawBody = req.body as Buffer;
    if (!Buffer.isBuffer(rawBody) || rawBody.length === 0) {
      res.status(400).json({ status: 'error', message: 'Empty body' });
      return;
    }

    const signature = String(req.header('thawani-signature') ?? '');
    const timestamp = String(req.header('thawani-timestamp') ?? '');

    if (!isValidSignature(rawBody, signature, timestamp)) {
      logger.warn('Thawani webhook rejected: invalid signature');
      res.status(401).json({ status: 'error', message: 'invalid_signature' });
      return;
    }
    if (!isFreshTimestamp(timestamp)) {
      logger.warn('Thawani webhook rejected: stale or malformed timestamp');
      res.status(401).json({ status: 'error', message: 'stale_timestamp' });
      return;
    }

    let payload: any;
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch {
      res.status(400).json({ status: 'error', message: 'Invalid JSON' });
      return;
    }

    const eventType = asString(payload?.event_type);
    if (!eventType || !HANDLED_EVENTS.has(eventType)) {
      res.status(200).json({ status: 'ok', message: 'event_ignored' });
      return;
    }

    const { sessionId, clientReferenceId, invoice } = extractIdentifiers(payload);

    // Find our payment record by session id, then by order id (client_reference_id), then by invoice.
    let payment = sessionId
      ? await prisma.payment.findFirst({
          where: { paymentMethod: 'THAWANI', thawaniSessionId: sessionId },
          orderBy: { createdAt: 'desc' },
        })
      : null;

    if (!payment && clientReferenceId && UUID_RE.test(clientReferenceId)) {
      payment = await prisma.payment.findFirst({
        where: { paymentMethod: 'THAWANI', orderId: clientReferenceId },
        orderBy: { createdAt: 'desc' },
      });
    }

    if (!payment && invoice) {
      payment = await prisma.payment.findFirst({
        where: { paymentMethod: 'THAWANI', thawaniInvoice: invoice },
        orderBy: { createdAt: 'desc' },
      });
    }

    if (!payment || !payment.thawaniSessionId) {
      // Acknowledge so Thawani doesn't retry forever for events that aren't ours.
      logger.warn('Thawani webhook: no matching payment record (acknowledged)');
      res.status(200).json({ status: 'ok', message: 'ignored' });
      return;
    }

    // Already settled — idempotent no-op.
    if (payment.paymentStatus === 'SUCCESS') {
      res.status(200).json({ status: 'ok', message: 'already_processed' });
      return;
    }

    // Source of truth: settle against Thawani's API (never the webhook body). Marks paid, or ignores an unpaid session.
    const result = await settleThawaniSession(payment);
    if (result === 'error') {
      // Thawani API hiccup → 500 so Thawani retries the webhook later
      res.status(500).json({ status: 'error', message: 'Webhook processing failed' });
      return;
    }
    if (result === 'mismatch') {
      res.status(200).json({ status: 'ok', message: 'amount_mismatch' });
      return;
    }

    res.status(200).json({ status: 'ok' });
  } catch (error) {
    // 500 lets Thawani retry; never leak internals in the response.
    logger.error(`Thawani webhook error: ${(error as Error).message}`);
    res.status(500).json({ status: 'error', message: 'Webhook processing failed' });
  }
};
