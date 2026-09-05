# Decisions

Notes on how this works and why. Everything here matches the code in the repo.

**One word first.** "Model" means two things in this project. **The AI in my app**
is OpenAI, which decides each refund — that is what I mean below. **The AI
assistant I used while building** is a separate thing, covered in AI_USAGE.md.

---

## 1. How ingest is idempotent

"Idempotent" means doing it twice has the same result as doing it once. The same
event arriving three times must create one refund.

`event_id` is the **primary key** of `webhook_events`, so the database physically
refuses to store it twice. Ingest is one statement:

```sql
INSERT INTO webhook_events (...) VALUES (..., 'processing', now())
ON CONFLICT (event_id) DO UPDATE SET claimed_at = now()
WHERE webhook_events.status = 'processing'
  AND webhook_events.claimed_at < now() - interval '30 seconds'
RETURNING event_id
```

**Row back** = I own it, do the work. **Nothing back** = someone else has it, stop.

### Why not check first

My first instinct was `SELECT` then `INSERT`. That has a gap: two requests can
both read nothing and both insert. `ON CONFLICT` settles it inside **one
statement**, which cannot be interrupted, so there is no gap.

### Why not remember it in code

On Vercel each request runs on a new short-lived machine. Two copies of one event
can land on two machines that share no memory, so a `Set` of seen IDs would
usually be empty. It would pass on my laptop and fail in production. Shared truth
has to live in the database.

### The recovery half

The status is a lifecycle, not a label: `processing` while I work, `done` once the
change is applied.

My first version wrote the event and applied its change as two statements. A
function killed between them left the event marked seen with no refund created,
and my own deduplication then skipped the retry. **The refund was lost silently.**
Now a retry that finds a stale `processing` row takes it over. Safe because
everything in `handle()` is an upsert.

### Proof — three passes against the deployed URL

```
Pass 1  sequential          events 741 | ledger 239 | paid 77 | review 159 | total 530985
Pass 2  same file, no reset events 741 | ledger 239 | paid 77 | review 159 | total 530985
Pass 3  fresh, 8 workers    events 741 | ledger 239 | paid 78 | review 158 | total 500857
```

787 posts became 741 rows every time. The 46 difference is the duplicates in the
seed file. Pass 2's drain reported `processed 0, remaining 0` — nothing entered
the queue at all.

**`paid` and `total` differ in pass 3, and those two are not deterministic by
design.** Notify fails randomly 15% of the time as the brief requires, and model
confidence on a borderline refund can land either side of my 0.7 threshold. What
rules out a concurrency fault is check 3b: every order's stored total equals the
sum of its own refunded ledger rows, in all three runs.

Recorded in `fingerprints.json`.

---

## 2. Postgres connections on serverless

Databases allow a limited number of connections. Serverless starts a machine per
request, so a burst would try to open hundreds.

Two things. `DATABASE_URL` points at Neon's **pooled** endpoint (`-pooler` in the
hostname), which shares a few real connections between many callers. And I cache
**one** pool on `globalThis` with `max: 3`, so warm machines reuse it.

The direct, unpooled URL is used only for creating tables, which needs a plain
session the pooler does not provide.

---

## 3. Function timeouts

Vercel Hobby allows 300 seconds. I set `maxDuration = 300` on
`/api/workflow/tick` and left the webhook on its default, **because the webhook
does no slow work** — it writes rows and returns 202.

That split is the decision. With the AI call in the webhook, each of 787 posts
would take seconds instead of milliseconds. Instead the webhook is fast and a
separate endpoint does the thinking, 25 refunds per call, so one invocation cannot
approach the limit.

---

## 4. Why Postgres for some things and Mongo for others

**Postgres** holds orders, the refund ledger and workflow steps, because those need
rules the database enforces and rows it can lock:

- `UNIQUE (event_id)` — one event, one ledger entry
- `CHECK (refunded_cents <= captured_cents)` — an over-refunded row cannot be saved
- a row lock on `orders` — two refunds for one order queue up instead of racing

**Mongo** holds the policy documents and conversation history. Policies are
free-form — a regional policy has a `regions` field, a superseded one has
`effective_to` — searched by relevance, versioned by adding a document rather than
migrating a schema.

Conversation history records the facts I sent the model, the policies supplied,
the reply, and any agent action, so a decision can be audited after it leaves the
queue. Writes are best-effort: losing an audit record is bad, failing a refund
because the audit log was down is worse.

---

## 5. How a failed notification cannot pay twice

The payment step only acts on `status = 'approved'` and moves it to `refunded` in
the same statement:

