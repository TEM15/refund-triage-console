# Refund Triage Console

An internal tool that replaces manual refund handling. It receives order events,
retrieves the relevant policies, asks a model to decide, pays each refund exactly
once, and queues anything it will not approve on its own for a human.

Refunds and notifications are simulated. Issuing a refund updates PostgreSQL; no
money moves and no customer is messaged.

- **Live app:** https://refund-triage-console.vercel.app
- **Repository:** https://github.com/TEM15/refund-triage-console
- **[DECISIONS.md](DECISIONS.md)** — why it works this way, and what a review pass
  found after the tests were already passing
- **[AI_USAGE.md](AI_USAGE.md)** — how AI tools were used, including where they
  were wrong

**On time:** the PDF specifies a four-hour budget; the email allowed 48 hours. I
used more than four.

---

## Architecture

| Layer | Implementation |
|---|---|
| App and API | Next.js 16 App Router, route handlers only |
| Interface | React, Tailwind, shadcn/ui on Base UI |
| Relational store | PostgreSQL on Neon |
| Document store | MongoDB Atlas |
| Model | OpenAI, model ID supplied by configuration |
| Hosting | Vercel |

`POST /api/webhooks/orders` records and applies one event per request.
`POST /api/workflow/tick` claims due refunds and runs **load order → retrieve
policies → decide → issue refund → notify**. The console reads
`GET /api/console`; agents act through `POST /api/console/decide`.

PostgreSQL holds orders, event records, the refund ledger, workflow steps and dead
letters. MongoDB holds the policy documents and conversation history.

---

## Part A — Deploying your own copy

About 20 minutes, mostly waiting for free accounts. Everything below is free tier.

### 1. Get the code

```bash
git clone https://github.com/TEM15/refund-triage-console.git
cd refund-triage-console
npm ci
```

**Node.js 22.6 or newer.** The evaluation script runs TypeScript directly through
Node's type stripping, which Node 20 cannot do. Node 24 is what I used.

### 2. PostgreSQL on Neon

Sign up at **neon.com** and create a project. On the dashboard open **Connect**.

Click **Show password** first — otherwise you copy a masked string that fails to
connect.

Copy the string **twice**: once with connection pooling **on** (this is
`DATABASE_URL`, the hostname contains `-pooler`) and once **off** (this is
`DATABASE_URL_UNPOOLED`).

> The pooled endpoint shares a few real connections between many callers, which is
> what stops a burst of webhooks exhausting the limit. The direct one is used only
> for creating tables, which needs a plain session the pooler does not provide.

### 3. MongoDB on Atlas

Sign up, create a deployment, choose the **M0 (Free)** tier.

**Copy the generated password immediately** — it is shown once.

**Then do this, or nothing will work when deployed:** left sidebar →
**Security → Network Access → + ADD IP ADDRESS → ALLOW ACCESS FROM ANYWHERE**
(`0.0.0.0/0`) → Confirm. Wait for **Active**. Vercel's addresses change constantly,
so there is nothing narrower to allow.

Then **Database → Connect → Drivers → Node.js**, copy the string, and replace
`<db_password>` with the real password.

### 4. OpenAI

Add credit before creating a key, or it returns errors. Then create a key.

For `OPENAI_MODEL`, take a current ID from
**platform.openai.com/docs/models** — the model must support
`response_format: { type: 'json_schema', strict: true }`. IDs are retired every
few months, so take it from that page rather than from any guide.

### 5. Environment variables

Create `.env.local` locally:

```dotenv
DATABASE_URL="your Neon pooled string"
DATABASE_URL_UNPOOLED="your Neon direct string"
MONGODB_URI="your Atlas string with the real password"
MONGODB_DB="refund_triage"
OPENAI_API_KEY="sk-..."
OPENAI_MODEL="your model id"
```

`.env*` is gitignored — keep credentials out of the repository.

### 6. Deploy

Import the repository into Vercel as a Next.js project. Add the same six variables
under **Settings → Environment Variables**, pasting values **without quotes** —
those belong to the file format, not the value. Tick Production, Preview and
Development.

**Then redeploy.** Variables are read at build time, so the running deployment
does not see them until it is rebuilt: **Deployments → ⋯ → Redeploy**.

### 7. Set up the data

```bash
npm run migrate     # apply db/schema.sql
npm run policies    # load 16 policy documents, create indexes
```

`npm run policies` reports `active: 14, superseded: 2`. The two superseded ones are
the deliberately outdated policies the brief requires; retrieval filters them out.

