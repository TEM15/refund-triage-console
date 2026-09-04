import { neon } from '@neondatabase/serverless';

// A small helper I use to look at the database from the terminal
// while testing. Not part of the app.
const sql = neon(process.env.DATABASE_URL);

const orders = await sql`
  SELECT order_id, captured_cents, refunded_cents
  FROM orders
  WHERE refunded_cents = 0 AND captured_cents > 0
  LIMIT 3`;
console.log('\nOrders with nothing refunded yet:');
console.table(orders);

const test = await sql`
  SELECT event_id, amount_cents, status, last_error
  FROM refund_ledger
  WHERE event_id LIKE 'overtest%'`;
if (test.length) {
  console.log('\nMy over-refund test rows:');
  console.table(test);

  const touched = await sql`
    SELECT order_id, captured_cents, refunded_cents
    FROM orders
    WHERE order_id IN (SELECT order_id FROM refund_ledger WHERE event_id LIKE 'overtest%')`;
  console.log('\nThe order they targeted:');
  console.table(touched);
}

const decisions = await sql`
  SELECT event_id, model_action, model_confidence, status, last_error, model_reasoning
  FROM refund_ledger
  WHERE event_id LIKE 'overtest%'`;
console.log('\nWhat the model decided on my test rows:');
for (const d of decisions) {
  console.log(`\n  ${d.event_id}`);
  console.log(`    model said:   ${d.model_action} (${d.model_confidence}%)`);
  console.log(`    final status: ${d.status}`);
  console.log(`    last_error:   ${d.last_error ?? '(none)'}`);
  console.log(`    reasoning:    ${d.model_reasoning}`);
}