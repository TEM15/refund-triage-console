import { z } from 'zod';
import type { Policy } from './policy';

// This is the exact shape I insist on getting back.
const Decision = z.object({
  action: z.enum(['approve', 'review', 'reject']),
  reasoning: z.string().min(1),
  confidence: z.number().min(0).max(1),
  cited_policy_ids: z.array(z.string()),
});
export type Decision = z.infer<typeof Decision>;

// I describe the shape once, here, and hand it to the provider. Keeping
// it separate from the call means swapping provider would not change
// the contract my workflow depends on.
const SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['approve', 'review', 'reject'] },
    reasoning: { type: 'string' },
    confidence: { type: 'number' },
    cited_policy_ids: { type: 'array', items: { type: 'string' } },
  },
  required: ['action', 'reasoning', 'confidence', 'cited_policy_ids'],
  additionalProperties: false,
} as const;


export async function decide(input: {
  order: any;
  amountCents: number;
  reason?: string | null;
  policies: Policy[];
  daysSinceOrder: number | null;
  shippingCents: number | null;
}): Promise<Decision> {

  const policyText = input.policies
    .map(p => `[${p.policy_id}] ${p.title}\n${p.body}`)
    .join('\n\n');

  // The two lines that matter most are days_since_order and shipping.
  // My policies say things like "within 45 days of the order date" and
  // "refund the shipping charge", and my first version of this prompt
  // sent neither. I was asking the model to apply a date rule without
  // giving it any dates, so it kept answering "review, the policies do
  // not establish this" -- correctly. Two thirds of my refunds were
  // landing in the review queue because of it.
  const prompt = `You decide refunds using ONLY the policies below.

POLICIES
${policyText}

REQUEST
currency: ${input.order.currency}
amount charged: ${input.order.captured_cents} minor units
already refunded: ${input.order.refunded_cents} minor units
this request: ${input.amountCents} minor units
shipping charged: ${input.shippingCents ?? 'unknown'} minor units
days between the order date and this request: ${input.daysSinceOrder ?? 'unknown'}
reason given: ${input.reason ?? 'none'}

Rules:
- cited_policy_ids may only contain IDs that appear above.
- cited_policy_ids must never be empty. Cite at least the policy that
  most closely applies, even if your answer is "review".
- If a policy depends on a fact shown as "unknown" above, answer "review".
- If the policies conflict, or do not cover this case, answer "review".`;

  try {
    const raw = await askOpenAI(prompt);
    const out = Decision.parse(raw);
    return applySafetyRules(out, input);

  } catch (err) {
    return fallbackToHuman(err, input.policies);
  }
}


/**
 * The only call that leaves my system.
 *
 * response_format with a json_schema and strict:true is OpenAI's way of
 * holding the model to my shape while it generates, so what comes back
 * already has my fields rather than a paragraph I would have to parse.
 *
 * I put the model name in an environment variable rather than hard
 * coding it, and I throw if it is missing. Model IDs get retired every
 * few months, and a stale one fails as a confusing 404 on every single
 * refund -- which does not obviously point at the model name as the
 * cause. Failing loudly at startup is much easier to diagnose.
 */
async function askOpenAI(prompt: string): Promise<unknown> {
  const OpenAI = (await import('openai')).default;
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

  if (!process.env.OPENAI_MODEL) throw new Error('OPENAI_MODEL is not set');

  const res = await client.chat.completions.create({
    model: process.env.OPENAI_MODEL,
    messages: [{ role: 'user', content: prompt }],
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'refund_decision', strict: true, schema: SCHEMA as any },
    },
  });

  const message = res.choices[0].message;

  // OpenAI can return a refusal instead of my payload. I check for that
  // first, because trying to JSON.parse a refusal would give me a
  // confusing error instead of a clear one.
  if ((message as any).refusal) {
    throw new Error('model refused: ' + (message as any).refusal);
  }
  if (!message.content) throw new Error('model returned no content');

  return JSON.parse(message.content);
}


/**
 * The safety rules live outside askOpenAI on purpose. Swapping provider
 * would mean replacing that one function, and none of these checks would
 * move -- so I could not accidentally end up with a less protected path.
 */
function applySafetyRules(out: Decision, input: any): Decision {
  const allowed = new Set(input.policies.map((p: Policy) => p.policy_id));

  // Models invent plausible IDs. POL-RETURN-POLICY sounds completely
  // real but does not exist in my collection. I drop the invented ones
  // rather than throwing the whole decision away -- a hallucinated
  // extra citation does not make the rest of the answer wrong.
  const clean = out.cited_policy_ids.filter(id => allowed.has(id));
  const invented = out.cited_policy_ids.filter(id => !allowed.has(id));
  if (invented.length) console.warn('model cited policies I never sent:', invented);

  // No usable citations at all is a different problem from a broken
  // reply, and gets its own message. The brief requires citations next
  // to every recommendation, so a decision without them cannot be
  // approved automatically however confident it sounds.
  if (clean.length === 0) {
    return {
      action: 'review',
      reasoning: 'The model gave a decision but did not cite any policy to support it, '
               + 'so this needs a human to confirm. The model said: ' + out.reasoning,
      confidence: 0,
      cited_policy_ids: input.policies.slice(0, 1).map((p: Policy) => p.policy_id),
    };
  }

  const cleaned = { ...out, cited_policy_ids: clean };

  // Plain arithmetic the model is not allowed to override. This is the
  // ONE case I reject outright rather than sending to a human, because
  // it is a fact rather than a judgement: the money is simply not there.
  const remaining =
    Number(input.order.captured_cents) - Number(input.order.refunded_cents);
  if (input.amountCents > remaining) {
    return {
      ...cleaned,
      action: 'reject',
      reasoning: 'More than the remaining charged amount. ' + cleaned.reasoning,
    };
  }

  // An unsure approval is not an approval.
  if (cleaned.action === 'approve' && cleaned.confidence < 0.7) {
    return { ...cleaned, action: 'review' };
  }

  return cleaned;
}


function fallbackToHuman(err: unknown, policies: Policy[]): Decision {
  // If anything went wrong -- the API was down, the reply did not match
  // my schema, the JSON would not parse -- the refund goes to a human.
  // An unreadable model reply must NEVER turn into an automatic payout.
  //
  // I log the technical detail to the server and give the agent a plain
  // sentence. My first version put the raw validation error into the
  // reasoning field, and agents saw a JSON dump they could not act on.
  console.error('refund decision failed, sending to human review:', err);

  return {
    action: 'review',
    reasoning: 'The model reply could not be validated, so this needs a human decision. '
             + 'The validation detail is in the server logs.',
    confidence: 0,
    cited_policy_ids: policies.slice(0, 1).map(p => p.policy_id),
  };
}