### 8. Confirm

Vercel → Deployments → newest → build log should end with six routes, four marked
`ƒ`. Then:

```bash
curl -X POST "https://YOUR-APP.vercel.app/api/webhooks/orders" \
  -H 'content-type: application/json' \
  -d '{"event_id":"test_1","topic":"order.paid","occurred_at":"2026-07-01T00:00:00Z","payload":{"order_id":"ord_test","amount":100.50,"currency":"USD"}}'
```

Expect `{"status":"accepted"}`. **Run it again** — you should get
`{"status":"duplicate"}`. That is the idempotency gate.

---

## Part B — Running locally

```bash
npm run migrate
npm run policies
npm run dev
```

Open http://localhost:3000. Leave that terminal running; use a second one for
scripts.

For a production build locally:

```bash
npx tsc --noEmit
npm run build
npm run start
```

---

## Part C — Reproducing the recorded passes

**These commands empty the database.** `npm run reset` truncates the five
application tables and restarts IDs.

The method from the brief is in `scripts/replay.sh`. It sends the events but does
not advance the workflow, so follow it with repeated calls to
`POST /api/workflow/tick?limit=25`.

I also wrote a Node version, because I develop on Windows where PowerShell cannot
run bash scripts. Same endpoint, same payloads, and it drains the queue
afterwards.

Run one command per line:

```powershell
Remove-Item -LiteralPath .\fingerprints.json -ErrorAction SilentlyContinue
npm run reset
npm run migrate
npm run policies
npm run replay -- https://YOUR-APP.vercel.app 1
node --env-file=.env.local scripts/verify.mjs "pass1-sequential"
```

Then the same file again, **without** resetting:

```powershell
npm run replay -- https://YOUR-APP.vercel.app 1
node --env-file=.env.local scripts/verify.mjs "pass2-duplicate"
```

Then fresh, with eight senders:

```powershell
npm run reset
npm run migrate
npm run replay -- https://YOUR-APP.vercel.app 8
node --env-file=.env.local scripts/verify.mjs "pass3-parallel"
```

Each pass takes a few minutes — one AI call per refund.

### What is in the input

787 deliveries, **741 distinct IDs** — 46 deliveries repeat an ID. 239 valid
refund requests, of which 3 point at an order that never arrives. Plus 2 malformed
refund events that should not create ledger rows.

### My recorded results

| Run | Events | Ledger | Refunded | Review | Total (minor units) |
|---|---:|---:|---:|---:|---:|
| Sequential | 741 | 239 | 77 | 159 | 530985 |
| Duplicate, no reset | 741 | 239 | 77 | 159 | 530985 |
| Fresh, 8 senders | 741 | 239 | 78 | 158 | 500857 |

All three: zero over-refunded orders, zero orders whose totals disagreed with
their ledger rows, both malformed events logged, three orphans given up.

**Events and ledger are identical across all three.** That is what idempotency
means here. Pass 2's drain reported `processed 0, remaining 0` — nothing entered
the queue at all.

**Refunded and total differ in the parallel run, and those two are not
deterministic by design.** The notify step fails randomly 15% of the time as the
brief requires, and model confidence on a borderline refund can land either side
of the 0.7 auto-approve threshold. What rules out a concurrency fault is check 3b:
every order's stored refunded total exactly equals the sum of its own refunded
ledger rows, in every run.

The total column adds different currencies' minor units together. It is a
fingerprint for comparing runs, not a financial figure.

**What the verifier does and does not prove.** It checks event IDs and ledger
entries individually against the file, that no event is stuck mid-processing, that
every malformed event was dead-lettered by ID, and that fully-paid partial pairs
settle to exactly the captured amount. It does **not** compare every saved
decision, and its partial-pair check tolerates a pair where only one half was
approved. Read `ALL CHECKS PASSED` with those limits in mind.

### Retrieval

```bash
npm run eval
```

Imports `findPolicies()` from `lib/policy.ts` — the same function the workflow
calls — and scores 15 labelled questions.

| Metric | Result |
|---|---:|
| Hit rate@3 | 13/15 = 0.87 |
| Mean recall@3 | 0.87 |
| Precision@3 | 0.31 |
| MRR@3 | 0.80 |
| Full-list hit rate | 14/15 = 0.93 |
| Superseded documents returned | **0** |

Precision@3 is near its ceiling — most questions have one correct document and I
return three slots. Both misses and their cause are explained in DECISIONS.md.

