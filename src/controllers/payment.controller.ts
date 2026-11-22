import { Request, Response, NextFunction } from 'express';
import { prisma } from '../config/db.js';
import { env } from '../config/env.js';
import { AppError } from '../middlewares/error.middleware.js';
import { getThawaniCheckoutBaseUrl, thawaniRequest } from '../services/thawani.service.js';
import { settleThawaniSession } from '../services/orderPayment.service.js';

/** Returns the user's saved Thawani customer_id, creating one via the Thawani API if it doesn't exist yet. */
const getOrCreateThawaniCustomer = async (userId: string, email: string): Promise<string> => {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (user?.thawaniCustomerId) {
    return user.thawaniCustomerId;
  }

  const result = await thawaniRequest<{ data: { id: string } }>('POST', '/customers', {
    client_customer_id: email || userId,
  });

  await prisma.user.update({
    where: { id: userId },
    data: { thawaniCustomerId: result.data.id },
  });

  return result.data.id;
};

export const createThawaniSession = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { orderId, saveCard } = req.body;

    if (!orderId) {
      return next(new AppError('Order ID is required', 400));
    }

    const order = await prisma.order.findUnique({
      where: { id: orderId },
    });

    if (!order) {
      return next(new AppError('Order not found', 404));
    }

    // Safety Check: Ensure the logged-in user owns this order
    const userId = (req as any).user?.id;
    if (order.userId !== userId) {
      return next(new AppError('Unauthorized: You do not own this order', 403));
    }

    if (!env.THAWANI_API_KEY || !env.THAWANI_PUBLISHABLE_KEY) {
      return next(new AppError('Thawani credentials are not configured on the server', 500));
    }

    const checkoutBaseUrl = getThawaniCheckoutBaseUrl();

    // Amount in baisas (1 OMR = 1000 baisa)
    const amountInBaisa = Math.round(Number(order.total) * 1000);

    const shipping = order.shippingAddress as any;
    const customerName = `${shipping?.firstName || ''} ${shipping?.lastName || ''}`.trim() || 'Customer';
    const customerEmail = shipping?.email || (req as any).user?.email || '';
    const customerPhone = shipping?.phone || '';

    // Dynamically fetch frontend origin from headers
    let frontendUrl = env.FRONTEND_URL;
    if (req.headers.origin) {
      frontendUrl = req.headers.origin;
    } else if (req.headers.referer) {
      try {
        const parsedUrl = new URL(req.headers.referer);
        frontendUrl = parsedUrl.origin;
      } catch (e) {
        // Fallback to env.FRONTEND_URL
      }
    }
    if (frontendUrl.endsWith('/')) {
      frontendUrl = frontendUrl.slice(0, -1);
    }

    let thawaniCustomerId: string | undefined;
    if (saveCard && userId) {
      thawaniCustomerId = await getOrCreateThawaniCustomer(userId, customerEmail);
    }

    const result = await thawaniRequest<{ data: { session_id: string; invoice: string } }>('POST', '/checkout/session', {
      client_reference_id: order.id,
      mode: 'payment',
      products: [
        {
          name: `Order #${order.orderNumber}`,
          unit_amount: amountInBaisa,
          quantity: 1,
        },
      ],
      success_url: `${frontendUrl}/payment/thawani-callback?status=success&order_id=${order.id}`,
      cancel_url: `${frontendUrl}/payment/thawani-callback?status=cancel&order_id=${order.id}`,
      ...(thawaniCustomerId ? { customer_id: thawaniCustomerId, save_card_on_success: true } : {}),
      metadata: {
        customer_name: customerName,
        customer_email: customerEmail,
        customer_phone: customerPhone,
        order_id: order.id,
        refund_policy_url: `${frontendUrl}/refund-policy`,
      },
    });

    const thawaniSessionId = result.data.session_id;
    const redirectUrl = `${checkoutBaseUrl}/pay/${thawaniSessionId}?key=${env.THAWANI_PUBLISHABLE_KEY}`;

    // Save/Update payment record in DB
    await prisma.payment.create({
      data: {
        orderId: order.id,
        paymentMethod: 'THAWANI',
        paymentStatus: 'PENDING',
        thawaniSessionId,
        thawaniInvoice: result.data.invoice,
        amount: order.total,
        transactionData: { thawaniSessionId } as any,
      },
    });

    res.status(200).json({
      status: 'success',
      data: {
        thawaniSessionId,
        redirectUrl,
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Called when the customer leaves/cancels the Thawani page. If the payment really wasn't completed the
 * unpaid order is cancelled and its stock put back; a paid order is never touched.
 */
export const cancelThawaniPayment = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { orderId } = req.body;
    if (!orderId || typeof orderId !== 'string') {
      return next(new AppError('Order ID is required', 400));
    }

    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order || order.userId !== (req as any).user?.id) {
      return next(new AppError('Order not found', 404));
    }

    const payment = await prisma.payment.findFirst({
      where: { orderId, paymentMethod: 'THAWANI' },
      orderBy: { createdAt: 'desc' },
    });
    // Saved-card (payment intent) flow is verified separately — never auto-cancel it from here.
    if (!payment || payment.thawaniPaymentId) {
      res.status(200).json({ status: 'success', data: { result: 'skipped' } });
      return;
    }

    const result = await settleThawaniSession(payment, { cancelIfUnpaid: true, reason: 'cancelled by customer' });
    res.status(200).json({ status: 'success', data: { result } });
  } catch (error) {
    next(error);
  }
};