```sql
WITH claim AS (
  UPDATE refund_ledger SET status='refunded', refunded_at=now()
  WHERE id = $1 AND status = 'approved'
  RETURNING order_id, amount_cents
)
UPDATE orders o SET refunded_cents = o.refunded_cents + c.amount_cents
FROM claim c WHERE o.order_id = c.order_id
```

One statement, so it is all-or-nothing and needs no transaction. If someone
already claimed the refund, the `WITH` matches nothing, the `UPDATE` gets no rows,
and **no money moves.**

Notify fails 15% of the time on purpose. The retry comes back through this step,
finds `refunded`, and does nothing — only the notification is retried. After 6
attempts I mark `notify_state='failed'` and the refund stands. The Decided tab
shows "Paid, but the customer notification never sent".

The whole payment block is also wrapped in `if (r.status !== 'refunded')`, so a
refund returning only to retry its notification never re-enters it.

### Two partials cannot overshoot

Both update the same `orders` row, so Postgres serialises them on the row lock.
The second reads what the first wrote. If the total would exceed the capture, the
`CHECK` aborts the whole statement — undoing the claim too, since it is one
statement. Postgres returns error **23514**, caught in `issueRefund`.

I tested this deliberately, because the seed file's partials always sum to exactly
the total and never push the limit. `scripts/race-test.mjs` bypasses my
application-level check on purpose and fires two ticks in parallel: one refunded,
one rejected, total stayed at 10396 against 14852 captured.

---

## 6. Keeping the outdated policy out, and my real number

16 documents, 14 active. Two are deliberately old — a 2023 policy saying 30 days
beside the 2026 one saying 45, and an older goodwill limit — both marked
`status: 'superseded'`.

Retrieval filters `status: 'active'` **before** searching, so the old document is
never a candidate and can never be cited. I chose a filter over telling the model
"prefer the newer one" because **a model can ignore an instruction; it cannot cite
a document it never saw.** I also drop any policy ID it returns that I did not
supply.

### The numbers

`findPolicies` returns up to 4 from the text search plus 2 always-included money
policies, so 5–6 documents reach the model. Measuring only the top 3 would
describe a query I do not run, so I report both.

| | Result |
|---|---|
| Hit rate@3 | 13/15 = 0.87 |
| Mean recall@3 | 0.87 |
| Precision@3 | 0.31 |
| MRR@3 | 0.80 |
| Full-list hit rate | 14/15 = 0.93 |
| Superseded returned | **0** |

Precision@3 of 0.31 is near its ceiling: most questions have one correct document
and I return three slots, so the best possible is about 0.33.

### The two misses — same underlying cause

**"The refund is 400 dollars, can it be approved automatically?"** ranks
`POL-ESCALATION-THRESHOLD` fourth, because text search does not connect "400
dollars" to a policy written in minor units. **It still reaches the model**,
because I always include the two money-limit policies — exactly what that rule is
for.

**"A customer in Germany wants to cancel"** misses `POL-EU-WITHDRAWAL` entirely.
Two reasons: my region comes from currency, and the question has none, so it
defaults to US. And the document says "European Union", not "Germany".

Both are the same weakness: **keyword search matches words, not meaning.** Mongo
stems words but has no synonyms. Adding country names to the tags would fix the
second, but embeddings would fix the class of problem — that is what I would move
to. I would rather report 13/15 with an explanation than tune the corpus against
my own test set.

### The measurement itself was wrong first

The script originally re-implemented the Mongo query instead of calling
`findPolicies()`, so it measured something close to my app, not my app. And what I
called "recall" was really a hit rate. Both fixed. **Measuring the real thing gave
me a worse number, and that is the point.**

Script: `scripts/eval-retrieval.ts`.

---

## 7. What a review pass found after the tests passed

All checks were green before I wrote this. I then read the code against the brief
and found six things **the tests could not catch**, because nothing had visibly
gone wrong.

1. **The webhook was not atomic** — described in section 1. A refund could be lost
   if a function died mid-request.
2. **The model had no dates or shipping.** My policies say "within 45 days of the
   order date" and "refund the shipping charge"; my prompt sent neither. Its
   "review, the policies do not establish this" answers were correct complaints
   about my prompt. 158 of 239 refunds were sitting in review because of it.
3. **My decide endpoint approved anything that was not "reject".** No validation on
   a public endpoint that moves money. Now checked with Zod, and both branches
   return 409 if the refund already moved.
