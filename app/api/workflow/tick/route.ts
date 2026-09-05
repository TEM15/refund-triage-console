import { NextRequest, NextResponse } from 'next/server';
import { q } from '@/lib/db';
import { runRefund } from '@/lib/workflow';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

// How long a claimed refund is reserved for. This was 5 seconds, which
// is shorter than an AI call often takes, so a second tick could grab a
// refund the first was still working on.
const LEASE_SECONDS = 120;

export async function POST(req: NextRequest) {
  const limit = Number(new URL(req.url).searchParams.get('limit') ?? 10);

  // A unique name for this invocation, so I can prove I still own a row
  // before I change it.
  const workerId = `w_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

  // FOR UPDATE SKIP LOCKED: lock the rows I take, and let another tick
  // skip past mine rather than wait behind them. The standard Postgres
  // way to build a work queue.
  const batch = await q<{ id: string }>(
    `UPDATE refund_ledger
     SET attempts    = attempts + 1,
         locked_by   = $2,
         next_try_at = now() + interval '${LEASE_SECONDS} seconds'
     WHERE id IN (
       SELECT id FROM refund_ledger
       WHERE next_try_at <= now()
         AND ( status IN ('new', 'waiting_for_order', 'approved')
               OR (status = 'refunded' AND notify_state = 'pending') )
       ORDER BY next_try_at
       LIMIT $1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING id`,
    [limit, workerId]
  );

  for (const row of batch) {
    await runRefund(row.id, workerId);
  }

  const [{ remaining }] = await q<any>(
    `SELECT count(*)::int AS remaining FROM refund_ledger
     WHERE status IN ('new','waiting_for_order','approved')
        OR (status='refunded' AND notify_state='pending')`
  );

  return NextResponse.json({ processed: batch.length, remaining, worker: workerId });
}