import { neon } from '@neondatabase/serverless';

// A small helper I use to look at the database from the terminal while
// testing. Not part of the app. Everything here is read-only.
const sql = neon(process.env.DATABASE_URL);

// ---------------------------------------------------------------
// A few untouched orders, so I have something safe to aim a manual
// test at without disturbing the replay data.
// ---------------------------------------------------------------
console.log('\nOrders with nothing refunded yet:');
console.table(await sql`
  SELECT order_id, captured_cents, refunded_cents
  FROM orders
  WHERE refunded_cents = 0 AND captured_cents > 0
  LIMIT 3`);


// ---------------------------------------------------------------
// The single most useful view. Model action against final status tells
// me at a glance whether a change moved refunds between buckets.
//
// This is what showed me my review count of 158 was really 120 the
// model wanted a human to see, plus 38 it wanted to reject -- which now
// go to a person rather than being refused automatically. The headline
// number had not moved, but the breakdown had.
// ---------------------------------------------------------------
console.log('\nWhat the model decided, and where those refunds ended up:');
console.table(await sql`
  SELECT model_action, status, count(*)::int AS n
  FROM refund_ledger
  GROUP BY model_action, status
  ORDER BY n DESC`);


// ---------------------------------------------------------------
// This must always be empty. If it is not, the CHECK constraint on the
// orders table has somehow been bypassed, which should be impossible.
// ---------------------------------------------------------------
const overRefunded = await sql`
  SELECT order_id, captured_cents, refunded_cents
  FROM orders WHERE refunded_cents > captured_cents`;
console.log(`\nOver-refunded orders: ${overRefunded.length} (must be 0)`);
if (overRefunded.length) console.table(overRefunded);


// ---------------------------------------------------------------
// Anything that has been retried a lot. High attempts with
// waiting_for_order is expected for the orphan refunds. High attempts
// with anything else means something is struggling.
// ---------------------------------------------------------------
const struggling = await sql`
  SELECT id, order_id, status, attempts, order_wait_attempts,
         notify_attempts, last_error
  FROM refund_ledger
  WHERE attempts > 3
  ORDER BY attempts DESC
  LIMIT 10`;
if (struggling.length) {
  console.log('\nRefunds that have been retried more than three times:');
  console.table(struggling);
}


// ---------------------------------------------------------------
// My manual test rows, from the over-refund and race tests. These only
// exist while I am testing by hand, so the whole block is skipped when
// there are none rather than printing an empty heading.
// ---------------------------------------------------------------
const manualTests = await sql`
  SELECT event_id, order_id, amount_cents, status, last_error,
         model_action, model_confidence, model_reasoning
  FROM refund_ledger
  WHERE event_id LIKE 'overtest%'
     OR event_id LIKE 'racetest%'
     OR event_id LIKE 'notifytest%'
  ORDER BY event_id`;

if (manualTests.length) {
  console.log('\nMy manual test rows:');
  console.table(manualTests.map(t => ({
    event_id: t.event_id,
    order_id: t.order_id,
    amount_cents: t.amount_cents,
    status: t.status,
    last_error: t.last_error ?? '',
  })));

  console.log('\nThe orders they targeted:');
  console.table(await sql`
    SELECT order_id, captured_cents, refunded_cents
    FROM orders
    WHERE order_id IN (
      SELECT order_id FROM refund_ledger
      WHERE event_id LIKE 'overtest%'
         OR event_id LIKE 'racetest%'
         OR event_id LIKE 'notifytest%')`);

  console.log('\nWhat the model said about each:');
  for (const t of manualTests) {
    console.log(`\n  ${t.event_id}`);
    console.log(`    model said:   ${t.model_action ?? '(never asked)'} (${t.model_confidence ?? 0}%)`);
    console.log(`    final status: ${t.status}`);
    console.log(`    last_error:   ${t.last_error ?? '(none)'}`);
    if (t.model_reasoning) console.log(`    reasoning:    ${t.model_reasoning}`);
  }
}

console.log('');