export const verifyThawaniPayment = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { orderId } = req.body;

    if (!orderId) {
      return next(new AppError('Order ID is required', 400));
    }

    const order = await prisma.order.findUnique({
      where: { id: orderId },
    });

    if (!order) {
      return next(new AppError('Order not found', 404));
    }

    // Safety Check: Ensure the logged-in user owns this order
    if (order.userId !== (req as any).user?.id) {
      return next(new AppError('Unauthorized: You do not own this order', 403));
    }

    const paymentRecord = await prisma.payment.findFirst({
      where: {
        orderId,
        paymentMethod: 'THAWANI',
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    if (!paymentRecord || !paymentRecord.thawaniSessionId) {
      return next(new AppError('Payment record not found for this order', 404));
    }

    const thawaniSessionId = paymentRecord.thawaniSessionId;
    const baseUrl = env.THAWANI_ENV === 'prod' ? 'https://checkout.thawani.om' : 'https://uatcheckout.thawani.om';

    const response = await fetch(`${baseUrl}/api/v1/checkout/session/${thawaniSessionId}`, {
      method: 'GET',
      headers: {
        'thawani-api-key': env.THAWANI_API_KEY,
      },
    });

    const result = await response.json() as any;

    if (!response.ok || !result.success) {
      return next(new AppError(result.message || 'Failed to verify Thawani session', 400));
    }

    const paymentStatus = result.data.payment_status;

    let updatedOrder = null;

    if (paymentStatus === 'paid') {
      // Update payment record
      await prisma.payment.update({
        where: { id: paymentRecord.id },
        data: {
          paymentStatus: 'SUCCESS',
          transactionData: result.data,
        },
      });

      // Update Order
      updatedOrder = await prisma.order.update({
        where: { id: orderId },
        data: {
          paymentStatus: 'SUCCESS',
          orderStatus: 'PENDING',
        },
        include: { items: true, payments: true },
      });

      // Clear Cart if user is authenticated
      if (updatedOrder.userId) {
        const cart = await prisma.cart.findFirst({
          where: { userId: updatedOrder.userId },
        });
        if (cart) {
          await prisma.cartItem.deleteMany({ where: { cartId: cart.id } });
          await prisma.cart.update({
            where: { id: cart.id },
            data: { subtotal: 0, discount: 0, shipping: 0, tax: 0, total: 0 },
          });
        }
      }
    } else {
      // Mark as failed/cancelled
      await prisma.payment.update({
        where: { id: paymentRecord.id },
        data: {
          paymentStatus: paymentStatus === 'cancelled' ? 'CANCELLED' : 'FAILED',
          transactionData: result.data,
        },
      });

      return next(new AppError(`Payment not successful. Status: ${paymentStatus}`, 400));
    }

    res.status(200).json({
      status: 'success',
      message: 'Payment verified successfully',
      data: { order: updatedOrder },
    });
  } catch (error) {
    next(error);
  }
};

/** Lists the logged-in user's saved Thawani cards (empty list if none saved yet). */
export const listSavedCards = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = (req as any).user?.id;
    const user = await prisma.user.findUnique({ where: { id: userId } });

    if (!user?.thawaniCustomerId) {
      res.status(200).json({ status: 'success', data: { cards: [] } });
      return;
    }

    try {
      const result = await thawaniRequest<{ data: any[] }>('GET', `/payment_methods?customer_id=${user.thawaniCustomerId}`);
      res.status(200).json({ status: 'success', data: { cards: result.data || [] } });
    } catch {
      // Thawani returns an error when the customer has no saved cards yet
      res.status(200).json({ status: 'success', data: { cards: [] } });
    }
  } catch (error) {
    next(error);
  }
};

