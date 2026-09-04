import { NextRequest, NextResponse } from 'next/server';
import { q } from '@/lib/db';
import { runRefund } from '@/lib/workflow';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// This is what the Approve and Reject buttons call.
export async function POST(req: NextRequest) {
  const { id, action } = await req.json();

  if (action === 'reject') {
    // I check the status here too, so a second click on a stale screen
    // cannot change a refund that has already moved on.
    await q(
      `UPDATE refund_ledger SET status='rejected' WHERE id=$1 AND status='needs_review'`,
      [id]
    );
    return NextResponse.json({ ok: true });
  }

  // ---------------------------------------------------------------
  // Approving means a human has overruled the model, so I have to
  // clear the stored decision as well as the status.
  //
  // I cache model_action on the refund row so retries never re-ask the
  // model. That is deliberate -- it keeps retries cheap and keeps the
  // decision stable across attempts. But it also meant that when an
  // agent approved something, runRefund loaded the row, read
  // model_action='review', and put the refund straight back into the
  // review queue. The approval was applied and then undone inside the
  // same request, so nothing appeared to happen on screen. Reject
  // worked because it is a single step and never reaches runRefund.
  //
  // Setting model_action='approve' is what lets runRefund fall through
  // to the payment step. I append to the reasoning rather than
  // overwriting it, so the audit trail still shows what the model
  // originally said and that a person overrode it.
  // ---------------------------------------------------------------
  await q(
    `UPDATE refund_ledger
     SET status          = 'approved',
         model_action    = 'approve',
         model_reasoning = COALESCE(model_reasoning, '') || ' [approved by an agent]',
         attempts        = 0,
         next_try_at     = now()
     WHERE id = $1 AND status = 'needs_review'`,
    [id]
  );

  // Run it straight away so the agent sees the outcome immediately
  // instead of waiting for the next tick.
  await runRefund(String(id));

  return NextResponse.json({ ok: true });
}