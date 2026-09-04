import { NextResponse } from 'next/server';
import { q } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// I made one endpoint that returns everything the screen needs.
// Four small endpoints would mean four files to explain and four
// round trips from the browser, and I did not need that here.
export async function GET() {

  // Refunds waiting for a human, with the order details next to them.
  const review = await q(
    `SELECT r.id, r.order_id, r.amount_cents, r.reason,
            r.model_action, r.model_reasoning, r.model_confidence,
            r.cited_policies,
            o.currency, o.captured_cents, o.refunded_cents
     FROM refund_ledger r
     JOIN orders o ON o.order_id = r.order_id
     WHERE r.status = 'needs_review'
     ORDER BY r.id`
  );

  // The workflow trace for each of those, so an agent can see exactly
  // what happened before it landed on their desk.
  const steps = await q(
    `SELECT s.refund_id, s.step, s.status, s.attempts, s.detail
     FROM workflow_steps s
     JOIN refund_ledger r ON r.id = s.refund_id
     WHERE r.status = 'needs_review'
     ORDER BY s.refund_id, s.id`
  );

  // Everything that has reached a final state. Without this a refund
  // just vanished from the queue after a decision and there was nowhere
  // to confirm what actually happened to it.
  const settled = await q(
    `SELECT r.id, r.order_id, r.amount_cents, r.status, r.reason,
            r.model_action, r.refunded_at, r.notify_state,
            o.currency
     FROM refund_ledger r
     JOIN orders o ON o.order_id = r.order_id
     WHERE r.status IN ('refunded', 'rejected', 'given_up')
     ORDER BY r.refunded_at DESC NULLS LAST, r.id DESC
     LIMIT 100`
  );

  // Charged against refunded for every order that has had any refund.
  // balance_cents must never be negative -- if it is, something is
  // very wrong and the screen shows it in red.
  const reconciliation = await q(
    `SELECT order_id, currency, captured_cents, refunded_cents,
            (captured_cents - refunded_cents) AS balance_cents
     FROM orders
     WHERE refunded_cents > 0
     ORDER BY order_id`
  );

  // Events I could not process at all -- broken payloads, and refunds
  // whose order never turned up. These are ingest failures, which is a
  // completely different thing from a refund an agent rejected.
  const discarded = await q(
    `SELECT event_id, reason, created_at FROM dead_letter
     ORDER BY id DESC LIMIT 100`
  );

  const [counts] = await q<any>(
    `SELECT
       (SELECT count(*)::int FROM refund_ledger WHERE status='needs_review') AS in_review,
       (SELECT count(*)::int FROM refund_ledger WHERE status='refunded')     AS refunded,
       (SELECT count(*)::int FROM orders
          WHERE refunded_cents > captured_cents)                             AS mismatches,
       (SELECT count(*)::int FROM dead_letter)                               AS dead`
  );

  // The Cache-Control header matters. force-dynamic only stops Next.js
  // caching this on the server; without this header the browser and the
  // CDN happily served a stale response and the screen never updated
  // after an approval, even though the approval itself worked.
  return NextResponse.json(
    { review, steps, settled, reconciliation, discarded, counts },
    { headers: { 'Cache-Control': 'no-store, max-age=0' } }
  );
}