export const deleteSavedCard = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = (req as any).user?.id;
    const { cardId } = req.params;
    const user = await prisma.user.findUnique({ where: { id: userId } });

    if (!user?.thawaniCustomerId) {
      return next(new AppError('No saved cards found', 404));
    }

    await thawaniRequest('DELETE', `/payment_methods/${cardId}`);

    res.status(200).json({ status: 'success', message: 'Card removed successfully' });
  } catch (error) {
    next(error);
  }
};

/** Pays for an order using a previously saved card via Thawani Payment Intents. */
export const payWithSavedCard = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { orderId, cardId } = req.body;
    const userId = (req as any).user?.id;

    if (!orderId || !cardId) {
      return next(new AppError('Order ID and card ID are required', 400));
    }

    const order = await prisma.order.findUnique({ where: { id: orderId } });

    if (!order) {
      return next(new AppError('Order not found', 404));
    }
    if (order.userId !== userId) {
      return next(new AppError('Unauthorized: You do not own this order', 403));
    }

    const amountInBaisa = Math.round(Number(order.total) * 1000);

    let frontendUrl = env.FRONTEND_URL;
    if (req.headers.origin) {
      frontendUrl = req.headers.origin;
    } else if (req.headers.referer) {
      try {
        frontendUrl = new URL(req.headers.referer).origin;
      } catch {
        // Fallback to env.FRONTEND_URL
      }
    }
    if (frontendUrl.endsWith('/')) {
      frontendUrl = frontendUrl.slice(0, -1);
    }

    const intentResult = await thawaniRequest<{ data: { id: string; status: string; next_action?: { url?: string } } }>(
      'POST',
      '/payment_intents',
      {
        amount: amountInBaisa,
        payment_method: cardId,
        description: `Order #${order.orderNumber}`,
        client_reference_id: order.id,
        return_url: `${frontendUrl}/payment/thawani-callback?status=success&order_id=${order.id}`,
        metadata: { order_id: order.id },
      }
    );

    const paymentIntentId = intentResult.data.id;

    const confirmResult = await thawaniRequest<{ data: { status: string; next_action?: { url?: string } } }>(
      'POST',
      `/payment_intents/${paymentIntentId}/confirm`
    );

    const succeeded = confirmResult.data.status === 'succeeded';
    const otpUrl = confirmResult.data.next_action?.url || null;

    await prisma.payment.create({
      data: {
        orderId: order.id,
        paymentMethod: 'THAWANI',
        paymentStatus: succeeded ? 'SUCCESS' : 'PENDING',
        thawaniPaymentId: paymentIntentId,
        amount: order.total,
        transactionData: confirmResult.data as any,
      },
    });

    if (succeeded) {
      await prisma.order.update({
        where: { id: order.id },
        data: { paymentStatus: 'SUCCESS', orderStatus: 'PENDING' },
      });

      const cart = await prisma.cart.findFirst({ where: { userId } });
      if (cart) {
        await prisma.cartItem.deleteMany({ where: { cartId: cart.id } });
        await prisma.cart.update({
          where: { id: cart.id },
          data: { subtotal: 0, discount: 0, shipping: 0, tax: 0, total: 0 },
        });
      }
    }

    res.status(200).json({
      status: 'success',
      data: { paymentIntentId, succeeded, otpUrl },
    });
  } catch (error) {
    next(error);
  }
};

