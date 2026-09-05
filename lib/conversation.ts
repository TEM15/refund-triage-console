import { db } from './mongo';

/**
 * The brief assigns BOTH the policy knowledge base and conversation
 * history to Mongo. I had only built the policy side.
 *
 * This records what was actually sent to the model, what came back, and
 * anything an agent did afterwards -- so a decision can be audited long
 * after the refund has left the review queue.
 *
 * Failures here are logged and swallowed on purpose. Losing an audit
 * record is bad; failing a refund because the audit log was unreachable
 * is worse.
 */
export async function recordConversation(entry: {
  refund_id: number;
  order_id?: string;
  prompt_facts?: Record<string, unknown>;
  policies_supplied?: { policy_id: string; version: number }[];
  decision?: unknown;
  agent_action?: 'approve' | 'reject';
  source: 'model' | 'agent';
}) {
  try {
    const mongo = await db();
    await mongo.collection('conversations').insertOne({
      ...entry,
      created_at: new Date(),
    });
  } catch (err) {
    console.error('could not record conversation history:', err);
  }
}

/** Everything that happened to one refund, oldest first. */
export async function conversationFor(refundId: number) {
  const mongo = await db();
  return mongo.collection('conversations')
    .find({ refund_id: refundId })
    .sort({ created_at: 1 })
    .toArray();
}