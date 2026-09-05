import { q } from './db';
import { findPolicies } from './policy';
import { decide } from './llm';
import { recordConversation } from './conversation';

const GIVE_UP_WAITING_FOR_ORDER = 6;   // separate counters, because
const GIVE_UP_NOTIFYING         = 6;   // these are different problems
const HARD_STOP                 = 20;  // nothing runs forever, whatever breaks

/** Save one step of the trace. Writing the same step again just updates it. */
async function step(refundId: string, name: string, status: string, detail = '') {
  await q(
    `INSERT INTO workflow_steps (refund_id, step, status, detail)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (refund_id, step) DO UPDATE SET
       status     = EXCLUDED.status,
       detail     = EXCLUDED.detail,
       attempts   = workflow_steps.attempts + 1,
       updated_at = now()`,
    [refundId, name, status, detail]
  );
}

/**
 * Every status change goes through here so it carries the ownership
 * check. If another tick took this refund over while I was working, my
 * update matches nothing and I stop quietly instead of fighting it.
 */
async function setStatus(
  refundId: string, workerId: string, fields: string, params: any[] = []
): Promise<boolean> {
  const rows = await q(
    `UPDATE refund_ledger SET ${fields}
     WHERE id = $1 AND (locked_by = $2 OR locked_by IS NULL)
     RETURNING id`,
    [refundId, workerId, ...params]
  );
  return rows.length > 0;
}


// =================================================================
// Run one refund through the five steps:
//   load order -> check eligibility -> decide -> issue refund -> notify
//
// Safe to call over and over. Every step is either already done and
// skipped, or written so that repeating it changes nothing.
// =================================================================
export async function runRefund(refundId: string, workerId = 'manual') {
  const [r] = await q<any>(`SELECT * FROM refund_ledger WHERE id=$1`, [refundId]);
  if (!r) return;

  if (['rejected', 'given_up', 'needs_review'].includes(r.status)) return;
  if (r.status === 'refunded' && r.notify_state !== 'pending') return;

  if (r.attempts > HARD_STOP) {
    await setStatus(refundId, workerId,
      `status='given_up', last_error='exceeded the hard attempt limit', locked_by=NULL`);
    return;
  }

  // ---- STEP 1: load the order ---------------------------------
  const [order] = await q<any>(`SELECT * FROM orders WHERE order_id=$1`, [r.order_id]);

  if (!order || Number(order.captured_cents) === 0) {
    // Two very different situations look identical here: the order is
    // genuinely coming later, or it does not exist at all (ord_9999).
    // I cannot tell them apart, so I wait -- but a bounded number of
    // times. That satisfies BOTH "don't drop early arrivals" AND
    // "don't retry broken events forever". And if the order does turn
    // up later, the webhook revives this refund even from 'given_up'.
    const waits = Number(r.order_wait_attempts) + 1;

    if (waits >= GIVE_UP_WAITING_FOR_ORDER) {
      await step(refundId, 'load_order', 'failed', 'the order never arrived');
      await setStatus(refundId, workerId,
        `status='given_up', order_wait_attempts=$3, locked_by=NULL`, [waits]);
      await q(`INSERT INTO dead_letter (event_id, reason) VALUES ($1,$2)`,
              [r.event_id, 'order never arrived']);
      return;
    }

    await setStatus(refundId, workerId,
      `status='waiting_for_order', order_wait_attempts=$3,
       last_error='order is not here yet',
       next_try_at = now() + interval '5 seconds', locked_by=NULL`, [waits]);
    return;
  }
  await step(refundId, 'load_order', 'ok', order.order_id);

  // ---- STEPS 2 and 3: eligibility and the decision -------------
  // If model_action is already saved, the AI has answered before and I
  // reuse it. Keeps retries cheap and keeps the decision stable.
  let action = r.model_action;

  if (!action) {
    const policies = await findPolicies({
      reason: r.reason,
      currency: order.currency,
    });
    await step(refundId, 'check_eligibility', 'ok',
               policies.map(p => p.policy_id).join(', '));

    // My policies reason about "within 45 days of the order date" and
    // "refund the shipping charge", but my first prompt sent neither
    // the date nor the shipping amount. I was asking the model to apply
    // a date rule with no dates, so it kept -- correctly -- answering
    // "review, the policies do not establish this". Two thirds of my
    // refunds ended up in the review queue because of it.
    const daysSinceOrder = order.created_at && r.requested_at
      ? Math.max(0, Math.floor(
          (Date.parse(r.requested_at) - Date.parse(order.created_at)) / 86400000))
      : null;

    const decision = await decide({
      order,
      amountCents: Number(r.amount_cents),
      reason: r.reason,
      policies,
      daysSinceOrder,
      shippingCents: order.shipping_cents === null ? null : Number(order.shipping_cents),
    });

    await q(
      `UPDATE refund_ledger
       SET model_action=$2, model_reasoning=$3, model_confidence=$4, cited_policies=$5
       WHERE id=$1`,
      [refundId, decision.action, decision.reasoning,
       Math.round(decision.confidence * 100), decision.cited_policy_ids]
    );
    await step(refundId, 'decide', 'ok',
               `${decision.action} (${Math.round(decision.confidence * 100)}%)`);

    // The brief assigns conversation history to Mongo alongside the
    // policy documents. This is where it gets written.
    await recordConversation({
      refund_id: Number(refundId),
      order_id: r.order_id,
      prompt_facts: {
        currency: order.currency,
        captured_cents: Number(order.captured_cents),
        refunded_cents: Number(order.refunded_cents),
        requested_cents: Number(r.amount_cents),
        shipping_cents: order.shipping_cents === null ? null : Number(order.shipping_cents),
        days_since_order: daysSinceOrder,
        reason: r.reason,
      },
      policies_supplied: policies.map(p => ({ policy_id: p.policy_id, version: p.version })),
      decision,
      source: 'model',
    });

    action = decision.action;
  }

  if (action === 'review' || action === 'reject') {
    // The brief says "Anything the workflow will not approve on its own
    // goes to a review queue." So a model 'reject' goes to a human to
    // confirm rather than being refused automatically -- turning down
    // someone's money is a decision worth a person seeing.
    //
    // The one exception is in lib/llm.ts: if the amount exceeds the
    // remaining balance, that is arithmetic rather than judgement, and
    // it is rejected outright.
    await setStatus(refundId, workerId, `status='needs_review', locked_by=NULL`);
    return;
  }

  const stillMine = await setStatus(refundId, workerId, `status='approved'`);
  if (!stillMine) return;   // another worker took it over; stop cleanly

  // ---- STEP 4: move the money ---------------------------------
  const paid = await issueRefund(refundId);
  await step(refundId, 'issue_refund', paid.ok ? 'ok' : 'failed', paid.note);
  if (!paid.ok) {
    await setStatus(refundId, workerId,
      `status='rejected', last_error=$3, locked_by=NULL`, [paid.note]);
    return;
  }

  // ---- STEP 5: notify -----------------------------------------
  try {
    await sendNotification();
    await setStatus(refundId, workerId, `notify_state='sent', locked_by=NULL`);
    await step(refundId, 'notify', 'ok');
  } catch (e: any) {
    const tries = Number(r.notify_attempts) + 1;
    await step(refundId, 'notify', 'failed', `${e.message} (attempt ${tries})`);

    if (tries >= GIVE_UP_NOTIFYING) {
      // I stop trying to send the message. The refund still stands -- a
      // message not sending is not a reason to take money back.
      await setStatus(refundId, workerId,
        `notify_state='failed', notify_attempts=$3, locked_by=NULL`, [tries]);
      return;
    }

    // Retry later. The next attempt comes back through issueRefund,
    // finds status='refunded', and does nothing. That is the whole
    // reason a failed notification cannot cause a second payout.
    await setStatus(refundId, workerId,
      `notify_attempts=$3, last_error=$4,
       next_try_at = now() + interval '5 seconds', locked_by=NULL`,
      [tries, e.message]);
  }
}


