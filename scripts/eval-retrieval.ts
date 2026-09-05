import { readFileSync } from 'node:fs';
import { findPolicies } from '../lib/policy.ts';

// My first version re-implemented the Mongo query here, so it measured
// something close to my app rather than my app. Now it calls the exact
// same function the workflow calls, so the number reflects production.
type Question = { q: string; expect: string[]; reason?: string; currency?: string };
const questions: Question[] =
  JSON.parse(readFileSync('scripts/eval-questions.json', 'utf8'));

const K = 3;
let hitCount = 0, recallSum = 0, precisionSum = 0, mrrSum = 0, staleCount = 0;
let fullHitCount = 0;
let fullRecallSum = 0;
const rows: any[] = [];

for (const item of questions) {
  const docs = await findPolicies({
    reason: item.reason ?? item.q,
    currency: item.currency ?? 'USD',
  });

  // Check the complete policy list supplied to the AI.
const allIds = docs.map(d => d.policy_id);
const expectedIds = [...new Set(item.expect)];

if (expectedIds.length === 0) {
  throw new Error(`Question has no expected policies: ${item.q}`);
}

const fullFound = expectedIds.filter(id => allIds.includes(id));

if (fullFound.length > 0) {
  fullHitCount++;
}

fullRecallSum += fullFound.length / expectedIds.length;
  const topK = docs.slice(0, K);
  const ids = topK.map(d => d.policy_id);

  const found = item.expect.filter(e => ids.includes(e));
  const firstHit = ids.findIndex(id => item.expect.includes(id));

  // HIT RATE: did at least one expected document appear? This is what I
  // was previously calling "recall", which was imprecise.
  if (found.length > 0) hitCount++;

  // TRUE RECALL: what fraction of ALL expected documents did I find?
  // A question with two acceptable answers scores 0.5 if I find one.
  recallSum += found.length / item.expect.length;

  precisionSum += found.length / K;
  mrrSum += firstHit >= 0 ? 1 / (firstHit + 1) : 0;
  // Every supplied policy must explicitly be active.
// Missing status is also counted as a failure.
staleCount += docs.filter(d => d.status !== 'active').length;

  rows.push({
  question: item.q.slice(0, 42),
  top3: ids.join(', '),
  foundTop3: firstHit >= 0 ? `yes (pos ${firstHit + 1})` : 'NO',
  allReturned: allIds.join(', '),
  foundInAll: `${fullFound.length}/${expectedIds.length}`,
});
}

const n = questions.length;
console.table(rows);
console.log(`
==================== RETRIEVAL EVALUATION ====================
Questions asked: ${n}

FIRST ${K} RETURNED POLICIES
Hit rate@${K}:       ${hitCount}/${n} = ${(hitCount / n).toFixed(2)}
Mean recall@${K}:    ${(recallSum / n).toFixed(2)}
Precision@${K}:      ${(precisionSum / n).toFixed(2)}
MRR@${K}:            ${(mrrSum / n).toFixed(2)}

ALL RETURNED POLICIES — the complete list supplied to the AI
Hit rate:           ${fullHitCount}/${n} = ${(fullHitCount / n).toFixed(2)}
Mean recall:        ${(fullRecallSum / n).toFixed(2)}

Non-active or missing-status documents across ALL results:
${staleCount} — MUST BE 0

Measured through lib/policy.ts.
A zero exit code confirms the active-status check only;
it does not guarantee perfect retrieval.
==============================================================
`);

process.exit(staleCount === 0 ? 0 : 1);