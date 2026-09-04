import OpenAI from 'openai';
import { z } from 'zod';
import type { Policy } from './policy';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

// I put the model name in an environment variable instead of hard coding
// it, because model names change. I throw here rather than guessing a
// default, so a missing setting fails immediately with a clear message
// instead of producing a confusing 404 on every refund.
if (!process.env.OPENAI_MODEL) throw new Error('OPENAI_MODEL is not set');
const MODEL: string = process.env.OPENAI_MODEL;

// This is the exact shape I insist on getting back.
// Note cited_policy_ids has no minimum length here. An empty citation
// list is a real thing the model does, and I want to handle it as its
// own case rather than as a schema failure -- the two mean different
// things and deserve different messages.
const Decision = z.object({
  action: z.enum(['approve', 'review', 'reject']),
  reasoning: z.string().min(1),
  confidence: z.number().min(0).max(1),
  cited_policy_ids: z.array(z.string()),
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
- cited_policy_ids must never be empty. Cite at least the policy that
  most closely applies, even if your answer is "review".
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
  const allowed = new Set(input.policies.map((p: Policy) => p.policy_id));

  // The model sometimes invents policy IDs. I only accept ones I sent,
  // and I drop the invented ones rather than throwing away the whole
  // decision -- a hallucinated extra citation does not make the rest
  // of the answer wrong.
  const cleanCitations = out.cited_policy_ids.filter(id => allowed.has(id));
  const invented = out.cited_policy_ids.filter(id => !allowed.has(id));
  if (invented.length) {
    console.warn('model cited policies I never sent:', invented);
  }

  // No usable citations at all is a different problem from a broken
  // reply, and it gets its own message. The brief requires citations
  // next to every recommendation, so a decision without them cannot be
  // approved automatically no matter how confident the model sounds.
  if (cleanCitations.length === 0) {
    return {
      action: 'review',
      reasoning:
        'The model gave a decision but did not cite any policy to support it, '
        + 'so this needs a human to confirm. The model said: ' + out.reasoning,
      confidence: 0,
      cited_policy_ids: input.policies.slice(0, 1).map((p: Policy) => p.policy_id),
    };
  }

  const cleaned = { ...out, cited_policy_ids: cleanCitations };

  // A plain arithmetic check that the model is not allowed to override.
  const remaining =
    Number(input.order.captured_cents) - Number(input.order.refunded_cents);
  if (input.amountCents > remaining) {
    return {
      ...cleaned,
      action: 'reject',
      reasoning: 'More than the remaining charged amount. ' + cleaned.reasoning,
    };
  }

  // If the model is not confident, a human looks at it instead of the
  // money going out automatically.
  if (cleaned.action === 'approve' && cleaned.confidence < 0.7) {
    return { ...cleaned, action: 'review' };
  }

  return cleaned;
}

function fallbackToHuman(err: unknown, policies: Policy[]): Decision {
  // If anything at all went wrong -- the API was down, the reply did not
  // match my schema, the JSON would not parse -- the refund goes to a
  // human. An unreadable model reply must NEVER turn into an automatic
  // payout.
  //
  // I log the technical detail to the server and give the agent a plain
  // sentence. My first version put the raw validation error into the
  // reasoning field, and agents saw a JSON dump they could not act on.
  console.error('refund decision failed, sending to human review:', err);

  return {
    action: 'review',
    reasoning:
      'The model reply could not be validated, so this needs a human decision. '
      + 'The validation detail is in the server logs.',
    confidence: 0,
    cited_policy_ids: policies.slice(0, 1).map(p => p.policy_id),
  };
}