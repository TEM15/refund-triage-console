import { MongoClient } from 'mongodb';

// ---------------------------------------------------------------
// Same idea as lib/db.ts. I cache one MongoDB client on globalThis
// so that warm Vercel instances reuse it. Making a new client per
// request would open a new connection pool each time, and the free
// Atlas tier has a hard connection limit I would hit during the
// replay.
// ---------------------------------------------------------------

declare global {
  // eslint-disable-next-line no-var
  var _mongo: Promise<MongoClient> | undefined;
}

const clientPromise =
  globalThis._mongo ??
  (globalThis._mongo = new MongoClient(process.env.MONGODB_URI!).connect());

export async function db() {
  const client = await clientPromise;
  return client.db(process.env.MONGODB_DB ?? 'refund_triage');
}