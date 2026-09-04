import { NextRequest, NextResponse } from 'next/server';
import { q } from '@/lib/db';
import { runRefund } from '@/lib/workflow';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const { id, action } = await req.json();

  if (action === 'reject') {
    await q(`UPDATE refund_ledger SET status='rejected' WHERE id=$1`, [id]);
    return NextResponse.json({ ok: true });
  }

  // Approving puts the refund back into the workflow at the pay step.
  // I reset attempts so it gets a clean run, and I check the status is
  // still needs_review so two agents clicking at once cannot both push
  // it through.
  await q(
    `UPDATE refund_ledger
     SET status='approved', attempts=0, next_try_at=now()
     WHERE id=$1 AND status='needs_review'`,
    [id]
  );

  await runRefund(String(id));
  return NextResponse.json({ ok: true });
}