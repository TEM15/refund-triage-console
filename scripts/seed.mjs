import { writeFileSync } from 'node:fs';
let s = 42;
const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >> 17;
s ^= s << 5; s >>>= 0; return s / 4294967296; };
const int = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const pick = (a) => a[Math.floor(rnd() * a.length)];
const T0 = Date.parse('2026-07-01T00:00:00Z');
const events = [];
let n = 0;
const eid = () => `evt_${String(++n).padStart(5, "0")}`;
for (let i = 0; i < 250; i++) {
const id = `ord_${1000 + i}`;
const sub = int(899, 24999), ship = pick([0, 499, 995]);
const tax = Math.round((sub + ship) * pick([0.0825, 0.2, 0.07]));
const total = sub + ship + tax, cur = pick(['USD', 'USD', 'EUR', 'GBP']);
let t = T0 + i * 60000;
events.push({ event_id: eid(), topic: 'order.created',
occurred_at: new Date(t).toISOString(),
payload: { order_id: id, currency: cur, subtotal: sub / 100,
shipping: ship / 100, tax: tax / 100 } });
t += int(30000, 900000);
events.push({ event_id: eid(), topic: 'order.paid',
occurred_at: new Date(t).toISOString(),
payload: { order_id: id, amount: total / 100, currency: cur } });
const roll = rnd();
const reqs = roll < 0.35 ? [total]
: roll < 0.6 ? [Math.floor(total / 3), total - Math.floor(total / 3)]
: roll < 0.7 ? [Math.floor(total / 3)] : [];
for (const c of reqs) {
t += int(1, 12) * 3600000;
const e = { event_id: eid(), topic: 'refund.requested',
occurred_at: new Date(t).toISOString(),
payload: { order_id: id, refund_amount: c / 100,
reason: pick(['damaged', 'missing_item', 'late']) } };
events.push(e);
if (rnd() < 0.2) events.push({ ...e });
}
}
for (let k = 0; k < 5; k++) events.push({ event_id: eid(),
topic: 'refund.requested', occurred_at: new Date(T0).toISOString(),
payload: k % 2 ? { refund_amount: 'NaN' }
: { order_id: 'ord_9999', refund_amount: 5 } });
for (let i = 0; i < events.length; i++) if (rnd() < 0.12) {
const j = Math.min(events.length - 1, i + int(1, 15));
[events[i], events[j]] = [events[j], events[i]];
}
writeFileSync('events.ndjson',
events.map((e) => JSON.stringify(e)).join('\n'));
console.log(`${events.length} events`);