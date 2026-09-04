import OpenAI from 'openai';
import { z } from 'zod';
import type { Policy } from './policy';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

// I put the model name in an environment variable instead of hard
// coding it, because model names change and I would rather edit one
// config value than go hunting through my code.
const MODEL = process.env.OPENAI_MODEL ?? 'gpt-5.6-luna';

// This is the exact shape I insist on getting back.
const Decision = z.object({
  action: z.enum(['approve', 'review', 'reject']),
  reasoning: z.string().min(1),
  confidence: z.number().min(0).max(1),
  cited_policy_ids: z.array(z.string()).min(1),
});
export type Decision = z.infer<typeof Decision>;

export async function decide(input: {
  order: any;
  amountCents: number;
  reason?: string | null;
  policies: Policy[];
}): Promise<Decision> {

  const policyText = input.policies
    .map(p => `[${p.policy_id}] ${p.title}\n${p.body}`)
    .join('\n\n');

  const prompt = `You decide refunds using ONLY the policies below.

POLICIES
${policyText}

REQUEST
currency: ${input.order.currency}
amount charged: ${input.order.captured_cents} cents
already refunded: ${input.order.refunded_cents} cents
this request: ${input.amountCents} cents
reason given: ${input.reason ?? 'none'}

Rules:
- cited_policy_ids may only contain IDs that appear above.
- If the policies conflict, or do not cover this case, answer "review".`;

  try {
    const res = await openai.chat.completions.create({
      model: MODEL,
      messages: [{ role: 'user', content: prompt }],
      // response_format with a json_schema and strict:true is OpenAI's
      // way of guaranteeing the reply matches my shape. Without it the
      // model can return valid JSON that has the wrong fields.
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'refund_decision',
          strict: true,
          schema: {
            type: 'object',
            properties: {
              action: { type: 'string', enum: ['approve', 'review', 'reject'] },
              reasoning: { type: 'string' },
              confidence: { type: 'number' },
              cited_policy_ids: { type: 'array', items: { type: 'string' } },
            },
            required: ['action', 'reasoning', 'confidence', 'cited_policy_ids'],
            additionalProperties: false,
          },
        },
      },
    });

    const message = res.choices[0].message;

    // OpenAI can return a refusal instead of my payload. I check for
    // that first, because trying to JSON.parse a refusal would give me
    // a confusing error instead of a clear one.
    if ((message as any).refusal) {
      throw new Error('model refused: ' + (message as any).refusal);
    }
    if (!message.content) throw new Error('model returned no content');

    // Even though I used strict mode, I still check the shape with Zod.
    // The assessment says never trust the shape of what the model
    // returns, and I agree -- a truncated reply can still be wrong.
    const out = Decision.parse(JSON.parse(message.content));

    return applySafetyRules(out, input);

  } catch (err) {
    return fallbackToHuman(err, input.policies);
  }
}

// The two functions below are shared logic. I keep them separate from
// the API call so that the safety rules stay the same no matter which
// model provider I use.

function applySafetyRules(out: Decision, input: any): Decision {
  // The model sometimes invents policy IDs. I only accept ones I sent.
  const allowed = new Set(input.policies.map((p: Policy) => p.policy_id));
  if (out.cited_policy_ids.some(id => !allowed.has(id))) {
    throw new Error('model cited a policy that was not provided');
  }

  // A plain arithmetic check that the model is not allowed to override.
  const remaining =
    Number(input.order.captured_cents) - Number(input.order.refunded_cents);
  if (input.amountCents > remaining) {
    return { ...out, action: 'reject',
             reasoning: 'More than the remaining charged amount. ' + out.reasoning };
  }

  // If the model is not confident, a human looks at it instead of the
  // money going out automatically.
  if (out.action === 'approve' && out.confidence < 0.7) {
    return { ...out, action: 'review' };
  }

  return out;
}

function fallbackToHuman(err: unknown, policies: Policy[]): Decision {
  // If anything at all went wrong -- the API was down, the reply did
  // not match my schema, the model invented a citation -- the refund
  // goes to a human. An unreadable model reply must NEVER turn into
  // an automatic payout.
  return {
    action: 'review',
    reasoning: 'Could not use the model reply: ' + String(err),
    confidence: 0,
    cited_policy_ids: policies.slice(0, 1).map(p => p.policy_id),
  };
}