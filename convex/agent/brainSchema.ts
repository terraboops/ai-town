// Validators and table shapes for resident brains. Kept apart from brain.ts so the schema
// can import them without pulling in function modules.

import { Infer, v } from 'convex/values';
import { agentId } from '../aiTown/ids';

export const modelRef = v.object({
  provider: v.union(
    v.literal('ollama'),
    v.literal('openai'),
    v.literal('anthropic'),
    v.literal('together'),
    v.literal('openrouter'),
  ),
  model: v.string(),
});

export const gate = v.object({
  // Which model answers. 'decider' falls back to the chat model when the brain has none.
  model: v.union(v.literal('decider'), v.literal('chat')),
  // A template; {name}, {identity}, {plan}, {candidate}, {candidateDistance},
  // {minutesSinceConversation}, {partner}, {lastMessage}, {transcript}, {numMessages} are
  // filled in. Unknown placeholders are left as they are.
  prompt: v.string(),
  // The answer is a yes when it contains this word, case-insensitively.
  yes: v.string(),
  maxTokens: v.optional(v.number()),
});

const tickAction = v.union(
  v.literal('invite'),
  v.literal('wander'),
  v.literal('activity'),
  v.literal('idle'),
);
const converseAction = v.union(v.literal('reply'), v.literal('leave'));

export const program = v.object({
  // What to do when there is nobody worth considering. Never calls a model.
  alone: v.optional(v.union(v.literal('wander'), v.literal('activity'), v.literal('idle'))),
  // Somebody free is within reach: the decision whether to approach them.
  tick: v.optional(
    v.object({
      maxDistance: v.optional(v.number()),
      gate: v.optional(gate),
      onYes: tickAction,
      onNo: tickAction,
    }),
  ),
  // Our turn in a conversation: keep talking, or wrap up.
  converse: v.optional(
    v.object({
      maxMessages: v.optional(v.number()),
      gate: v.optional(gate),
      onYes: converseAction,
      onNo: converseAction,
      // Which model writes the words. Default: chat.
      speaker: v.optional(v.union(v.literal('chat'), v.literal('decider'))),
    }),
  ),
  // Extra system-prompt text for every line this resident speaks.
  style: v.optional(v.string()),
  activities: v.optional(
    v.array(v.object({ description: v.string(), emoji: v.string(), seconds: v.number() })),
  ),
});
export type Program = Infer<typeof program>;

export const stats = v.object({
  idleTicks: v.number(),
  gateCalls: v.number(),
  gateYes: v.number(),
  chatCalls: v.number(),
  fallbacks: v.number(),
});
export type Stats = Infer<typeof stats>;
export const ZERO_STATS: Stats = { idleTicks: 0, gateCalls: 0, gateYes: 0, chatCalls: 0, fallbacks: 0 };

export const brainTables = {
  agentBrains: {
    worldId: v.id('worlds'),
    name: v.string(),
    // The verified login of whoever registered or bound it. Only they may edit it.
    owner: v.string(),
    agentId: v.optional(agentId),
    chat: modelRef,
    decider: v.optional(modelRef),
    program: v.optional(program),
    stats: v.optional(stats),
    updatedAt: v.number(),
  },
  brainLog: {
    worldId: v.id('worlds'),
    brainId: v.id('agentBrains'),
    at: v.number(),
    phase: v.string(),
    role: v.string(),
    provider: v.string(),
    model: v.string(),
    paid: v.boolean(),
    ms: v.number(),
    answer: v.string(),
    outcome: v.string(),
  },
};

