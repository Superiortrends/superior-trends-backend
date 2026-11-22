import type { Payment } from '@prisma/client';
import { prisma } from '../config/db.js';
import logger from '../config/logger.js';
import { restoreOrderStock } from '../controllers/order.controller.js';
import { ORDER_STATUS } from '../constants/orderStatus.js';
import { emitOrderUpdated } from '../socket/socket.js';
import { thawaniRequest } from './thawani.service.js';

/** Unpaid online orders older than this are cleaned up by the background sweep. */
export const UNPAID_ORDER_TTL_MINUTES = 30;

export type SettleResult = 'paid' | 'cancelled' | 'pending' | 'mismatch' | 'skipped' | 'error';

/** Best-effort: close the Thawani checkout session so it can't be paid after we cancelled the order. */
async function closeThawaniSession(sessionId: string): Promise<void> {
  try {
    await thawaniRequest('POST', `/checkout/session/${sessionId}/cancel`);
  } catch (error) {
    logger.warn(`Could not close Thawani session ${sessionId}: ${(error as Error).message}`);
  }
}

/** Marks the order paid (idempotent) and clears the customer's cart. */
async function finalizePaid(payment: Payment, sessionData: unknown): Promise<void> {
  const order = await prisma.$transaction(async (tx) => {
    await tx.payment.update({
      where: { id: payment.id },
      data: { paymentStatus: 'SUCCESS', transactionData: sessionData as object },
    });
    const existing = await tx.order.findUnique({ where: { id: payment.orderId } });
    const cancelledEarlier = existing?.orderStatus === ORDER_STATUS.CANCELLED;
    return tx.order.update({
      where: { id: payment.orderId },
      data: cancelledEarlier
        ? {
            // Paid AFTER we had cancelled it: keep it cancelled (stock was released) but make the
            // payment visible so the admin can refund it.
            paymentStatus: 'SUCCESS',
            notes: `${existing?.notes ? existing.notes + ' | ' : ''}PAID AFTER CANCELLATION — refund or re-confirm manually`,
          }
        : { paymentStatus: 'SUCCESS', orderStatus: ORDER_STATUS.PENDING },
      include: { items: true, payments: true, user: { select: { id: true, name: true, email: true, phone: true } } },
    });
  });

  if (order.userId) {
    const cart = await prisma.cart.findFirst({ where: { userId: order.userId } });
    if (cart) {
      await prisma.cartItem.deleteMany({ where: { cartId: cart.id } });
      await prisma.cart.update({
        where: { id: cart.id },
        data: { subtotal: 0, discount: 0, shipping: 0, tax: 0, total: 0 },
      });
    }
  }
  emitOrderUpdated(order as never);
  logger.info(`Order ${order.orderNumber} confirmed as paid`);
}

/** Cancels an order that was never paid and puts its stock back. Never touches a paid order. */
export async function cancelUnpaidOrder(orderId: string, reason: string): Promise<boolean> {
  const cancelled = await prisma.$transaction(async (tx) => {
    const order = await tx.order.findUnique({ where: { id: orderId } });
    if (!order) return null;
    // Guard inside the transaction: only PENDING + unpaid orders can be auto-cancelled
    if (order.orderStatus !== ORDER_STATUS.PENDING || order.paymentStatus !== 'PENDING') return null;

    await restoreOrderStock(tx, orderId);
    await tx.payment.updateMany({
      where: { orderId, paymentStatus: 'PENDING' },
      data: { paymentStatus: 'CANCELLED' },
    });
    return tx.order.update({
      where: { id: orderId },
      data: { orderStatus: ORDER_STATUS.CANCELLED },
      include: { items: true, payments: true, user: { select: { id: true, name: true, email: true, phone: true } } },
    });
  });

  if (!cancelled) return false;
  emitOrderUpdated(cancelled as never);
  logger.info(`Unpaid order ${cancelled.orderNumber} cancelled (${reason}); stock restored`);
  return true;
}

