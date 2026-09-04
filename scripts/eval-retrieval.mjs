import { readFileSync } from 'node:fs';
import { MongoClient } from 'mongodb';

// ---------------------------------------------------------------
// This script measures how good my retrieval actually is, so that the
// number I put in DECISIONS.md is a real one I can defend.
//
// I measure three things at k = 3, meaning "in the top three results":
//
//   Recall@3     -- how often the right document was in the top three.
//                   This is the most important one, because a document
//                   that is never retrieved can never be cited.
//   Precision@3  -- of the three I got back, how many were relevant.
//   MRR          -- how high up the right one was ranked. 1.0 means it
//                   was always first, 0.5 means usually second.
//
// I also count stale citations: how many superseded documents came
// back. That must be exactly zero.
// ---------------------------------------------------------------

const questions = JSON.parse(readFileSync('scripts/eval-questions.json', 'utf8'));
const client = await new MongoClient(process.env.MONGODB_URI).connect();
const col = client.db(process.env.MONGODB_DB).collection('policies');

const K = 3;
let hits = 0, precisionTotal = 0, reciprocalRankTotal = 0, stale = 0;
const table = [];

for (const item of questions) {
  const docs = await col
    .find(
      { status: 'active', $text: { $search: item.q } },
      { projection: { score: { $meta: 'textScore' } } }
    )
    .sort({ score: { $meta: 'textScore' } })
    .limit(K)
    .toArray();

  const ids = docs.map(d => d.policy_id);
  const relevantCount = ids.filter(id => item.expect.includes(id)).length;
  const rank = ids.findIndex(id => item.expect.includes(id));   // -1 if missing

  if (rank >= 0) hits++;
  precisionTotal += relevantCount / K;
  reciprocalRankTotal += rank >= 0 ? 1 / (rank + 1) : 0;
  stale += docs.filter(d => d.status !== 'active').length;

  table.push({
    question: item.q.slice(0, 45),
    got: ids.join(', '),
    found: rank >= 0 ? `yes (position ${rank + 1})` : 'NO',
  });
}

const n = questions.length;
console.table(table);
console.log(`
==================== RETRIEVAL EVALUATION ====================
Questions asked:      ${n}
Recall@${K}:            ${hits}/${n}  =  ${(hits / n).toFixed(2)}
Precision@${K}:         ${(precisionTotal / n).toFixed(2)}
MRR:                  ${(reciprocalRankTotal / n).toFixed(2)}
Superseded documents
returned:             ${stale}      (this must be 0)
==============================================================
`);

await client.close();