import { Pool } from '@neondatabase/serverless';

// ---------------------------------------------------------------
// Why this file looks unusual:
//
// On Vercel my code runs inside short-lived functions. If I created
// a new database connection pool every time a request came in, then
// a thousand webhook posts would try to open a thousand pools and
// Postgres would run out of connections and my whole deployment
// would fall over during the replay.
//
// Two things stop that:
//   1. I keep ONE pool on globalThis. When Vercel reuses a warm
//      instance for another request, it finds the pool already there
//      instead of making a new one.
//   2. DATABASE_URL points at Neon's pooled endpoint -- the hostname
//      has "-pooler" in it. That sits in front of Postgres and shares
//      a few real connections between many clients.
// ---------------------------------------------------------------

declare global {
  // eslint-disable-next-line no-var
  var _pool: Pool | undefined;
}

export const pool =
  globalThis._pool ??
  new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });

globalThis._pool = pool;

/**
 * I run every query through this one function.
 * Values always go in as $1, $2 and so on, never glued into the
 * SQL string. That is how I avoid SQL injection.
 */
export async function q<T = any>(sql: string, params: any[] = []): Promise<T[]> {
  const result = await pool.query(sql, params);
  return result.rows as T[];
}