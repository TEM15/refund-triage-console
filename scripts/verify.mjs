import { readFileSync } from 'node:fs';
import { neon } from '@neondatabase/serverless';

// ---------------------------------------------------------------
// This checks the six acceptance conditions from the assessment
// against whatever is actually in my database right now.
//
// I run it after every replay. Checks 5 and 6 are proved by running
// this before and after a second replay and comparing the fingerprint
// it prints at the bottom.
// ---------------------------------------------------------------

const sql = neon(process.env.DATABASE_URL);

// Work out what the answer SHOULD be, by reading the event file.
const lines = readFileSync('events.ndjson', 'utf8').trim().split('\n');
const events = lines.map(l => JSON.parse(l));
const distinctIds = new Set(events.map(e => e.event_id));

// A refund event counts as "valid" if it has an order_id and a
// refund_amount that is a real positive number.
const validRefundIds = new Set(
  events
    .filter(e => e.topic === 'refund.requested')
    .filter(e => typeof e.payload?.order_id === 'string'
              && typeof e.payload?.refund_amount === 'number'
              && Number.isFinite(e.payload.refund_amount)
              && e.payload.refund_amount > 0)
    .map(e => e.event_id)
);

let allPassed = true;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  --  ' + detail : ''}`);
  if (!ok) allPassed = false;
}

console.log('\n============ ACCEPTANCE CHECKS ============\n');

// ---- 1. Every distinct event_id produced exactly one entry ----
const [{ stored }] = await sql`SELECT count(*)::int AS stored FROM webhook_events`;
check('1. one row per distinct event_id',
      stored === distinctIds.size,
      `${stored} stored, ${distinctIds.size} distinct in the file`);

const [{ ledger }] = await sql`SELECT count(*)::int AS ledger FROM refund_ledger`;
check('1b. one ledger entry per valid refund event',
      ledger === validRefundIds.size,
      `${ledger} ledger rows, ${validRefundIds.size} valid refund events`);

// ---- 2. No valid refund was dropped for arriving early ----
const dropped = await sql`
  SELECT l.event_id FROM refund_ledger l
  WHERE l.status = 'given_up'
    AND EXISTS (SELECT 1 FROM orders o
                WHERE o.order_id = l.order_id AND o.captured_cents > 0)`;
check('2. no refund with a real order was given up',
      dropped.length === 0,
      dropped.map(d => d.event_id).join(', '));

// ---- 3. Nothing refunded above what was charged ----
const over = await sql`
  SELECT order_id, captured_cents, refunded_cents FROM orders
  WHERE refunded_cents > captured_cents`;
check('3. no order refunded more than it was charged',
      over.length === 0,
      over.map(o => o.order_id).join(', '));

const [{ mismatched }] = await sql`
  SELECT count(*)::int AS mismatched FROM orders o
  WHERE o.refunded_cents <> COALESCE((
    SELECT sum(amount_cents) FROM refund_ledger r
    WHERE r.order_id = o.order_id AND r.status = 'refunded'), 0)`;
check('3b. order totals match the sum of their refunded ledger rows',
      mismatched === 0, `${mismatched} orders disagree`);

// ---- 4. Broken events rejected, logged, not retried forever ----
const [{ dead }] = await sql`SELECT count(*)::int AS dead FROM dead_letter`;
const [{ spinning }] = await sql`
  SELECT count(*)::int AS spinning FROM refund_ledger
  WHERE attempts > 12 AND status NOT IN ('refunded','rejected','given_up','needs_review')`;
check('4. broken events logged and nothing retrying forever',
      dead > 0 && spinning === 0,
      `${dead} dead-lettered, ${spinning} still spinning`);

// ---- Nothing left half-done ----
const [{ unfinished }] = await sql`
  SELECT count(*)::int AS unfinished FROM refund_ledger
  WHERE status IN ('new','waiting_for_order','approved')`;
check('5. queue fully drained', unfinished === 0, `${unfinished} still pending`);

// ---- The fingerprint for checks 5 and 6 ----
const [{ refunded }] = await sql`
  SELECT count(*)::int AS refunded FROM refund_ledger WHERE status='refunded'`;
const [{ total }] = await sql`
  SELECT COALESCE(sum(refunded_cents),0)::bigint AS total FROM orders`;

console.log(`
============ FINGERPRINT ============
events stored:     ${stored}
ledger entries:    ${ledger}
refunds paid:      ${refunded}
total refunded:    ${total} cents
=====================================
`);
console.log(allPassed ? 'ALL CHECKS PASSED\n' : 'SOME CHECKS FAILED\n');
process.exit(allPassed ? 0 : 1);