/** Verifies a saved-card payment intent after the user returns from the OTP page. */
export const verifyThawaniPaymentIntent = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { orderId } = req.body;
    const userId = (req as any).user?.id;

    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order) {
      return next(new AppError('Order not found', 404));
    }
    if (order.userId !== userId) {
      return next(new AppError('Unauthorized: You do not own this order', 403));
    }

    const paymentRecord = await prisma.payment.findFirst({
      where: { orderId, paymentMethod: 'THAWANI', thawaniPaymentId: { not: null } },
      orderBy: { createdAt: 'desc' },
    });

    if (!paymentRecord?.thawaniPaymentId) {
      return next(new AppError('Payment record not found for this order', 404));
    }

    const result = await thawaniRequest<{ data: { status: string } }>('GET', `/payment_intents/${paymentRecord.thawaniPaymentId}`);
    const succeeded = result.data.status === 'succeeded';

    await prisma.payment.update({
      where: { id: paymentRecord.id },
      data: { paymentStatus: succeeded ? 'SUCCESS' : 'FAILED', transactionData: result.data as any },
    });

    let updatedOrder = null;
    if (succeeded) {
      updatedOrder = await prisma.order.update({
        where: { id: orderId },
        data: { paymentStatus: 'SUCCESS', orderStatus: 'PENDING' },
        include: { items: true, payments: true },
      });

      const cart = await prisma.cart.findFirst({ where: { userId } });
      if (cart) {
        await prisma.cartItem.deleteMany({ where: { cartId: cart.id } });
        await prisma.cart.update({
          where: { id: cart.id },
          data: { subtotal: 0, discount: 0, shipping: 0, tax: 0, total: 0 },
        });
      }
    } else {
      return next(new AppError(`Payment not successful. Status: ${result.data.status}`, 400));
    }

    res.status(200).json({ status: 'success', data: { order: updatedOrder } });
  } catch (error) {
    next(error);
  }
};

/** Admin: refunds a successful Thawani payment for the given order via List Payments -> Create Refund. */
export const refundThawaniPayment = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { orderId } = req.params;

    const paymentRecord = await prisma.payment.findFirst({
      where: { orderId, paymentMethod: 'THAWANI', paymentStatus: 'SUCCESS' },
      orderBy: { createdAt: 'desc' },
    });

    if (!paymentRecord) {
      return next(new AppError('No successful Thawani payment found for this order', 404));
    }

    let invoice = paymentRecord.thawaniInvoice;

    // Backward-compat: older payment rows created before the invoice was stored — fetch it from the session.
    if (!invoice && paymentRecord.thawaniSessionId) {
      const session = await thawaniRequest<{ data: { invoice: string } }>('GET', `/checkout/session/${paymentRecord.thawaniSessionId}`);
      invoice = session.data.invoice;
    }

    if (!invoice) {
      return next(new AppError('Could not determine the Thawani invoice for this payment', 400));
    }

    const paymentsResult = await thawaniRequest<{ data: Array<{ payment_id: string; status: string; refunded: boolean }> }>(
      'GET',
      `/payments?checkout_invoice=${invoice}`
    );

    const refundablePayment = paymentsResult.data.find((p) => p.status === 'successful' && !p.refunded);

    if (!refundablePayment) {
      return next(new AppError('No refundable payment found for this order (already refunded or not successful)', 400));
    }

    const refundResult = await thawaniRequest<{ data: { refund_id: string; status: string; amount: number } }>('POST', '/refunds', {
      payment_id: refundablePayment.payment_id,
    });

    const updatedPayment = await prisma.payment.update({
      where: { id: paymentRecord.id },
      data: {
        paymentStatus: 'REFUNDED',
        thawaniRefundId: refundResult.data.refund_id,
        transactionData: { ...(paymentRecord.transactionData as any), refund: refundResult.data } as any,
      },
    });

    await prisma.order.update({
      where: { id: orderId },
      data: { paymentStatus: 'REFUNDED' },
    });

    res.status(200).json({ status: 'success', data: { payment: updatedPayment, refund: refundResult.data } });
  } catch (error) {
    next(error);
  }
};
