import { q } from './db';
import { findPolicies } from './policy';
import { decide } from './llm';

// I stop after this many attempts. This is what stops the ord_9999
// events (a refund for an order that never exists) from retrying
// forever, which is acceptance check number four.
const GIVE_UP_AFTER = 6;


/**
 * Saves one step of the trace shown in the console.
 * Because (refund_id, step) is UNIQUE, writing the same step again
 * just updates the existing row and bumps its attempt counter,
 * instead of piling up duplicate rows.
 */
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

/** Pushes a refund's next attempt a few seconds into the future. */
async function retryLater(refundId: string, status: string, error = '') {
  await q(
    `UPDATE refund_ledger
     SET status=$2, last_error=$3, next_try_at = now() + interval '5 seconds'
     WHERE id=$1`,
    [refundId, status, error]
  );
}


// =================================================================
// Runs one refund through the five steps the assessment asks for:
//
//   load order -> check eligibility -> decide -> issue refund -> notify
//
// I wrote this so it is safe to call over and over on the same
// refund. Every step either has already been done (so it gets
// skipped) or is written in a way where repeating it changes nothing.
// That is what makes retries safe.
// =================================================================
export async function runRefund(refundId: string) {

  const [r] = await q<any>(`SELECT * FROM refund_ledger WHERE id=$1`, [refundId]);
  if (!r) return;

  // Nothing to do for refunds that are already finished, except a
  // notification I still owe someone.
  if (['rejected', 'given_up', 'needs_review'].includes(r.status)) return;
  if (r.status === 'refunded' && r.notify_state !== 'pending') return;


  // ---- STEP 1: LOAD ORDER --------------------------------------
  const [order] = await q<any>(
    `SELECT * FROM orders WHERE order_id=$1`, [r.order_id]
  );

  if (!order || Number(order.captured_cents) === 0) {
    // Two completely different situations look identical to me here:
    //   a) the order is genuinely arriving later, because events come
    //      out of order and this is normal
    //   b) the order does not exist at all, like ord_9999 in the test
    //      data
    //
    // I cannot tell them apart from the outside. So I wait -- but only
    // a limited number of times. That satisfies both requirements at
    // once: I never drop a refund that arrived early, and I never
    // retry a broken one forever.
    if (r.attempts >= GIVE_UP_AFTER) {
      await step(refundId, 'load_order', 'failed', 'order never arrived');
      await q(`UPDATE refund_ledger SET status='given_up' WHERE id=$1`, [refundId]);
      await q(
        `INSERT INTO dead_letter (event_id, reason) VALUES ($1, $2)`,
        [r.event_id, 'order never arrived after ' + GIVE_UP_AFTER + ' attempts']
      );
      return;
    }
    await retryLater(refundId, 'waiting_for_order', 'order not here yet');
    return;
  }
  await step(refundId, 'load_order', 'ok', order.order_id);


  // ---- STEPS 2 AND 3: ELIGIBILITY AND DECISION -----------------
  // If model_action is already saved on the row, the model has
  // answered this before. I reuse the saved answer instead of paying
  // for another call, and more importantly the decision stays the
  // same across retries instead of possibly flipping.
  let action = r.model_action;

  if (!action) {
    // Eligibility comes from the policy documents, not from a chain of
    // if statements in here. That is what the assessment asks for and
    // it also means the rules can change without me changing code.
    const policies = await findPolicies({
      reason: r.reason,
      currency: order.currency,
    });
    await step(refundId, 'check_eligibility', 'ok',
               policies.map(p => p.policy_id).join(', '));

    const d = await decide({
      order,
      amountCents: Number(r.amount_cents),
      reason: r.reason,
      policies,
    });

    await q(
      `UPDATE refund_ledger
       SET model_action=$2, model_reasoning=$3,
           model_confidence=$4, cited_policies=$5
       WHERE id=$1`,
      [refundId, d.action, d.reasoning,
       Math.round(d.confidence * 100), d.cited_policy_ids]
    );
    await step(refundId, 'decide', 'ok',
               `${d.action} at ${Math.round(d.confidence * 100)}% confidence`);
    action = d.action;
  }

  if (action === 'reject') {
    await q(`UPDATE refund_ledger SET status='rejected' WHERE id=$1`, [refundId]);
    return;
  }

  if (action === 'review') {
    // Anything the workflow will not approve on its own goes into the
    // review queue for a human, which is what the assessment asks for.
    await q(`UPDATE refund_ledger SET status='needs_review' WHERE id=$1`, [refundId]);
    return;
  }

  // I mark it cleared for payment. issueRefund below only pays rows
  // that are in this exact state, and that is what makes the payment
  // happen exactly once.
  await q(
    `UPDATE refund_ledger SET status='approved'
     WHERE id=$1 AND status IN ('new','waiting_for_order')`,
    [refundId]
  );


  // ---- STEP 4: ISSUE REFUND (the money) ------------------------
  const paid = await issueRefund(refundId);
  await step(refundId, 'issue_refund', paid.ok ? 'ok' : 'failed', paid.note);

  if (!paid.ok) {
    await q(
      `UPDATE refund_ledger SET status='rejected', last_error=$2 WHERE id=$1`,
      [refundId, paid.note]
    );
    return;
  }


  // ---- STEP 5: NOTIFY ------------------------------------------
  try {
    await sendNotification();
    await q(`UPDATE refund_ledger SET notify_state='sent' WHERE id=$1`, [refundId]);
    await step(refundId, 'notify', 'ok');

  } catch (e: any) {
    await step(refundId, 'notify', 'failed', e.message);

    if (r.attempts >= GIVE_UP_AFTER) {
      // I stop trying to send the notification. The refund itself
      // still stands -- a failed email is not a reason to un-pay
      // someone, and it is definitely not a reason to pay them again.
      await q(`UPDATE refund_ledger SET notify_state='failed' WHERE id=$1`, [refundId]);
      return;
    }

    // Retry later. On the next attempt the workflow comes back through
    // issueRefund, which will find status='refunded' instead of
    // 'approved', match nothing, and do nothing. That is the whole
    // reason a failed notification cannot cause a second payout.
    await retryLater(refundId, 'refunded', e.message);
  }
}


