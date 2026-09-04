import { z } from 'zod';

// ---------------------------------------------------------------
// Zod checks that data has the shape I expect before I use it.
// I use it in two places: on incoming webhooks, and on the model's
// reply. Both come from outside my system, so I trust neither.
// ---------------------------------------------------------------

const positiveMoney = z.number().finite().positive();

/** The outer wrapper that every event has. */
export const Event = z.object({
  event_id: z.string().min(1),
  topic: z.enum(['order.created', 'order.paid', 'refund.requested']),
  occurred_at: z.string(),
  payload: z.record(z.string(), z.unknown()),
});

export const OrderCreated = z.object({
  order_id: z.string().min(1),
  currency: z.string().min(1),
  subtotal: z.number().finite().nonnegative(),
  shipping: z.number().finite().nonnegative(),
  tax: z.number().finite().nonnegative(),
});

export const OrderPaid = z.object({
  order_id: z.string().min(1),
  currency: z.string().min(1),
  amount: positiveMoney,
});

// The two permanently broken events fail here:
// they have no order_id, and their refund_amount is the string "NaN".
export const RefundRequested = z.object({
  order_id: z.string().min(1),
  refund_amount: positiveMoney,
  reason: z.string().optional(),
});