4. **Late orders could not recover.** My wake-up only revived `waiting_for_order`,
   not `given_up`. The replay passed only because the seed file shuffles events by
   at most 15 positions — luck about the test data, not a property of my system.
5. **My replay script threw away failed posts** with `.catch(() => {})`. If 200 had
   failed I would have hunted a phantom bug. Silently discarding errors during the
   test that proves correctness defeats the test.
6. **A double payment I introduced while fixing #4's neighbour.** Adding worker
   ownership, I replaced a guarded status update with a plain one. A refund that
   was already `refunded` and returned only to retry its notification was set back
   to `approved` and paid again. **Thirteen orders were affected.** My old verify
   compared totals, and totals can match while the wrong rows are present — the
   rewritten check 3b compares each order to the sum of its own ledger rows and
   caught it immediately.

Number 6 is the one worth dwelling on: **tightening one guard loosened another**,
and I only saw it because I had improved the thing that looks at the same time.

---

## 8. What the fixes changed

Review went from 158 to 158, which looks like nothing. The breakdown shows
otherwise:

```
Before:  158 all model_action = 'review'
After:   120 review · 38 reject · 78 approve (was 64) · 3 given_up
```

Sending dates and shipping moved 38 refunds out of "I cannot determine this" into
a definite answer. The headline did not move because a second change pushed back:
a model `reject` now goes to a human rather than being refused automatically, as
the brief requires. Turning down a customer's money is worth a person seeing.

The one exception is the arithmetic check in `lib/llm.ts` — a refund larger than
the remaining balance is rejected outright, because that is a fact, not a
judgement.

---

## 9. What I would do with more time

- Move the drain loop onto a real queue instead of a `/tick` endpoint that
  something has to call.
- Use embeddings for retrieval instead of keyword search, which would fix the
  Germany miss and the class of problem behind it.
- Add a currency field to the refund payload and check it against the order. I
  have `POL-CURRENCY-HANDLING`; I do not have the check.
- Handle `order.paid` arriving with a *lower* amount than already refunded — right
  now the `CHECK` rejects it and the event fails rather than being dead-lettered
  with a clear reason.
- Show the stored conversation history in the console. It is written to Mongo but
  there is no screen for it.
- Automate the acceptance checks so they run on every push.

## What I cut

- **Exponential backoff.** Flat 5-second retries with per-reason attempt caps.
- **A durable job queue.** `/tick` plus a drain loop is a stand-in and I am clear
  about that.
- **Interface polish.** The brief said a dense table beats a landing page.

---

## Smaller notes

**Money is whole cents in a `bigint`, never a decimal.** `19.99 * 100` can be
1998.9999999999998 in JavaScript; truncating loses a cent. I use `Math.round`. The
same trap returned with sorting, because Postgres `bigint` arrives as a **string**
and sorting text puts "9" after "10".

**Two kinds of broken event, handled oppositely.** `"NaN"` with no order ID can
never become valid, so it is rejected once and never retried. `ord_9999` looks
valid — an order arriving later is normal — so it is parked, retried a bounded
number of times, and revived if the order turns up. Rejecting the second kind
immediately fails check 2; retrying forever fails check 4.

**Retry counters are split.** `order_wait_attempts` and `notify_attempts` have
separate caps, plus an overall `attempts` as a hard stop. Sharing one number meant
a refund that waited three times for its order had three fewer notification
attempts. My final run shows the three orphans at `order_wait_attempts 6` and
`notify_attempts 0` — exactly the distinction the split was for.

**One AI provider, but the structure would take another.** `askOpenAI()` is the
only function that talks to a model API. Every safety rule lives outside it in
`applySafetyRules()` and `fallbackToHuman()`, so swapping means replacing one
function and none of the protection moves. I removed an earlier Claude path
because I had never installed the package or run that code.

**`lib/policy.ts` imports `'./mongo.ts'` with the extension**, unlike the other
files. That is deliberate: `scripts/eval-retrieval.ts` imports it directly through
Node's TypeScript support, which needs explicit extensions. It lets my evaluation
measure the real production function instead of a copy.

**Migrations are simple on purpose.** `migrate.mjs` re-runs the whole schema every
time and relies on every statement being repeatable —
`CREATE TABLE IF NOT EXISTS` plus `ALTER TABLE ADD COLUMN IF NOT EXISTS`. A real
project would track which migrations have run. Fine at this scale.

**Both replay scripts are here.** `scripts/replay.sh` matches the method in the
brief. I develop on Windows where PowerShell cannot run bash, so `replay.mjs` does
the same thing in Node and also drains the workflow queue.