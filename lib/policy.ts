import { db } from './mongo';

export type Policy = {
  policy_id: string;
  version: number;
  title: string;
  body: string;
};

/**
 * Finds the policy documents that are relevant to one refund request.
 *
 * The single most important line in here is `status: 'active'`.
 *
 * My knowledge base deliberately contains an old 2023 policy saying
 * thirty days sitting next to the current 2026 one saying forty five.
 * Both stay in the collection, as the assessment requires. The old one
 * is marked status:'superseded'.
 *
 * Because I filter on status BEFORE the text search runs, the old
 * document is never even a candidate. It cannot be returned, so it
 * cannot be cited.
 *
 * I chose this over telling the model "please prefer the newer policy".
 * A model can ignore an instruction. It cannot cite a document it was
 * never shown. Filtering is the stronger guarantee.
 */
export async function findPolicies(input: {
  reason?: string | null;
  currency: string;
}): Promise<Policy[]> {

  const mongo = await db();
  const policies = mongo.collection('policies');

  // I map the currency to a region so regional rules get picked up.
  const region =
    input.currency === 'EUR' ? 'EU' :
    input.currency === 'GBP' ? 'UK' : 'US';

  const searchText = [input.reason ?? '', region, 'refund return window']
    .join(' ')
    .trim();

  const found = await policies
    .find(
      { status: 'active', $text: { $search: searchText } },
      { projection: { score: { $meta: 'textScore' } } }
    )
    .sort({ score: { $meta: 'textScore' } })
    .limit(4)
    .toArray();

  // These two set hard money rules, so I always include them even if
  // the text search does not rank them highly for this particular
  // reason. Without them the model could approve something over the
  // escalation threshold.
  const alwaysInclude = await policies
    .find({
      status: 'active',
      policy_id: { $in: ['POL-ESCALATION-THRESHOLD', 'POL-PARTIAL-REFUND'] },
    })
    .toArray();

  // Merge the two lists and drop any duplicates.
  const seen = new Set<string>();
  const merged: Policy[] = [];
  for (const doc of [...found, ...alwaysInclude]) {
    if (seen.has(doc.policy_id)) continue;
    seen.add(doc.policy_id);
    merged.push({
      policy_id: doc.policy_id,
      version: doc.version,
      title: doc.title,
      body: doc.body,
    });
  }
  return merged;
}