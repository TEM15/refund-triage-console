import { NextRequest, NextResponse } from 'next/server';
import { q } from '@/lib/db';
import { toCents } from '@/lib/money';
import { Event, OrderCreated, OrderPaid, RefundRequested } from '@/lib/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// If a claim is older than this and still 'processing', I assume the
// function that claimed it died, and I take it over.
const STALE_AFTER_SECONDS = 30;

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'body was not JSON' }, { status: 400 });
  }

  const parsed = Event.safeParse(body);
  if (!parsed.success) {
    await deadLetter(null, 'event did not match the expected shape', body);
    // 400 not 500 on purpose: sending this again would fail identically,
    // so the sender should give up rather than retry.
    return NextResponse.json({ error: 'bad event' }, { status: 400 });
  }
  const ev = parsed.data;

  // ---------------------------------------------------------------
  // THE IDEMPOTENCY GATE, now recoverable as well.
  //
  // One statement doing three things:
  //   1. New event -> insert as 'processing' and return it. I own it.
  //   2. Exists and is 'done' or 'rejected' -> the WHERE fails, no rows
  //      come back. A genuine duplicate. Skip.
  //   3. Exists, still 'processing', claimed over 30s ago -> I take it
  //      over and finish it.
  //
  // Case 3 is the fix. Before, recording the event and applying its
  // change were two statements, and a function killed between them left
  // the event marked seen with no refund -- and my own deduplication
  // then skipped the retry. The refund was lost silently and forever.
  //
  // Safe to repeat because everything in handle() is an upsert or an
  // ON CONFLICT DO NOTHING, so redoing it changes nothing.
  // ---------------------------------------------------------------
  const claimed = await q<{ event_id: string }>(
    `INSERT INTO webhook_events (event_id, topic, occurred_at, payload, status, claimed_at)
     VALUES ($1, $2, $3, $4, 'processing', now())
     ON CONFLICT (event_id) DO UPDATE
       SET claimed_at = now()
     WHERE webhook_events.status = 'processing'
       AND webhook_events.claimed_at < now() - interval '${STALE_AFTER_SECONDS} seconds'
     RETURNING event_id`,
    [ev.event_id, ev.topic, ev.occurred_at, ev.payload]
  );

  if (claimed.length === 0) {
    // Either genuinely done, or another invocation is on it right now.
    return NextResponse.json({ status: 'duplicate' });
  }

  const result = await handle(ev);

  if (!result.ok) {
    await q(`UPDATE webhook_events SET status='rejected', note=$2 WHERE event_id=$1`,
            [ev.event_id, result.reason]);
    await deadLetter(ev.event_id, result.reason!, ev.payload);
    return NextResponse.json({ status: 'rejected', reason: result.reason }, { status: 400 });
  }

  // Only now is the event finished. Until this line runs, a later retry
  // is allowed to take it over and redo the work.
  await q(`UPDATE webhook_events SET status='done' WHERE event_id=$1`, [ev.event_id]);

  return NextResponse.json({ status: 'accepted' }, { status: 202 });
}


async function handle(ev: any): Promise<{ ok: boolean; reason?: string }> {

  if (ev.topic === 'order.created') {
    const p = OrderCreated.safeParse(ev.payload);
    if (!p.success) return { ok: false, reason: 'bad order.created payload' };
    const d = p.data;

    // ON CONFLICT DO UPDATE because order.paid may have arrived first
    // and created this row. COALESCE keeps what is already there rather
    // than overwriting it with nulls.
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

    // The order date matters for my return-window policies, so a refund
    // parked before the date existed should be reconsidered.
    await wakeRefundsFor(d.order_id);
    return { ok: true };
  }

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

    await wakeRefundsFor(d.order_id);
    return { ok: true };
  }

  if (ev.topic === 'refund.requested') {
    const p = RefundRequested.safeParse(ev.payload);
    if (!p.success) {
      // The "NaN" events land here. They can never become valid, so I
      // reject once and never retry.
      return { ok: false, reason: 'bad refund.requested payload' };
    }
    const d = p.data;

    // I do NOT check whether the order exists. A refund arriving before
    // its order is normal; the workflow deals with that.
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


/**
 * When an order finally turns up, revive its parked refunds.
 *
 * The important part is `status = 'given_up'`. My first version only
 * revived 'waiting_for_order', so a refund whose order arrived one
 * second after the sixth attempt stayed dead forever. My replay passed
 * only because the seed file shuffles events by at most 15 positions,
 * so orders always arrived inside the window -- luck about the test
 * data, not a property of my system.
 *
 * `model_action IS NULL` makes sure I only revive refunds that gave up
 * waiting for an order, not ones that gave up for another reason.
 */
async function wakeRefundsFor(orderId: string) {
  await q(
    `UPDATE refund_ledger
     SET status = 'new', order_wait_attempts = 0, attempts = 0,
         next_try_at = now(), last_error = NULL, locked_by = NULL
     WHERE order_id = $1
       AND ( status = 'waiting_for_order'
             OR (status = 'given_up' AND model_action IS NULL) )`,
    [orderId]
  );
}


async function deadLetter(eventId: string | null, reason: string, payload: unknown) {
  await q(`INSERT INTO dead_letter (event_id, reason, payload) VALUES ($1,$2,$3)`,
          [eventId, reason, payload as any]);
}