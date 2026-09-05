-- ==========================================================
-- ORDERS. All money is whole cents in a bigint.
-- ==========================================================
CREATE TABLE IF NOT EXISTS orders (
  order_id        text PRIMARY KEY,
  currency        text,
  subtotal_cents  bigint,
  shipping_cents  bigint,
  tax_cents       bigint,
  captured_cents  bigint NOT NULL DEFAULT 0,
  refunded_cents  bigint NOT NULL DEFAULT 0,
  created_at      timestamptz,

  -- The most important line in my project. The rule lives in the
  -- database, so even a bug in my code cannot save a row where we
  -- refunded more than we charged.
  CONSTRAINT never_over_refund
    CHECK (refunded_cents >= 0 AND refunded_cents <= captured_cents)
);


-- ==========================================================
-- WEBHOOK_EVENTS
-- event_id is the PRIMARY KEY, so the same event cannot be stored twice.
--
-- status is a lifecycle, not just a label:
--   processing -> I have claimed this and am working on it
--   done       -> fully applied, safe to skip on any retry
--   rejected   -> permanently invalid, never retry
--
-- Why: recording the event and applying its change are two statements.
-- If the function died between them, a retry saw the event as a
-- duplicate and skipped it, losing the refund forever. Now a retry
-- finds a STALE 'processing' row, takes it over, and finishes the job.
-- ==========================================================
CREATE TABLE IF NOT EXISTS webhook_events (
  event_id     text PRIMARY KEY,
  topic        text,
  occurred_at  timestamptz,
  payload      jsonb NOT NULL,
  status       text NOT NULL DEFAULT 'processing',
  note         text,
  claimed_at   timestamptz NOT NULL DEFAULT now(),
  received_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE webhook_events ADD COLUMN IF NOT EXISTS claimed_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE webhook_events ALTER COLUMN status SET DEFAULT 'processing';


-- ==========================================================
-- REFUND_LEDGER. One row per refund request; this row IS the run.
-- status: new | waiting_for_order | needs_review | approved
--         | refunded | rejected | given_up
-- ==========================================================
CREATE TABLE IF NOT EXISTS refund_ledger (
  id              bigserial PRIMARY KEY,
  event_id        text NOT NULL UNIQUE,
  order_id        text NOT NULL,
  amount_cents    bigint NOT NULL CHECK (amount_cents > 0),
  reason          text,
  status          text NOT NULL DEFAULT 'new',

  model_action     text,
  model_reasoning  text,
  model_confidence int,
  cited_policies   text[],

  -- Overall loop guard. Stops anything running forever, whatever breaks.
  attempts     int NOT NULL DEFAULT 0,

  -- Separate counters, because waiting for an order and failing to send
  -- a notification are different problems with different give-up
  -- points. Sharing one number meant a refund that waited three times
  -- for its order had three fewer notification attempts left.
  order_wait_attempts int NOT NULL DEFAULT 0,
  notify_attempts     int NOT NULL DEFAULT 0,

  next_try_at  timestamptz NOT NULL DEFAULT now(),
  last_error   text,

  -- Which worker currently holds this row, so two overlapping ticks
  -- cannot both work on the same refund.
  locked_by    text,

  notify_state text NOT NULL DEFAULT 'pending',
  requested_at timestamptz,
  refunded_at  timestamptz
);

ALTER TABLE refund_ledger ADD COLUMN IF NOT EXISTS order_wait_attempts int NOT NULL DEFAULT 0;
ALTER TABLE refund_ledger ADD COLUMN IF NOT EXISTS notify_attempts int NOT NULL DEFAULT 0;
ALTER TABLE refund_ledger ADD COLUMN IF NOT EXISTS locked_by text;

CREATE INDEX IF NOT EXISTS refund_status_idx ON refund_ledger(status);
CREATE INDEX IF NOT EXISTS refund_order_idx  ON refund_ledger(order_id);


-- ==========================================================
-- WORKFLOW_STEPS -- the trace shown in the console.
-- ==========================================================
CREATE TABLE IF NOT EXISTS workflow_steps (
  id         bigserial PRIMARY KEY,
  refund_id  bigint NOT NULL REFERENCES refund_ledger(id) ON DELETE CASCADE,
  step       text NOT NULL,
  status     text NOT NULL,
  attempts   int NOT NULL DEFAULT 1,
  detail     text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (refund_id, step)
);


-- ==========================================================
-- DEAD_LETTER -- everything I refused, so nothing vanishes silently.
-- ==========================================================
CREATE TABLE IF NOT EXISTS dead_letter (
  id         bigserial PRIMARY KEY,
  event_id   text,
  reason     text NOT NULL,
  payload    jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);