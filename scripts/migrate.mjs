import { readFileSync } from 'node:fs';
import { neon } from '@neondatabase/serverless';

// I use the UNPOOLED connection here on purpose.
// Creating tables needs a plain direct connection to Postgres.
// The pooled connection shares one real connection between many
// clients, which does not work for this kind of command.
const sql = neon(process.env.DATABASE_URL_UNPOOLED);

const file = readFileSync('db/schema.sql', 'utf8');

// I split the file on semicolons so each CREATE TABLE runs on its own.
const statements = file.split(/;\s*\n/).filter(s => s.trim().length > 0);

for (const statement of statements) {
  await sql.query(statement);
}

console.log(`applied ${statements.length} statements`);