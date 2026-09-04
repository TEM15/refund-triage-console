-- ==========================================================
-- ORDERS
-- One row per order. I store all money as whole cents in a
-- bigint, never as decimal, because decimals lose accuracy
-- and the reconciliation check needs to be exact.
-- ==========================================================
CREATE TABLE IF NOT EXISTS orders (
  order_id        text PRIMARY KEY,
  currency        text,
  subtotal_cents  bigint,
  shipping_cents  bigint,
  tax_cents       bigint,
  captured_cents  bigint NOT NULL DEFAULT 0,  -- how much I took from the customer
  refunded_cents  bigint NOT NULL DEFAULT 0,  -- how much I have given back so far
  created_at      timestamptz,

  -- This is most important line in my project.
  -- I put the "never refund more than we charged" rule inside the
  -- database itself. Even if I have a bug in my application code,
  -- Postgres will refuse to save a row that breaks this rule.
  CONSTRAINT never_over_refund
    CHECK (refunded_cents >= 0 AND refunded_cents <= captured_cents)
);


-- ==========================================================
-- WEBHOOK_EVENTS
-- Every event I have ever received, one row each.
-- I made event_id the PRIMARY KEY, which means Postgres
-- physically cannot store the same event twice. That is my
-- deduplication -- it lives in the database, not in my code.
-- ==========================================================
CREATE TABLE IF NOT EXISTS webhook_events (
  event_id     text PRIMARY KEY,
  topic        text,
  occurred_at  timestamptz,
  payload      jsonb NOT NULL,
  status       text NOT NULL DEFAULT 'ok',   -- 'ok' or 'rejected'
  note         text,                          -- why I rejected it
  received_at  timestamptz NOT NULL DEFAULT now()
);


-- ==========================================================
-- REFUND_LEDGER
-- One row per refund request. I decided this row IS the
-- workflow run as well -- it holds both the refund and how far
-- through the steps it has got. That means one less table and
-- one less join to explain.
--
-- What each status means:
--   new                -> just arrived, nothing done yet
--   waiting_for_order  -> the order has not turned up yet, try again later
--   needs_review       -> a human has to decide this one
--   approved           -> cleared to pay, but not paid yet
--   refunded           -> the money has moved. Final.
--   rejected           -> I will not pay this. Final.
--   given_up           -> I waited long enough and stopped. Final.
-- ==========================================================
CREATE TABLE IF NOT EXISTS refund_ledger (
  id              bigserial PRIMARY KEY,

  -- UNIQUE here is acceptance check #1 written as a database rule:
  -- one distinct event_id can only ever produce one ledger entry.
  event_id        text NOT NULL UNIQUE,

  order_id        text NOT NULL,
  amount_cents    bigint NOT NULL CHECK (amount_cents > 0),
  reason          text,
  status          text NOT NULL DEFAULT 'new',

  -- I save what the model said so I never have to ask it twice.
  -- That keeps retries cheap and keeps the decision the same
  -- every time I come back to this refund.
  model_action     text,
  model_reasoning  text,
  model_confidence int,        -- stored 0 to 100 so it is a plain integer
  cited_policies   text[],

  -- Retry bookkeeping.
  attempts     int NOT NULL DEFAULT 0,
  next_try_at  timestamptz NOT NULL DEFAULT now(),
  last_error   text,

  -- I track the notify step separately because it can fail long
  -- after the money has already gone out, and those two facts
  -- must not be mixed up.
  notify_state text NOT NULL DEFAULT 'pending',  -- pending | sent | failed

  requested_at timestamptz,
  refunded_at  timestamptz
);

CREATE INDEX IF NOT EXISTS refund_status_idx ON refund_ledger(status);
CREATE INDEX IF NOT EXISTS refund_next_try_idx ON refund_ledger(next_try_at);


-- ==========================================================
-- WORKFLOW_STEPS
-- The trace I show in the console. One row per (refund, step).
-- I made (refund_id, step) UNIQUE so that writing the same step
-- again just updates it instead of piling up duplicate rows.
-- ==========================================================
CREATE TABLE IF NOT EXISTS workflow_steps (
  id         bigserial PRIMARY KEY,
  refund_id  bigint NOT NULL REFERENCES refund_ledger(id) ON DELETE CASCADE,
  step       text NOT NULL,   -- load_order | check_eligibility | decide
                              -- | issue_refund | notify
  status     text NOT NULL,   -- ok | failed
  attempts   int NOT NULL DEFAULT 1,
  detail     text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (refund_id, step)
);


-- ==========================================================
-- DEAD_LETTER
-- Events I refused to process. I keep them so that nothing ever
-- disappears silently -- if I throw something away, I can show
-- exactly what it was and why.
-- ==========================================================
CREATE TABLE IF NOT EXISTS dead_letter (
  id         bigserial PRIMARY KEY,
  event_id   text,
  reason     text NOT NULL,
  payload    jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);