/**
 * Looks at the real state of a Thawani checkout session and updates our records:
 *  - paid        → order marked paid
 *  - cancelled / expired (or `forceCancel` for an unpaid session) → order cancelled, stock restored
 *  - unpaid      → left alone
 * Thawani's API is the source of truth — webhook bodies and browser redirects are never trusted.
 */
export async function settleThawaniSession(
  payment: Payment,
  opts: { cancelIfUnpaid?: boolean; reason?: string } = {},
): Promise<SettleResult> {
  if (!payment.thawaniSessionId) {
    // The order was created but no payment session ever existed → nothing can ever pay it.
    if (opts.cancelIfUnpaid && (await cancelUnpaidOrder(payment.orderId, opts.reason ?? 'no payment session'))) return 'cancelled';
    return 'skipped';
  }

  try {
    const { data } = await thawaniRequest<{ data: { payment_status?: string; total_amount?: number } }>(
      'GET',
      `/checkout/session/${payment.thawaniSessionId}`,
    );

    if (data?.payment_status === 'paid') {
      const expectedBaisa = Math.round(Number(payment.amount) * 1000);
      const paidBaisa = Number(data.total_amount);
      if (Number.isFinite(paidBaisa) && paidBaisa !== expectedBaisa) {
        logger.error(`Amount mismatch for payment ${payment.id} (expected ${expectedBaisa}, got ${paidBaisa}) — NOT marking paid`);
        return 'mismatch';
      }
      if (payment.paymentStatus !== 'SUCCESS') await finalizePaid(payment, data);
      return 'paid';
    }

    if (data?.payment_status === 'cancelled' || data?.payment_status === 'expired' || opts.cancelIfUnpaid) {
      await closeThawaniSession(payment.thawaniSessionId);
      // Re-check once more after closing: if the customer paid in the meantime, honour it.
      const recheck = await thawaniRequest<{ data: { payment_status?: string } }>(
        'GET',
        `/checkout/session/${payment.thawaniSessionId}`,
      ).catch(() => null);
      if (recheck?.data?.payment_status === 'paid') {
        if (payment.paymentStatus !== 'SUCCESS') await finalizePaid(payment, recheck.data);
        return 'paid';
      }
      return (await cancelUnpaidOrder(payment.orderId, opts.reason ?? `session ${data?.payment_status ?? 'unpaid'}`)) ? 'cancelled' : 'skipped';
    }

    return 'pending';
  } catch (error) {
    logger.warn(`settleThawaniSession(${payment.id}) failed: ${(error as Error).message}`);
    return 'error';
  }
}

let sweeping = false;

/** Background job: resolve online orders whose payment was never completed. */
export async function sweepUnpaidOnlineOrders(): Promise<{ checked: number; cancelled: number; paid: number }> {
  if (sweeping) return { checked: 0, cancelled: 0, paid: 0 };
  sweeping = true;
  const summary = { checked: 0, cancelled: 0, paid: 0 };
  try {
    const cutoff = new Date(Date.now() - UNPAID_ORDER_TTL_MINUTES * 60_000);
    const stale = await prisma.order.findMany({
      where: {
        orderStatus: ORDER_STATUS.PENDING,
        paymentStatus: 'PENDING',
        placedAt: { lt: cutoff },
        payments: { some: { paymentMethod: 'THAWANI' } },
        NOT: { payments: { some: { paymentMethod: 'COD' } } },
      },
      include: { payments: { where: { paymentMethod: 'THAWANI' }, orderBy: { createdAt: 'desc' }, take: 1 } },
      take: 100,
      orderBy: { placedAt: 'asc' },
    });

    for (const order of stale) {
      const payment = order.payments[0];
      summary.checked++;
      if (!payment) continue;
      // Saved-card flow uses payment intents, which we can't safely auto-resolve here — leave for the admin.
      if (payment.thawaniPaymentId) continue;
      const result = await settleThawaniSession(payment, { cancelIfUnpaid: true, reason: 'payment not completed in time' });
      if (result === 'cancelled') summary.cancelled++;
      if (result === 'paid') summary.paid++;
    }
  } catch (error) {
    logger.error(`sweepUnpaidOnlineOrders failed: ${(error as Error).message}`);
  } finally {
    sweeping = false;
  }
  return summary;
}
