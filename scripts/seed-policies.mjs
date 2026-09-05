import { MongoClient } from 'mongodb';

// ---------------------------------------------------------------
// I keep every policy in one Mongo collection. Each document has a
// "status" field of either 'active' or 'superseded'.
//
// The assessment requires an outdated policy that contradicts the
// current one, and requires that both stay in the collection. Mine
// are POL-RETURN-WINDOW version 1 (2023, thirty days) and version 2
// (2026, forty five days). Both are stored. Only version 2 is active.
// ---------------------------------------------------------------

const policies = [
  {
    policy_id: 'POL-RETURN-WINDOW', version: 2, status: 'active',
    effective_from: '2026-01-01', category: 'return_window',
    title: 'Standard return window (current)',
    body: 'Customers may request a refund within 45 days of the order date. ' +
          'Requests made after 45 days are not eligible for an automatic refund ' +
          'and must be sent to an agent for review.',
    tags: ['return', 'window', '45 days', 'eligibility', 'time limit'],
  },
  {
    // ---- THE TRAP. This is the outdated policy the assessment asks for. ----
    // It stays in the collection but it is marked superseded, and my
    // retrieval query filters on status:'active' before it searches,
    // so this document can never be returned and never be cited.
    policy_id: 'POL-RETURN-WINDOW', version: 1, status: 'superseded',
    effective_from: '2023-01-01', effective_to: '2025-12-31',
    category: 'return_window',
    title: 'Standard return window (2023, no longer in force)',
    body: 'Customers may request a refund within 30 days of the order date. ' +
          'Requests after 30 days are not eligible.',
    tags: ['return', 'window', '30 days', 'eligibility', 'time limit'],
  },
  {
    policy_id: 'POL-DAMAGED-GOODS', version: 1, status: 'active',
    effective_from: '2026-01-01', category: 'damage',
    title: 'Damaged goods',
    body: 'If an item arrives damaged, refund the full amount paid for that item ' +
          'including shipping. The normal return window does not apply to damaged ' +
          'goods. No photographic evidence is required below 200.00 in any currency.',
    tags: ['damaged', 'broken', 'damage', 'full refund', 'shipping',
       'smashed', 'crushed', 'dented', 'cracked', 'arrived broken',
       'parcel', 'package', 'defective'],
  },
  {
    policy_id: 'POL-MISSING-ITEM', version: 1, status: 'active',
    effective_from: '2026-01-01', category: 'missing',
    title: 'Missing items',
    body: 'If an item is missing from a delivered order, refund the value of the ' +
          'missing item. If the whole order is missing, refund the full amount ' +
          'including shipping and tax.',
    tags: ['missing_item', 'missing', 'not delivered', 'partial'],
  },
  {
    policy_id: 'POL-LATE-DELIVERY', version: 1, status: 'active',
    effective_from: '2026-01-01', category: 'late',
    title: 'Late delivery',
    body: 'If a delivery arrives after its promised date, refund the shipping cost. ' +
          'A goodwill credit may also be offered but it must stay within the ' +
          'goodwill limit. Late delivery alone does not justify refunding the ' +
          'full order value.',
    tags: ['late', 'delayed', 'shipping refund', 'goodwill'],
  },
  {
    policy_id: 'POL-EU-WITHDRAWAL', version: 1, status: 'active',
    effective_from: '2026-01-01', category: 'regional', regions: ['EU'],
    title: 'EU right of withdrawal',
    body: 'Customers in the European Union have a statutory right to withdraw from ' +
          'a purchase within 14 days of delivery for any reason, with no explanation ' +
          'needed. This right is in addition to our standard return window, and ' +
          'whichever is more generous applies. Applies to orders in EUR.',
    tags: ['EU', 'europe', 'withdrawal', '14 days', 'EUR', 'statutory'],
  },
  {
    policy_id: 'POL-UK-CONSUMER-RIGHTS', version: 1, status: 'active',
    effective_from: '2026-01-01', category: 'regional', regions: ['UK'],
    title: 'UK short-term right to reject',
    body: 'Customers in the United Kingdom have 30 days from delivery to reject ' +
          'faulty goods and receive a full refund under the Consumer Rights Act. ' +
          'This applies on top of our standard return window. Applies to orders in GBP.',
    tags: ['UK', 'britain', 'reject', '30 days', 'GBP', 'faulty', 'statutory'],
  },
  {
    policy_id: 'POL-US-BASELINE', version: 1, status: 'active',
    effective_from: '2026-01-01', category: 'regional', regions: ['US'],
    title: 'United States baseline',
    body: 'For orders in USD our standard return window and damage rules apply. ' +
          'There is no additional federal right of withdrawal in the United States, ' +
          'so the company policy is the only rule that applies.',
    tags: ['US', 'USA', 'united states', 'USD', 'baseline'],
  },
  {
    policy_id: 'POL-PARTIAL-REFUND', version: 1, status: 'active',
    effective_from: '2026-01-01', category: 'money',
    title: 'Partial refunds',
    body: 'An order may be refunded in more than one part. The total of all refunds ' +
          'for an order must never be more than the amount captured from the ' +
          'customer. If a request would take the total over the captured amount, ' +
          'reject it.',
    tags: ['partial', 'multiple refunds', 'captured', 'limit', 'total'],
  },
  {
    policy_id: 'POL-GOODWILL-LIMIT', version: 2, status: 'active',
    effective_from: '2026-01-01', category: 'money',
    title: 'Goodwill limit (current)',
    body: 'A goodwill credit given on top of a legitimate refund must not be more ' +
          'than 20.00 in the order currency. Anything larger needs a manager and ' +
          'must go to review.',
    tags: ['goodwill', 'credit', 'limit', 'gesture'],
  },
  {
    // ---- A second superseded document, to show the mechanism is general. ----
    policy_id: 'POL-GOODWILL-LIMIT', version: 1, status: 'superseded',
    effective_from: '2024-01-01', effective_to: '2025-12-31', category: 'money',
    title: 'Goodwill limit (2024, no longer in force)',
    body: 'A goodwill credit must not be more than 50.00 in the order currency.',
    tags: ['goodwill', 'credit', 'limit', 'gesture'],
  },
  {
    policy_id: 'POL-ESCALATION-THRESHOLD', version: 1, status: 'active',
    effective_from: '2026-01-01', category: 'escalation',
    title: 'Escalation threshold',
    body: 'Any single refund of 150.00 or more in the order currency must be sent ' +
          'to an agent for review and must never be approved automatically, ' +
          'whatever the reason given.',
    tags: ['escalation', 'threshold', 'review', 'large refund', 'manual'],
  },
  {
    policy_id: 'POL-DUPLICATE-CHARGE', version: 1, status: 'active',
    effective_from: '2026-01-01', category: 'escalation',
    title: 'Duplicate charges',
    body: 'If a customer was charged twice for the same order, refund the duplicate ' +
          'charge in full immediately. This is always approved automatically and is ' +
          'not limited by the return window.',
    tags: ['duplicate', 'double charge', 'billing error', 'automatic'],
  },
  {
    policy_id: 'POL-FRAUD-HOLD', version: 1, status: 'active',
    effective_from: '2026-01-01', category: 'escalation',
    title: 'Suspected fraud',
    body: 'If an order has been flagged for suspected fraud, no refund may be issued ' +
          'automatically. Send it to review regardless of the amount or the reason.',
    tags: ['fraud', 'flagged', 'suspicious', 'hold', 'review'],
  },
  {
    policy_id: 'POL-SHIPPING-REFUND', version: 1, status: 'active',
    effective_from: '2026-01-01', category: 'money',
    title: 'Shipping charges',
    body: 'Shipping is refunded when the fault is ours: damaged goods, missing items ' +
          'or late delivery. Shipping is not refunded when the customer simply ' +
          'changed their mind.',
    tags: ['shipping', 'postage', 'delivery cost', 'refundable'],
  },
  {
    policy_id: 'POL-CURRENCY-HANDLING', version: 1, status: 'active',
    effective_from: '2026-01-01', category: 'money',
    title: 'Refund currency',
    body: 'A refund must be issued in the same currency the customer was charged in. ' +
          'Never convert between currencies when refunding, because exchange rate ' +
          'movement would mean refunding a different amount from the one captured.',
    tags: ['currency', 'USD', 'EUR', 'GBP', 'conversion', 'exchange',
       'dollar', 'dollars', 'euro', 'euros', 'pound', 'pounds',
       'convert', 'foreign'],
  },
];

const client = await new MongoClient(process.env.MONGODB_URI).connect();
const col = client.db(process.env.MONGODB_DB).collection('policies');

await col.deleteMany({});
await col.insertMany(policies);

// A text index lets Mongo score documents by how well their words
// match a search phrase. I index title, body and tags together.
await col.createIndex({ title: 'text', body: 'text', tags: 'text' });
await col.createIndex({ status: 1, policy_id: 1 });

console.log(`inserted ${policies.length} policies`);
console.log(`active: ${policies.filter(p => p.status === 'active').length}`);
console.log(`superseded: ${policies.filter(p => p.status === 'superseded').length}`);

// Conversation history lives in Mongo alongside the policies. Indexing by refund_id so an audit lookup is fast.
await client.db(process.env.MONGODB_DB)
  .collection('conversations')
  .createIndex({ refund_id: 1, created_at: 1 });
console.log('conversation history index ready');

await client.close();