### Over-refund guard

```bash
node --env-file=.env.local scripts/race-test.mjs https://YOUR-APP.vercel.app
```

**This mutates data.** It deliberately bypasses the application-level balance check
and fires two refunds at one order in parallel, so the database `CHECK` constraint
is the only thing left. One is refunded, one rejected with Postgres error 23514.

---

## Part D — Commands

| Command | Purpose |
|---|---|
| `npm run dev` / `build` / `start` | Development, production build, production server |
| `npx tsc --noEmit` | Type-check without emitting |
| `npm run seed` | Regenerate `events.ndjson` |
| `npm run migrate` | Apply `db/schema.sql` (safe to re-run) |
| `npm run reset` | **Empties** the PostgreSQL tables |
| `npm run policies` | **Replaces** the policy collection, creates indexes |
| `npm run replay -- <url> <workers>` | Send events, then drain pending work |
| `npm run verify` | Acceptance checks, appends a fingerprint |
| `npm run eval` | Retrieval metrics |
| `node --env-file=.env.local scripts/peek.mjs` | Read-only database inspection |
| `scripts/race-test.mjs` | **Mutating** over-refund diagnostic |
| `scripts/cleanup-tests.mjs` | **Mutating** cleanup of test records |
| `scripts/replay.sh`, `replay-parallel.sh` | Bash equivalents from the brief |

`npm run lint` uses `next lint`, which needs updating for this Next.js version. I
make no claim about its output.

---

## Part E — Layout

| Location | Responsibility |
|---|---|
| `app/page.tsx` | The agent console |
| `app/api/webhooks/orders/route.ts` | Event validation, idempotency, handling |
| `app/api/workflow/tick/route.ts` | Claims and runs due refunds |
| `app/api/console/route.ts` | All console data in one request |
| `app/api/console/decide/route.ts` | Agent approve and reject |
| `lib/workflow.ts` | The five steps, the payment SQL, simulated notifications |
| `lib/llm.ts` | Prompt, OpenAI call, validation, safety rules |
| `lib/policy.ts` | Retrieval, with the active-status filter |
| `lib/conversation.ts` | Conversation history in Mongo |
| `lib/db.ts`, `lib/mongo.ts` | Cached connections |
| `lib/validate.ts`, `lib/money.ts` | Input schemas, integer-cents conversion |
| `db/schema.sql` | Tables, constraints, indexes |
| `components/ui/` | The seven shadcn components the brief names |
| `scripts/` | Setup, replay, verification, diagnostics |

---

## Part F — Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `MongoServerSelectionError` | Atlas blocking the connection | Network Access → allow `0.0.0.0/0`, wait for Active |
| Mongo `authentication failed` | password placeholder left in | Substitute the real password |
| `too many connections` | using the direct URL in the app | `DATABASE_URL` must contain `-pooler` |
| Prepared-statement errors on migrate | using the pooled URL for DDL | Migrations use `DATABASE_URL_UNPOOLED` |
| First request after idle is slow | Neon sleeps free databases | Normal, about a second |
| `column ... does not exist` | schema not applied | `npm run migrate` |
| 404 on every refund | `OPENAI_MODEL` stale or unset | Copy a current ID from OpenAI's models page |
| Works locally, 500s deployed | variables missing on Vercel | Add them, then **redeploy** |
| Build log shows two routes | Vercel built the wrong commit | Deploy by pushing, not via Redeploy |
| `.env.local` changes ignored | read at startup | Restart the dev server |

**Where the real error is:** blank page → browser console (F12). API 500 → the dev
terminal locally, or Vercel's **Logs** tab. Something ran but nothing changed →
the database, via `scripts/peek.mjs`.

---

## Known limitations

- Webhook recovery relies on a later retry arriving; there is no background
  recovery service, so an interrupted event waits for the next delivery.
- Ownership is checked on status transitions, not on every write, and a batch lease
  can expire during slow serial processing.
- Conversation history stores selected facts rather than the raw exchange, and its
  writes are best-effort. A PostgreSQL reset reuses IDs while Mongo history
  remains.
- Fallback citations can come from my code rather than the model when validation
  fails. Region is derived from currency, which is a proxy.
- Reconciliation excludes orders with no refunds, and some views cap at 100 rows.
- There is no authentication, no webhook signature verification, and no real
  payment-provider idempotency contract. This is a demo, not a deployment.

DECISIONS.md covers the reasoning behind each of these.