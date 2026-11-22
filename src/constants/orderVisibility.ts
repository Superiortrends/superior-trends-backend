/**
 * Orders that count as "real" orders: payment confirmed (paid or refunded) or Cash on Delivery.
 * Online orders that were started but never paid (customer closed the Thawani page) are NOT included,
 * so they never show up on the admin dashboard/orders list or in a customer's order history.
 */
export const placedOrderWhere = {
  OR: [
    { paymentStatus: 'SUCCESS' as const },
    { paymentStatus: 'REFUNDED' as const },
    { payments: { some: { paymentMethod: 'COD' as const } } },
  ],
};

export function isPlacedOrder(order: {
  paymentStatus: string;
  payments?: { paymentMethod: string }[];
}): boolean {
  if (order.paymentStatus === 'SUCCESS' || order.paymentStatus === 'REFUNDED') return true;
  return (order.payments ?? []).some((p) => p.paymentMethod === 'COD');
}
