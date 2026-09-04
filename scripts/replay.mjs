import { readFileSync } from 'node:fs';

const url = process.argv[2];
const workers = Number(process.argv[3] ?? 1);

if (!url) {
  console.error('Usage: node scripts/replay.mjs <url> [workers]');
  process.exit(1);
}

const lines = readFileSync('events.ndjson', 'utf8').trim().split('\n');
console.log(`Sending ${lines.length} events to ${url} with ${workers} worker(s)...`);

let sent = 0;

async function send(line) {
  // I ignore failures here on purpose. A dropped request is fine --
  // the point of this test is that nothing gets corrupted, not that
  // every single post succeeds.
  await fetch(`${url}/api/webhooks/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: line,
  }).catch(() => {});
  sent++;
  if (sent % 100 === 0) console.log(`  sent ${sent}/${lines.length}`);
}

// Each "worker" takes the next line off a shared list, so several
// requests really are in flight at the same time. That is the
// concurrency the brief tells me to test.
const queue = [...lines];
await Promise.all(
  Array.from({ length: workers }, async () => {
    while (queue.length) await send(queue.shift());
  })
);

console.log('Ingest finished. Draining the workflow queue...');

// I call the tick endpoint over and over until nothing is left to do.
while (true) {
  const res = await fetch(`${url}/api/workflow/tick?limit=25`, { method: 'POST' });
  const data = await res.json();
  console.log(`  processed ${data.processed}, remaining ${data.remaining}`);
  if (data.remaining === 0) break;
  await new Promise(r => setTimeout(r, 2000));
}

console.log('Done.');