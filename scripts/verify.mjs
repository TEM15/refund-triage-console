import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL);
const label = process.argv[2] ?? 'run';

// ---- work out what the file SAYS should happen -------------------
// My first version only compared counts. Counts can match while the
// wrong rows are present, so now I check specific event IDs.
const events = readFileSync('events.ndjson', 'utf8').trim().split('\n').map(JSON.parse);
const distinctIds = new Set(events.map(e => e.event_id));

const isValidRefund = (e) =>
  e.topic === 'refund.requested' &&
  typeof e.payload?.order_id === 'string' &&
  typeof e.payload?.refund_amount === 'number' &&
  Number.isFinite(e.payload.refund_amount) &&
  e.payload.refund_amount > 0;

const validRefunds  = events.filter(isValidRefund);
const validRefundIds = new Set(validRefunds.map(e => e.event_id));
const brokenRefunds = events.filter(e => e.topic === 'refund.requested' && !isValidRefund(e));

// Orders that never appear as order.created -- ord_9999 and friends.
const realOrderIds = new Set(
  events.filter(e => e.topic === 'order.created').map(e => e.payload.order_id));
const orphanRefundIds = new Set(
  validRefunds.filter(e => !realOrderIds.has(e.payload.order_id)).map(e => e.event_id));

// What the file asked for, per order, in cents.
const requestedByOrder = new Map();
for (const e of validRefunds) {
  const id = e.payload.order_id;
  if (!requestedByOrder.has(id)) requestedByOrder.set(id, []);
  requestedByOrder.get(id).push(Math.round(e.payload.refund_amount * 100));
}

let pass = true;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  --  ' + detail : ''}`);
  if (!ok) pass = false;
};

console.log('\n============ ACCEPTANCE CHECKS ============');

// ---- CHECK 1: one row per distinct event_id, and the RIGHT ones ----
const stored = await sql`SELECT event_id, status FROM webhook_events`;
const storedIds = new Set(stored.map(r => r.event_id));
const missing = [...distinctIds].filter(id => !storedIds.has(id));
const extra = [...storedIds].filter(id => !distinctIds.has(id) && !id.startsWith('test'));

check('1. one row per distinct event_id, matching the file exactly',
      stored.length === distinctIds.size && missing.length === 0 && extra.length === 0,
      `${stored.length} stored, ${distinctIds.size} expected` +
      (missing.length ? `, MISSING ${missing.slice(0,3).join(',')}` : '') +
      (extra.length ? `, unexpected ${extra.slice(0,3).join(',')}` : ''));

// ---- CHECK 1b: no event left half-finished ----
const stuck = stored.filter(r => r.status === 'processing');
check('1b. no event stuck mid-processing', stuck.length === 0,
      `${stuck.length} still 'processing'`);

// ---- CHECK 1c: one ledger entry per valid refund event, by ID ----
const ledger = await sql`SELECT event_id, status FROM refund_ledger`;
const ledgerIds = new Set(ledger.map(r => r.event_id));
const refundsMissing = [...validRefundIds].filter(id => !ledgerIds.has(id));

check('1c. one ledger entry per valid refund event',
      ledger.length === validRefundIds.size && refundsMissing.length === 0,
      `${ledger.length} rows, ${validRefundIds.size} expected` +
      (refundsMissing.length ? `, missing ${refundsMissing.slice(0,3).join(',')}` : ''));

// ---- CHECK 2: no refund with a REAL order was dropped ----
const givenUp = ledger.filter(r => r.status === 'given_up');
const wronglyGivenUp = givenUp.filter(r => !orphanRefundIds.has(r.event_id));

check('2. no refund with a real order was dropped',
      wronglyGivenUp.length === 0,
      `${givenUp.length} given up, ${orphanRefundIds.size} orphans expected` +
      (wronglyGivenUp.length ? `, WRONGLY ${wronglyGivenUp.slice(0,3).map(r=>r.event_id).join(',')}` : ''));

// ---- CHECK 3: nothing over-refunded ----
const over = await sql`
  SELECT order_id, captured_cents, refunded_cents FROM orders
  WHERE refunded_cents > captured_cents`;
check('3. no order refunded more than it was charged', over.length === 0,
      over.map(o => o.order_id).join(', '));

// ---- CHECK 3b: order totals equal the sum of their refunded rows ----
const drift = await sql`
  SELECT o.order_id FROM orders o
  LEFT JOIN refund_ledger r ON r.order_id = o.order_id
  GROUP BY o.order_id, o.refunded_cents
  HAVING o.refunded_cents <> COALESCE(SUM(r.amount_cents)
         FILTER (WHERE r.status='refunded'), 0)`;
