import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL_UNPOOLED);

// TRUNCATE empties the tables completely.
// RESTART IDENTITY sets the id counters back to 1.
// CASCADE also empties anything that points at these tables.
await sql`TRUNCATE orders, webhook_events, refund_ledger,
          workflow_steps, dead_letter RESTART IDENTITY CASCADE`;

console.log('all tables emptied');