// =================================================================
// THE MONEY STEP. It is one SQL statement, and that is the point.
//
// Everything inside a single SQL statement either all happens or none
// of it happens. So I do not need to write an explicit transaction
// with BEGIN and COMMIT -- Postgres already gives me that here.
//
// How it works, top to bottom:
//
// 1. The WITH block (called a CTE) tries to claim the ledger row by
//    moving it from 'approved' to 'refunded'. If some earlier attempt
//    already did that, this matches nothing.
//
// 2. The main UPDATE adds the amount to the order's refunded total,
//    but only FROM the rows the claim produced. So if the claim
//    matched nothing, no money moves. That is what makes paying twice
//    impossible.
//
// 3. The main UPDATE locks the order row while it runs. If two
//    refunds for the same order arrive at the same moment, Postgres
//    handles them one after the other, and the second one reads the
//    total the first one just wrote.
//
// 4. If the new total would go over what was charged, the CHECK
//    constraint on the orders table rejects the whole statement --
//    which also undoes the claim in step 1, because it is all one
//    statement. So the refund stays 'approved' and I mark it rejected.
// =================================================================
export async function issueRefund(
  refundId: string
): Promise<{ ok: boolean; note: string }> {
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
      // Already refunded on an earlier attempt. Nothing happened, and
      // that counts as success, not failure.
      return { ok: true, note: 'already refunded, nothing to do' };
    }
    return { ok: true, note: 'refund applied' };

  } catch (err: any) {
    // 23514 is the Postgres error code for "a CHECK constraint said no".
    // Getting here means my never_over_refund rule did its job.
    if (err?.code === '23514') {
      return { ok: false, note: 'would refund more than was charged' };
    }
    throw err;
  }
}


/**
 * A pretend notification that fails about fifteen percent of the time,
 * exactly as the assessment asks for. This is deliberate, not a bug.
 */
async function sendNotification() {
  if (Math.random() < 0.15) {
    throw new Error('notification service timed out');
  }
}