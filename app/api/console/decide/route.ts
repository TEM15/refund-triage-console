import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { q } from '@/lib/db';
import { runRefund } from '@/lib/workflow';
import { recordConversation } from '@/lib/conversation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// My first version read `action` straight off the request body and
// treated anything that was not the string "reject" as an approval.
// Posting {"id": 5, "action": "banana"} would have approved a refund and
// moved money -- on a public URL.
//
// I use Zod carefully on every webhook payload and every model reply,
// and then trusted my own API because it felt "internal". It is not.
const DecideRequest = z.object({
  id: z.union([z.number().int().positive(), z.string().regex(/^\d+$/)]),
  action: z.enum(['approve', 'reject']),
});

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'body was not JSON' }, { status: 400 });
  }

  const parsed = DecideRequest.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'id must be a positive number and action must be approve or reject' },
      { status: 400 });
  }
  const { id, action } = parsed.data;

  if (action === 'reject') {
    // The status check means a second click on a stale screen cannot
    // change a refund that has already moved on.
    const rows = await q(
      `UPDATE refund_ledger SET status='rejected'
       WHERE id=$1 AND status='needs_review' RETURNING id`, [id]);

    if (rows.length === 0) {
      return NextResponse.json({ error: 'that refund is no longer awaiting review' },
                               { status: 409 });
    }
    await recordConversation({ refund_id: Number(id), source: 'agent', agent_action: 'reject' });
    return NextResponse.json({ ok: true });
  }

  // ---------------------------------------------------------------
  // Approving means a human has overruled the model, so I clear the
  // saved decision as well as the status.
  //
  // I cache model_action so retries never re-ask the model. That is
  // deliberate. But it meant that when an agent approved something,
  // runRefund loaded the row, read model_action='review', and put the
  // refund straight back into the review queue -- undoing the approval
  // inside the same request. Reject worked because it is a single step
  // that never reaches runRefund.
  //
  // I append to the reasoning rather than overwriting it, so the record
  // still shows what the model said and that a person overrode it.
  // ---------------------------------------------------------------
  const rows = await q(
    `UPDATE refund_ledger
     SET status          = 'approved',
         model_action    = 'approve',
         model_reasoning = COALESCE(model_reasoning, '') || ' [approved by an agent]',
         attempts        = 0,
         notify_attempts = 0,
         locked_by       = NULL,
         next_try_at     = now()
     WHERE id = $1 AND status = 'needs_review'
     RETURNING id`,
    [id]
  );

  if (rows.length === 0) {
    return NextResponse.json({ error: 'that refund is no longer awaiting review' },
                             { status: 409 });
  }

  await recordConversation({ refund_id: Number(id), source: 'agent', agent_action: 'approve' });

  // Run it straight away so the agent sees the outcome immediately.
  await runRefund(String(id), 'agent');

  return NextResponse.json({ ok: true });
}