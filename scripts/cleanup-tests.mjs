import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.DATABASE_URL);

// I remove my manual test rows and put the orders they touched back
// to zero, so the reconciliation view only shows real replay data.
const ids = await sql`
  SELECT id, order_id, amount_cents, status FROM refund_ledger
  WHERE event_id LIKE 'overtest%' OR event_id LIKE 'racetest%'`;

for (const r of ids) {
  if (r.status === 'refunded') {
    await sql`UPDATE orders SET refunded_cents = refunded_cents - ${r.amount_cents}
              WHERE order_id = ${r.order_id}`;
  }
}
await sql`DELETE FROM workflow_steps WHERE refund_id IN (SELECT id FROM refund_ledger
          WHERE event_id LIKE 'overtest%' OR event_id LIKE 'racetest%')`;
await sql`DELETE FROM refund_ledger WHERE event_id LIKE 'overtest%' OR event_id LIKE 'racetest%'`;
await sql`DELETE FROM webhook_events WHERE event_id LIKE 'overtest%' OR event_id LIKE 'racetest%'`;
console.log('test rows removed');