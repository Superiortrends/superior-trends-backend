import { Request, Response, NextFunction } from 'express';
import { prisma } from '../config/db.js';
import { env } from '../config/env.js';
import { AppError } from '../middlewares/error.middleware.js';

export const createThawaniSession = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
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

    if (!env.THAWANI_API_KEY || !env.THAWANI_PUBLISHABLE_KEY) {
      return next(new AppError('Thawani credentials are not configured on the server', 500));
    }

    const baseUrl = env.THAWANI_ENV === 'prod' ? 'https://checkout.thawani.om' : 'https://uatcheckout.thawani.om';
    
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

    const response = await fetch(`${baseUrl}/api/v1/checkout/session`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'thawani-api-key': env.THAWANI_API_KEY,
      },
      body: JSON.stringify({
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
        metadata: {
          customer_name: customerName,
          customer_email: customerEmail,
          customer_phone: customerPhone,
          order_id: order.id,
          refund_policy_url: `${frontendUrl}/refund-policy`,
        },
      }),
    });

    const result = await response.json() as any;

    if (!response.ok || !result.success) {
      return next(new AppError(result.message || 'Failed to create Thawani checkout session', 400));
    }

    const thawaniSessionId = result.data.session_id;
    const redirectUrl = `${baseUrl}/pay/${thawaniSessionId}?key=${env.THAWANI_PUBLISHABLE_KEY}`;

    // Save/Update payment record in DB
    await prisma.payment.create({
      data: {
        orderId: order.id,
        paymentMethod: 'THAWANI',
        paymentStatus: 'PENDING',
        razorpayOrderId: thawaniSessionId, // Using razorpayOrderId to store session ID to avoid migration
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

    if (!paymentRecord || !paymentRecord.razorpayOrderId) {
      return next(new AppError('Payment record not found for this order', 404));
    }

    const thawaniSessionId = paymentRecord.razorpayOrderId;
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