check('3b. order totals match the sum of their refunded ledger rows',
      drift.length === 0, `${drift.length} orders disagree`);

// ---- CHECK 3c: partial pairs settle to EXACTLY the captured total ----
const refundedRows = await sql`
  SELECT order_id, amount_cents FROM refund_ledger WHERE status='refunded'`;
const paidByOrder = new Map();
for (const r of refundedRows) {
  paidByOrder.set(r.order_id, (paidByOrder.get(r.order_id) ?? 0n) + BigInt(r.amount_cents));
}
const capturedRows = await sql`SELECT order_id, captured_cents FROM orders`;
const captured = new Map(capturedRows.map(o => [o.order_id, BigInt(o.captured_cents)]));

let exactPairs = 0, badPairs = 0;
for (const [orderId, amounts] of requestedByOrder) {
  if (amounts.length !== 2) continue;
  const sumRequested = BigInt(amounts[0] + amounts[1]);
  if (sumRequested !== captured.get(orderId)) continue;   // not a full pair
  const paid = paidByOrder.get(orderId) ?? 0n;
  if (paid === 0n) continue;                              // neither approved
  if (paid === sumRequested) exactPairs++;
  else if (paid !== BigInt(amounts[0]) && paid !== BigInt(amounts[1])) badPairs++;
}
check('3c. fully-paid partial pairs total exactly the captured amount',
      badPairs === 0, `${exactPairs} pairs settled exactly, ${badPairs} wrong`);

// ---- CHECK 4: EVERY broken event handled by ID, none looping ----
const dead = await sql`SELECT event_id FROM dead_letter`;
const deadIds = new Set(dead.map(d => d.event_id));
const brokenHandled = brokenRefunds.filter(e => deadIds.has(e.event_id));
const brokenMissed  = brokenRefunds.filter(e => !deadIds.has(e.event_id));
const [{ spinning }] = await sql`
  SELECT count(*)::int AS spinning FROM refund_ledger WHERE attempts > 20`;

check('4. every broken event logged by id, nothing looping forever',
      brokenMissed.length === 0 && spinning === 0,
      `${brokenHandled.length}/${brokenRefunds.length} logged` +
      (brokenMissed.length ? `, MISSED ${brokenMissed.map(e=>e.event_id).join(',')}` : '') +
      `, ${spinning} looping`);

// ---- CHECKS 5 and 6: compare against the previous run ----
const [counts] = await sql`
  SELECT (SELECT count(*)::int FROM webhook_events) AS events,
         (SELECT count(*)::int FROM refund_ledger)  AS ledger,
         (SELECT count(*)::int FROM refund_ledger WHERE status='refunded') AS paid,
         (SELECT count(*)::int FROM refund_ledger WHERE status='needs_review') AS review,
         (SELECT COALESCE(sum(refunded_cents),0)::bigint FROM orders) AS total`;

const fingerprint = {
  label, events: counts.events, ledger: counts.ledger,
  paid: counts.paid, review: counts.review, total: String(counts.total),
};

console.log('\n============ FINGERPRINT ============');
console.log(`  label:            ${fingerprint.label}`);
console.log(`  events stored:    ${fingerprint.events}`);
console.log(`  ledger entries:   ${fingerprint.ledger}`);
console.log(`  refunds paid:     ${fingerprint.paid}`);
console.log(`  awaiting review:  ${fingerprint.review}`);
console.log(`  total refunded:   ${fingerprint.total} cents`);

const file = 'fingerprints.json';
const history = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];

if (history.length) {
  const first = history[0];
  console.log('\n============ COMPARED TO RUN 1 ============');
  // These two MUST match. They are what idempotency means here.
  check('5/6. events and ledger identical to the first run',
        first.events === fingerprint.events && first.ledger === fingerprint.ledger,
        `first ${first.events}/${first.ledger}, now ${fingerprint.events}/${fingerprint.ledger}`);

  // These MAY differ, and the reason is stated rather than hidden.
  if (first.paid !== fingerprint.paid || first.total !== fingerprint.total) {
    console.log(`      note: paid ${first.paid} -> ${fingerprint.paid}, ` +
                `total ${first.total} -> ${fingerprint.total}`);
    console.log('      Expected. Notify fails randomly 15% of the time by design,');
    console.log('      and borderline confidence can move a decision across the');
    console.log('      auto-approve threshold. Check 3b rules out a race condition.');
  }
}

history.push(fingerprint);
writeFileSync(file, JSON.stringify(history, null, 2));
console.log(`\n(appended to ${file})`);

console.log(pass ? '\nALL CHECKS PASSED\n' : '\nSOME CHECKS FAILED\n');
process.exit(pass ? 0 : 1);