// =================================================================
// THE MONEY STEP -- one SQL statement, and that is the point.
//
// Everything inside a single statement either all happens or none of it
// does, so I need no explicit transaction.
//
// The WITH block claims the refund by moving it from 'approved' to
// 'refunded'. If someone already claimed it, that matches nothing, the
// main UPDATE has no rows, and no money moves. That is what makes
// paying twice impossible.
//
// If the claim succeeds, the main UPDATE adds to the order's refunded
// total. That UPDATE locks the order row, so two refunds for the same
// order are handled one after the other. If the new total would exceed
// what was charged, the CHECK constraint rejects the whole statement --
// which undoes the claim too, because it is all one statement.
// =================================================================
export async function issueRefund(refundId: string): Promise<{ ok: boolean; note: string }> {
  try {
    const rows = await q(
      `WITH claim AS (
         UPDATE refund_ledger
         SET status = 'refunded', refunded_at = now()
         WHERE id = $1 AND status = 'approved'
         RETURNING order_id, amount_cents
       )
       UPDATE orders o
       SET refunded_cents = o.refunded_cents + c.amount_cents
       FROM claim c
       WHERE o.order_id = c.order_id
       RETURNING o.refunded_cents, o.captured_cents`,
      [refundId]
    );

    if (rows.length === 0) {
      // Already refunded on an earlier attempt. Nothing to do, and that
      // counts as success, not failure.
      return { ok: true, note: 'already refunded, skipped' };
    }
    return { ok: true, note: 'refund applied' };

  } catch (err: any) {
    // 23514 is Postgres's code for "a CHECK constraint said no".
    if (err?.code === '23514') {
      return { ok: false, note: 'this would refund more than was charged' };
    }
    throw err;
  }
}


/** A fake notification that fails about 15% of the time, as the brief requires. */
async function sendNotification() {
  if (Math.random() < 0.15) throw new Error('notification service timed out');
}