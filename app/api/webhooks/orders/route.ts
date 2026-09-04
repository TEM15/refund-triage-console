import { NextRequest, NextResponse } from 'next/server';
import { q } from '@/lib/db';
import { toCents } from '@/lib/money';
import { Event, OrderCreated, OrderPaid, RefundRequested } from '@/lib/validate';

export const runtime = 'nodejs';
// I set force-dynamic because a webhook must never be cached.
// Every single request has to actually run my code.
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {

  // ---- Step 1: read the body ----
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'body was not JSON' }, { status: 400 });
  }

  // ---- Step 2: check the outer shape ----
  const parsed = Event.safeParse(body);
  if (!parsed.success) {
    await deadLetter(null, 'event did not match the expected shape', body);
    // I return 400 and not 500 on purpose. A 500 tells the sender
    // "try again later", and this event would fail in exactly the
    // same way forever. A 400 says "do not bother resending this".
    return NextResponse.json({ error: 'bad event' }, { status: 400 });
  }
  const ev = parsed.data;

  // ---------------------------------------------------------------
  // Step 3: THE IDEMPOTENCY GATE. This is the important bit.
  //
  // event_id is the primary key of webhook_events. This single
  // statement tries to insert, and if the row already exists it
  // quietly does nothing instead of throwing an error. RETURNING
  // tells me which of those two things happened: I only get a row
  // back if I was the one who actually inserted it.
  //
  // I did NOT write "check if it exists, then insert" because that
  // has a gap. Two copies of the same event can be running in two
  // different Vercel functions at the same instant. Both would look,
  // both would see nothing, and both would insert. There is no gap
  // here because there is no separate look -- Postgres settles it
  // inside one atomic statement.
  //
  // I also did not use a Set in memory. That works on my laptop and
  // quietly breaks on Vercel, where two requests may land on two
  // different machines that share no memory at all.
  // ---------------------------------------------------------------
  const claimed = await q(
    `INSERT INTO webhook_events (event_id, topic, occurred_at, payload)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (event_id) DO NOTHING
     RETURNING event_id`,
    [ev.event_id, ev.topic, ev.occurred_at, ev.payload]
  );

  if (claimed.length === 0) {
    // Somebody else already has this event. I say OK and do nothing.
    return NextResponse.json({ status: 'duplicate' });
  }

  // ---- Step 4: I own this event, so process it ----
  const result = await handle(ev);

  if (!result.ok) {
    await q(
      `UPDATE webhook_events SET status='rejected', note=$2 WHERE event_id=$1`,
      [ev.event_id, result.reason]
    );
    await deadLetter(ev.event_id, result.reason!, ev.payload);
    return NextResponse.json({ status: 'rejected', reason: result.reason },
                             { status: 400 });
  }

  return NextResponse.json({ status: 'accepted' }, { status: 202 });
}


/**
 * Does the actual work for one event.
 * I return an object instead of throwing an error because it keeps
 * the caller simple: either it worked, or here is exactly why not.
 */
async function handle(ev: any): Promise<{ ok: boolean; reason?: string }> {

  // ============ ORDER CREATED ============
  if (ev.topic === 'order.created') {
    const p = OrderCreated.safeParse(ev.payload);
    if (!p.success) return { ok: false, reason: 'bad order.created payload' };
    const d = p.data;

    // I use ON CONFLICT DO UPDATE because order.paid might have
    // arrived first (events come out of order) and already made this
    // row. COALESCE keeps whatever value is already there instead of
    // overwriting it with a null.
    await q(
      `INSERT INTO orders (order_id, currency, subtotal_cents, shipping_cents,
                           tax_cents, created_at)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (order_id) DO UPDATE SET
         currency       = COALESCE(orders.currency, EXCLUDED.currency),
         subtotal_cents = COALESCE(orders.subtotal_cents, EXCLUDED.subtotal_cents),
         shipping_cents = COALESCE(orders.shipping_cents, EXCLUDED.shipping_cents),
         tax_cents      = COALESCE(orders.tax_cents, EXCLUDED.tax_cents),
         created_at     = COALESCE(orders.created_at, EXCLUDED.created_at)`,
      [d.order_id, d.currency, toCents(d.subtotal), toCents(d.shipping),
       toCents(d.tax), ev.occurred_at]
    );
    return { ok: true };
  }

  // ============ ORDER PAID ============
  if (ev.topic === 'order.paid') {
    const p = OrderPaid.safeParse(ev.payload);
    if (!p.success) return { ok: false, reason: 'bad order.paid payload' };
    const d = p.data;

    await q(
      `INSERT INTO orders (order_id, currency, captured_cents)
       VALUES ($1,$2,$3)
       ON CONFLICT (order_id) DO UPDATE SET
         captured_cents = EXCLUDED.captured_cents,
         currency       = COALESCE(orders.currency, EXCLUDED.currency)`,
      [d.order_id, d.currency, toCents(d.amount)]
    );

    // If any refunds for this order were parked waiting for it, I wake
    // them up straight away instead of making them wait for their next
    // scheduled retry. I reset attempts to 0 because the reason they
    // were stuck has now gone away, so they deserve a clean slate.
    await q(
      `UPDATE refund_ledger
       SET status='new', attempts=0, next_try_at=now()
       WHERE order_id=$1 AND status='waiting_for_order'`,
      [d.order_id]
    );
    return { ok: true };
  }

  // ============ REFUND REQUESTED ============
  if (ev.topic === 'refund.requested') {
    const p = RefundRequested.safeParse(ev.payload);
    if (!p.success) {
      // This is where the "NaN" events land. They can never become
      // valid, so I reject them once here and never retry them.
      return { ok: false, reason: 'bad refund.requested payload' };
    }
    const d = p.data;

    // Notice: I do NOT check whether the order exists here.
    // A refund arriving before its order is completely normal in this
    // system and must not be dropped. My workflow deals with it later.
    await q(
      `INSERT INTO refund_ledger (event_id, order_id, amount_cents, reason, requested_at)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (event_id) DO NOTHING`,
      [ev.event_id, d.order_id, toCents(d.refund_amount),
       d.reason ?? null, ev.occurred_at]
    );
    return { ok: true };
  }

  return { ok: false, reason: 'unknown topic' };
}


/** I write everything I throw away here, so nothing vanishes silently. */
async function deadLetter(eventId: string | null, reason: string, payload: unknown) {
  await q(
    `INSERT INTO dead_letter (event_id, reason, payload) VALUES ($1,$2,$3)`,
    [eventId, reason, payload as any]
  );
}