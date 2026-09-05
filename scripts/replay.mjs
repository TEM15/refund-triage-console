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
const failures = [];

async function send(line) {
  try {
    const res = await fetch(`${url}/api/webhooks/orders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: line,
    });
    // 400 is expected for the deliberately broken events, so it is not
    // a failure. 5xx and network errors are.
    if (res.status >= 500) {
      failures.push({ id: JSON.parse(line).event_id, status: res.status });
    }
  } catch (e) {
    // My first version swallowed these with .catch(() => {}). If 200
    // posts had failed, my counts would have been short and I would
    // have gone hunting for a deduplication bug that did not exist.
    // Silently discarding errors during the test that proves
    // correctness defeats the test.
    failures.push({ id: JSON.parse(line).event_id, status: 'network', error: String(e) });
  }
  sent++;
  if (sent % 100 === 0) console.log(`  sent ${sent}/${lines.length}`);
}

const queue = [...lines];
await Promise.all(
  Array.from({ length: workers }, async () => {
    while (queue.length) await send(queue.shift());
  })
);

if (failures.length) {
  console.error(`\n!! ${failures.length} request(s) FAILED. First five:`);
  console.table(failures.slice(0, 5));
  console.error('These must be zero before the replay result means anything.\n');
} else {
  console.log('\nAll requests completed with no server errors.');
}

console.log('Draining the workflow queue...');

let idle = 0;
while (true) {
  const res = await fetch(`${url}/api/workflow/tick?limit=25`, { method: 'POST' });
  const data = await res.json();
  console.log(`  processed ${data.processed}, remaining ${data.remaining}`);
  if (data.remaining === 0) break;

  // Rows waiting on their retry delay still count as remaining, so
  // processing zero for a few rounds is normal. Stop only if it never
  // moves at all.
  idle = data.processed === 0 ? idle + 1 : 0;
  if (idle > 40) {
    console.error('Queue stopped making progress. Something is stuck.');
    break;
  }
  await new Promise(r => setTimeout(r, 2000));
}

console.log('Done.');
process.exit(failures.length ? 1 : 0);