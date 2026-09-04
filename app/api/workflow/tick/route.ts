import { NextRequest, NextResponse } from 'next/server';
import { q } from '@/lib/db';
import { runRefund } from '@/lib/workflow';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// A Vercel function has a time limit. I set this near the top of what
// the plan allows so one tick can get through a decent batch without
// being cut off halfway.
export const maxDuration = 300;

// ---------------------------------------------------------------
// I keep the webhook fast: it only writes rows and returns. I tried
// calling the model inside the webhook first, and each of the 1400
// posts then took a few seconds, which made the replay unusable.
//
// So the slow work happens here instead. My replay script calls this
// over and over until "remaining" comes back as 0.
// ---------------------------------------------------------------
export async function POST(req: NextRequest) {

  const limit = Number(new URL(req.url).searchParams.get('limit') ?? 10);

  // I grab a batch of refunds that need work.
  //
  // FOR UPDATE SKIP LOCKED means: if two tick requests are running at
  // once, the second one skips straight past the rows the first one
  // already grabbed, instead of sitting there waiting. This is the
  // standard way to build a work queue in Postgres.
  //
  // The same statement also bumps attempts and pushes next_try_at
  // forward, so the row will not be picked up again while I am still
  // working on it.
  const batch = await q<{ id: string }>(
    `UPDATE refund_ledger
     SET attempts = attempts + 1,
         next_try_at = now() + interval '5 seconds'
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
    [limit]
  );

  // I run them one at a time. The model call is the slow part, and
  // running them in parallel would just make me hit rate limits.
  for (const row of batch) {
    await runRefund(row.id);
  }

  // Note that refunds still waiting on next_try_at are counted here
  // too. That is deliberate -- otherwise my drain loop would stop
  // while work was still parked and waiting to be retried.
  const [{ remaining }] = await q<any>(
    `SELECT count(*)::int AS remaining FROM refund_ledger
     WHERE status IN ('new','waiting_for_order','approved')
        OR (status='refunded' AND notify_state='pending')`
  );

  return NextResponse.json({ processed: batch.length, remaining });
}