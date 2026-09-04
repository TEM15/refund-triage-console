import { neon } from '@neondatabase/serverless';

// I wrote this because my first over-refund test was caught by the
// arithmetic check in my llm layer, which meant the database
// constraint never actually ran. To test the constraint I need two
// refunds approved at the same moment, both seeing a zero balance.
const url = process.argv[2];
const sql = neon(process.env.DATABASE_URL);

// A fresh order with nothing refunded against it.
const [order] = await sql`
  SELECT order_id, captured_cents FROM orders
  WHERE refunded_cents = 0 AND captured_cents > 2000 LIMIT 1`;

const cents = Number(order.captured_cents);
const each = Math.floor(cents * 0.7) / 100;   // 70% each, so two of them overshoot
console.log(`Target: ${order.order_id}, charged ${cents} cents. Sending 2 x $${each}`);

// Send both refund requests.
for (const id of ['racetest_a', 'racetest_b']) {
  await fetch(`${url}/api/webhooks/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      event_id: id, topic: 'refund.requested',
      occurred_at: '2026-07-01T00:00:00Z',
      payload: { order_id: order.order_id, refund_amount: each, reason: 'damaged' },
    }),
  });
}

// I force both to 'approved' directly, skipping the model. That is the
// point: I am deliberately bypassing my own first line of defence so
// that the database is the only thing left standing.
await sql`
  UPDATE refund_ledger SET status='approved', model_action='approve',
         model_confidence=99, next_try_at=now()
  WHERE event_id IN ('racetest_a','racetest_b')`;

// Fire two tick requests at the same instant, in parallel.
console.log('Firing two workflow ticks simultaneously...');
await Promise.all([
  fetch(`${url}/api/workflow/tick?limit=5`, { method: 'POST' }),
  fetch(`${url}/api/workflow/tick?limit=5`, { method: 'POST' }),
]);

await new Promise(r => setTimeout(r, 3000));

console.table(await sql`
  SELECT event_id, amount_cents, status, last_error
  FROM refund_ledger WHERE event_id LIKE 'racetest%'`);
console.table(await sql`
  SELECT order_id, captured_cents, refunded_cents
  FROM orders WHERE order_id = ${order.order_id}`);