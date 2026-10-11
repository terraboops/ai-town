// A resident's brain: which models it runs, and the small program that routes between them.
//
// Upstream AI Town has one model for the whole town and a fixed decision loop. Here each
// agent can carry a brain record that names a CHAT model (writes the words) and an optional
// DECIDER model (small and cheap, answers yes/no questions), plus a PROGRAM that says which
// question to ask the decider at each decision point and what to do with the answer.
//
// The program is data, not code: a router of gates. A gate is one prompt to one model whose
// answer is matched against a keyword, and the match picks the branch. That keeps it editable
// at runtime -- patch the record and the next tick runs the new program, no rebuild -- without
// ever executing code supplied through a mutation that the network can reach.
//
// The cost shape is the point. When nobody is near, a tick makes no model call at all. When
// someone is near, the decider is asked whether it is worth talking. Only a yes reaches the
// chat model, which may be a hosted one that costs tokens.

import { ConvexError, Infer, v } from 'convex/values';
import {
  ActionCtx,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from '../_generated/server';
import { Doc, Id } from '../_generated/dataModel';
import { internal } from '../_generated/api';
import { agentId } from '../aiTown/ids';
import {
  CreateChatCompletionRequest,
  LLMConfig,
  ModelRef,
  chatCompletion,
  configForModel,
  getLLMConfig,
  isPaidProvider,
} from '../util/llm';
import { insertInput } from '../aiTown/insertInput';
import { characters } from '../../data/characters';

import {
  Program,
  ZERO_STATS,
  gate,
  modelRef,
  program,
} from './brainSchema';

// The router a brain runs when it has a decider but no program of its own. It is the
// two-tier gate: the decider filters, the chat model only runs on a yes.
export const DEFAULT_PROGRAM: Program = {
  alone: 'wander',
  tick: {
    maxDistance: 14,
    gate: {
      model: 'decider',
      prompt:
        'You are {name}. {identity}\n' +
        'You are out in town. {candidate} is {candidateDistance} tiles away and free to talk. ' +
        'Your last conversation ended {minutesSinceConversation} minutes ago.\n' +
        'Do you walk over and start a conversation with {candidate} now? ' +
        'Answer with exactly one word: YES or NO.',
      yes: 'YES',
      maxTokens: 4,
    },
    onYes: 'invite',
    onNo: 'wander',
  },
  converse: {
    maxMessages: 8,
    gate: {
      model: 'decider',
      prompt:
        'You are {name}, talking with {partner}. {numMessages} messages so far.\n' +
        'The conversation so far:\n{transcript}\n\n' +
        'Is there still something worth saying, or is it time to say goodbye? ' +
        'Answer with exactly one word: CONTINUE or LEAVE.',
      yes: 'CONTINUE',
      maxTokens: 4,
    },
    onYes: 'reply',
    onNo: 'leave',
    speaker: 'chat',
  },
};

// ---------------------------------------------------------------- who may write

// Brain and subscription writes go through public mutations, and the Convex port answers
// anyone who can reach it. So writes carry a registry key that only the identity-gated MCP
// server holds. With no key configured the registry is closed, not open.
export function requireRegistryKey(key: string) {
  const expected = process.env.TOWN_REGISTRY_KEY;
  if (!expected) {
    throw new ConvexError('the resident registry is closed: TOWN_REGISTRY_KEY is not set');
  }
  let diff = key.length ^ expected.length;
  for (let i = 0; i < Math.min(key.length, expected.length); i++) {
    diff |= key.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  if (diff !== 0) {
    throw new ConvexError('bad registry key');
  }
}

function checkProgram(p: Program | undefined) {
  if (!p) return;
  for (const g of [p.tick?.gate, p.converse?.gate]) {
    if (g && g.prompt.length > 4000) throw new ConvexError('gate prompt is too long');
    if (g && !g.yes.trim()) throw new ConvexError('a gate needs a non-empty yes word');
  }
  if (p.style && p.style.length > 2000) throw new ConvexError('style is too long');
}

// ---------------------------------------------------------------- public: register and edit

export const registerResident = mutation({
  args: {
    key: v.string(),
    worldId: v.id('worlds'),
    owner: v.string(),
    name: v.string(),
    character: v.string(),
    identity: v.string(),
    plan: v.string(),
    chat: modelRef,
    decider: v.optional(modelRef),
    program: v.optional(program),
  },
  handler: async (ctx, args) => {
    requireRegistryKey(args.key);
    checkProgram(args.program);
    const name = args.name.trim();
    if (!name || name.length > 32) throw new ConvexError('a name of 1 to 32 characters');
    if (!characters.find((c) => c.name === args.character)) {
      throw new ConvexError(
        `unknown character sprite ${args.character}; one of ${characters.map((c) => c.name).join(', ')}`,
      );
    }
    const taken = await ctx.db
      .query('playerDescriptions')
      .withIndex('worldId', (q) => q.eq('worldId', args.worldId))
      .filter((q) => q.eq(q.field('name'), name))
      .first();
    const world = await ctx.db.get(args.worldId);
    if (!world) throw new ConvexError('no such world');
    if (taken && world.players.some((p) => p.id === taken.playerId)) {
      throw new ConvexError(`${name} already lives here`);
    }
    const brainId = await ctx.db.insert('agentBrains', {
      worldId: args.worldId,
      name,
      owner: args.owner,
      chat: args.chat,
      decider: args.decider,
      program: args.program,
      stats: ZERO_STATS,
      updatedAt: Date.now(),
    });
    const inputId = await insertInput(ctx, args.worldId, 'createAgentFromSpec', {
      name,
      character: args.character,
      identity: args.identity,
      plan: args.plan,
      brainId,
    });
    return { brainId, inputId };
  },
});

// Give an existing resident -- one of the seeded townsfolk, say -- a brain of its own.
export const bindBrain = mutation({
  args: {
    key: v.string(),
    worldId: v.id('worlds'),
    owner: v.string(),
    agentId,
    name: v.string(),
    chat: modelRef,
    decider: v.optional(modelRef),
    program: v.optional(program),
  },
  handler: async (ctx, args) => {
    requireRegistryKey(args.key);
    checkProgram(args.program);
    const existing = await brainByAgent(ctx.db, args.worldId, args.agentId);
    if (existing) throw new ConvexError(`${args.name} already has a brain; update it instead`);
    return await ctx.db.insert('agentBrains', {
      worldId: args.worldId,
      name: args.name,
      owner: args.owner,
      agentId: args.agentId,
      chat: args.chat,
      decider: args.decider,
      program: args.program,
      stats: ZERO_STATS,
      updatedAt: Date.now(),
    });
  },
});

// Reprogram a brain. Takes effect on the agent's next decision; nothing is rebuilt.
export const updateBrain = mutation({
  args: {
    key: v.string(),
    brainId: v.id('agentBrains'),
    owner: v.string(),
    chat: v.optional(modelRef),
    decider: v.optional(v.union(modelRef, v.null())),
    program: v.optional(v.union(program, v.null())),
    identity: v.optional(v.string()),
    plan: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireRegistryKey(args.key);
    const brain = await ctx.db.get(args.brainId);
    if (!brain) throw new ConvexError('no such brain');
    if (brain.owner !== args.owner) {
      throw new ConvexError(`${brain.name} belongs to ${brain.owner}`);
    }
    checkProgram(args.program ?? undefined);
    const patch: Partial<Doc<'agentBrains'>> = { updatedAt: Date.now() };
    if (args.chat) patch.chat = args.chat;
    if (args.decider !== undefined) patch.decider = args.decider ?? undefined;
    if (args.program !== undefined) patch.program = args.program ?? undefined;
    await ctx.db.patch(brain._id, patch);
    if ((args.identity || args.plan) && brain.agentId) {
      await insertInput(ctx, brain.worldId, 'updateAgentDescription', {
        agentId: brain.agentId,
        identity: args.identity,
        plan: args.plan,
      });
    }
    return null;
  },
});

export const retireResident = mutation({
  args: { key: v.string(), brainId: v.id('agentBrains'), owner: v.string() },
  handler: async (ctx, args) => {
    requireRegistryKey(args.key);
    const brain = await ctx.db.get(args.brainId);
    if (!brain) throw new ConvexError('no such brain');
    if (brain.owner !== args.owner) {
      throw new ConvexError(`${brain.name} belongs to ${brain.owner}`);
    }
    if (!brain.agentId) throw new ConvexError(`${brain.name} has not moved in yet`);
    return await insertInput(ctx, brain.worldId, 'retireAgent', { agentId: brain.agentId });
  },
});

// ---------------------------------------------------------------- public: read

export const getBrain = query({
  args: { worldId: v.id('worlds'), name: v.string() },
  handler: async (ctx, args) => {
    const brains = await ctx.db
      .query('agentBrains')
      .withIndex('name', (q) => q.eq('worldId', args.worldId).eq('name', args.name))
      .collect();
    const brain = brains.sort((a, b) => b._creationTime - a._creationTime)[0];
    if (!brain) return null;
    return { ...brain, effectiveProgram: effectiveProgram(brain) };
  },
});

export const brainLog = query({
  args: { brainId: v.id('agentBrains'), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    return await ctx.db
      .query('brainLog')
      .withIndex('brainId', (q) => q.eq('brainId', args.brainId))
      .order('desc')
      .take(Math.min(args.limit ?? 20, 100));
  },
});

// ---------------------------------------------------------------- internal: the runtime

async function brainByAgent(db: any, worldId: Id<'worlds'>, agent: string) {
  // A resident registered at runtime carries its brain id on its description; a seeded
  // resident that was given one later is found by agent id.
  const desc = await db
    .query('agentDescriptions')
    .withIndex('worldId', (q: any) => q.eq('worldId', worldId).eq('agentId', agent))
    .first();
  if (desc?.brainId) {
    const brain = await db.get(desc.brainId);
    if (brain) return brain as Doc<'agentBrains'>;
  }
  return (await db
    .query('agentBrains')
    .withIndex('agentId', (q: any) => q.eq('worldId', worldId).eq('agentId', agent))
    .first()) as Doc<'agentBrains'> | null;
}

export function effectiveProgram(brain: Doc<'agentBrains'>): Program {
  // A brain with no program of its own runs the default router, gates and all; the decider
  // gates fall back to the chat model when there is no decider.
  return brain.program ?? DEFAULT_PROGRAM;
}

export const resolveBrain = internalQuery({
  args: { worldId: v.id('worlds'), agentId },
  handler: async (ctx, args) => {
    const brain = await brainByAgent(ctx.db, args.worldId, args.agentId);
    if (!brain) return null;
    const desc = await ctx.db
      .query('agentDescriptions')
      .withIndex('worldId', (q) => q.eq('worldId', args.worldId).eq('agentId', args.agentId))
      .first();
    return {
      brain,
      program: effectiveProgram(brain),
      identity: desc?.identity ?? '',
      plan: desc?.plan ?? '',
    };
  },
});
export type ResolvedBrain = {
  brain: Doc<'agentBrains'>;
  program: Program;
  identity: string;
  plan: string;
};

const LOG_KEEP = 200;

export const record = internalMutation({
  args: {
    brainId: v.id('agentBrains'),
    agentId: v.optional(agentId),
    bump: v.optional(
      v.object({
        idleTicks: v.optional(v.number()),
        gateCalls: v.optional(v.number()),
        gateYes: v.optional(v.number()),
        chatCalls: v.optional(v.number()),
        fallbacks: v.optional(v.number()),
      }),
    ),
    log: v.optional(
      v.object({
        phase: v.string(),
        role: v.string(),
        provider: v.string(),
        model: v.string(),
        paid: v.boolean(),
        ms: v.number(),
        answer: v.string(),
        outcome: v.string(),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const brain = await ctx.db.get(args.brainId);
    if (!brain) return;
    const patch: Partial<Doc<'agentBrains'>> = {};
    // A resident registered at runtime learns its agent id only once the engine has made it.
    if (args.agentId && !brain.agentId) patch.agentId = args.agentId;
    if (args.bump) {
      const s = { ...ZERO_STATS, ...(brain.stats ?? {}) };
      for (const [k, n] of Object.entries(args.bump)) {
        (s as any)[k] += n ?? 0;
      }
      patch.stats = s;
    }
    if (Object.keys(patch).length) await ctx.db.patch(brain._id, patch);
    if (args.log) {
      await ctx.db.insert('brainLog', {
        worldId: brain.worldId,
        brainId: brain._id,
        at: Date.now(),
        ...args.log,
      });
      // Keep the log bounded: once it is over the cap, drop whatever falls off the end.
      const recent = await ctx.db
        .query('brainLog')
        .withIndex('brainId', (q) => q.eq('brainId', brain._id))
        .order('desc')
        .take(LOG_KEEP + 5);
      for (const old of recent.slice(LOG_KEEP)) await ctx.db.delete(old._id);
    }
  },
});

// ---------------------------------------------------------------- calling the models

type Role = 'chat' | 'decider';

function refFor(brain: Doc<'agentBrains'>, role: Role): ModelRef {
  return role === 'decider' && brain.decider ? brain.decider : brain.chat;
}

export function fill(template: string, vars: Record<string, string | number>) {
  return template.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

// One model call on behalf of a brain, logged with the model that actually answered. If the
// brain's model fails (a hosted key is missing, a local model is not pulled), it falls back
// to the town's default model rather than leaving the resident frozen, and says so in the log.
export async function brainComplete(
  ctx: ActionCtx,
  brain: Doc<'agentBrains'>,
  role: Role,
  phase: string,
  body: Omit<CreateChatCompletionRequest, 'model'> & { stream?: false },
  outcomeOf: (answer: string) => string = () => 'spoke',
): Promise<string> {
  const ref = refFor(brain, role);
  let config: LLMConfig;
  let fellBack = false;
  try {
    config = configForModel(ref);
  } catch (e: any) {
    console.warn(`brain ${brain.name}: ${e.message}; using the town default`);
    config = getLLMConfig();
    fellBack = true;
  }
  const started = Date.now();
  let content: string;
  try {
    ({ content } = await chatCompletion({ ...body, stream: false }, config));
  } catch (e: any) {
    if (fellBack) throw e;
    console.warn(`brain ${brain.name}: ${ref.provider}/${ref.model} failed: ${e.message}`);
    config = getLLMConfig();
    fellBack = true;
    ({ content } = await chatCompletion({ ...body, stream: false }, config));
  }
  const ms = Date.now() - started;
  const isGate = phase.endsWith(':gate');
  await ctx.runMutation(internal.agent.brain.record, {
    brainId: brain._id,
    bump: {
      ...(isGate ? { gateCalls: 1 } : { chatCalls: 1 }),
      ...(fellBack ? { fallbacks: 1 } : {}),
    },
    log: {
      phase,
      role: fellBack ? `${role} (fallback)` : role,
      provider: config.provider === 'custom' ? ref.provider : config.provider,
      model: config.chatModel,
      paid: fellBack ? config.provider !== 'ollama' : isPaidProvider(ref.provider),
      ms,
      answer: content.slice(0, 400),
      outcome: outcomeOf(content),
    },
  });
  return content;
}

// Ask a gate. Returns true for a yes. A gate that errors counts as a no: the cheap,
// do-less branch is the safe one.
export async function askGate(
  ctx: ActionCtx,
  brain: Doc<'agentBrains'>,
  phase: string,
  g: Infer<typeof gate>,
  vars: Record<string, string | number>,
): Promise<boolean> {
  const yesWord = g.yes.trim().toUpperCase();
  try {
    const answer = await brainComplete(
      ctx,
      brain,
      g.model,
      `${phase}:gate`,
      {
        messages: [{ role: 'user', content: fill(g.prompt, vars) }],
        max_tokens: g.maxTokens ?? 4,
        temperature: 0.2,
      },
      (a) => (a.toUpperCase().includes(yesWord) ? 'yes' : 'no'),
    );
    const yes = answer.toUpperCase().includes(yesWord);
    if (yes) {
      await ctx.runMutation(internal.agent.brain.record, { brainId: brain._id, bump: { gateYes: 1 } });
    }
    return yes;
  } catch (e: any) {
    console.error(`gate failed for ${brain.name}: ${e.message}`);
    return false;
  }
}
