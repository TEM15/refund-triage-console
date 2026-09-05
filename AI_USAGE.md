# AI usage

## Two different AIs — worth separating

**The assistant I used to build this.** **This document is about that one.**

**The AI inside the app.** OpenAI, which decides each refund. That is a product
feature and it is described in DECISIONS.md.

---

## What I used the assistant for

(AI assistance was used throughout due to short deadline)

Scaffolding repetitive code, reviewing my SQL for race conditions, explaining
Postgres behaviour I was unsure about (then confirming it in the docs), and
working through error messages faster than I would alone.

I am responsible for the code and its workings.

---

## Mistakes that announced themselves

These errored, crashed, or failed a build. The computer told me; I just had to
read it.

**It assumed data I had never built.** My console called `data.steps.filter(...)`
when my API never returned a `steps` field. It compiled, TypeScript raised nothing
because the response was typed `any`, and the local build passed. In production
the page threw and rendered nothing — a blank error page on my live URL. **Type
checking cannot catch an assumption about data that arrives at runtime.**

**It gave me the wrong Vercel timeout.** It said 60 seconds on the free plan;
Vercel's docs say 300. I would have designed the workflow around a limit that does
not exist. I now check platform numbers on the provider's own docs.

**It suggested deduplicating with a JavaScript `Set`.** That passes every test on a
laptop and silently fails on serverless, where requests land on different machines
with separate memory. The dangerous part is that it does not error — it just lets
duplicates through, only in production.

**It wrote a check-then-insert for idempotency.** `SELECT` then `INSERT` has a gap
where two requests both pass the check. Replaced with one `ON CONFLICT` statement.

**It invented a model name.** `gpt-5.6-luna` as a default. Model IDs get retired
every few months and a stale one looks like a 404 on every refund, which does not
point at the model name. I now throw at startup if `OPENAI_MODEL` is unset.

**It used a component prop that no longer exists.** `asChild` on shadcn's
`DialogTrigger`, removed in my installed version. The build caught it — which is
what builds are for — but it shows generated UI code targets whatever version the
assistant saw in training, not mine.

**It showed a raw validation error to the user.** My fallback to human review is
correct and I kept it, but the first version put the raw Zod error into the
reasoning field, so agents saw a JSON dump. Now the detail goes to the server log
and the agent gets a plain sentence.

---

## Bugs the code hid well

Different, and more worrying: **code that passed all my tests while still being
wrong.** All six acceptance checks were green when I started reading the code
against the brief line by line.

**1. My webhook was not atomic.** Recording the event and applying its change were
two statements. If the function died between them the event was marked seen with
no refund created — and my own deduplication then skipped the retry. **The refund
was gone, permanently, and nothing reported it.**

The irony is that the code was given to me *as* the idempotency fix, and the
idempotency part is correct. The recovery part was simply missing. It never
surfaced because Vercel rarely kills a function mid-request, but a bug that needs
bad luck is still a bug.

*Fixed with a `processing` → `done` lifecycle; a retry finding a stale claim takes
it over.*

**2. The model was asked to apply date rules without dates.** My policies say
"within 45 days of the order date" and "refund the shipping charge". My prompt
sent neither.

**I found this from a number that felt wrong, not an error.** 158 of 239 refunds
in review. Two thirds. That is not a system automating refunds, it is a system
forwarding them. I read my own prompt against my own policies and saw the gap.
**An AI saying "I cannot determine this" is usually a complaint about its inputs.**
I had been reading those as caution.

*Fixed by sending `days_since_order` and `shipping_cents`. Approvals went 64 → 78.*

**3. My approve endpoint approved anything that was not "reject".** No validation
at all. `{"id": 5, "action": "banana"}` would have moved money — on a public URL.
I use Zod on every webhook payload and every model reply, then trusted my own API
because it felt internal. It is not.

**4. A late order could never recover.** My wake-up only revived
`waiting_for_order`, not `given_up`. So an order arriving one second after the
sixth attempt left the refund dead. My replay passed only because the seed file
shuffles events by at most 15 positions — **luck about the test data, not a
property of my system.**

**5. My replay script threw away failures.** `.catch(() => {})`, written
deliberately: the point of the test is that nothing gets *corrupted*, not that
every post succeeds. That reasoning is wrong. If 200 had failed my counts would
have been short and I would have hunted a deduplication bug that did not exist.
**Silently discarding errors during the test that proves correctness defeats the
test.**

**6. A double payment I introduced while fixing something else.** Adding worker
ownership, I replaced a guarded status update with a plain one. A refund already
`refunded`, returning only to retry its notification, was set back to `approved`
and paid a second time. **Thirteen orders affected.**

My old verify compared totals, and totals can match while the wrong rows are
present — it would never have found this. The rewritten check 3b compares each
order to the sum of its own ledger rows and caught it on the first run after the
change.

**Tightening one guard loosened another, and I only saw it because I had improved
the thing that looks at the same time.** Had I rewritten the workflow without
rewriting the verification, I would have shipped a system that pays some refunds
twice — the exact failure the brief exists to test.

### What this second group taught me

The first seven were caught by the computer. These six could not be — from the
computer's point of view nothing went wrong. The only thing that found them was
reading the code against the requirements and asking whether it actually does what
was asked, or just looks like it does.

That is the part that cannot be delegated, and it is why the brief's condition —
that I can explain and extend every line — matters more than whether the code was
generated or typed.

---

## Where I overrode it

**The money step.** I was offered two separate SQL statements: claim the ledger
row, then update the order total. Fine one refund at a time; under concurrency
they interleave. I rewrote it as one statement with a `WITH` block.

**The stat cards.** The first console design had four large cards across the top
that pushed the work below the fold and cramped so badly the labels wrapped over
three lines. One line of text now. The brief says a dense table beats a landing
page.

**Structure I could not justify.** An ORM, a separate `workflow_runs` table, a
transaction helper — all removed. One refund is one run, so one row. The money
step is one statement, so it needs no transaction. And plain SQL is what I would
have to explain anyway.

**The second AI provider.** The suggested `lib/llm.ts` supported Claude and OpenAI
behind a switch. I removed the Claude path because I had never installed the
package or run that code. Shipping an untested path is worth less than being clear
about which one I use.

---

## My own mistakes, not the assistant's

Listing these separately, because not everything that went wrong was its fault.

I saved a route as `root.ts` instead of `route.ts`, so my webhook did not exist
and every request 404'd. I checked my code before checking the filename.

I used Vercel's **Redeploy** button instead of pushing, which rebuilt a snapshot
from the start of the project and broke my live site. I spotted it because the
build log listed two routes instead of six. I now deploy only by pushing.

I chained PowerShell commands with `>>`, which runs the second even when the first
fails. My reseed failed, the evaluation ran on unchanged data, and I concluded a
fix had not worked when it had never been applied.

And my two original retrieval misses were not a code problem at all: my policies
said "damaged" and were tagged `EUR`, while real questions say "smashed" and
"euros". The fix was in the documents, not the retrieval code.