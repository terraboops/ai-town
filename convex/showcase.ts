// The TV showcase's highlight reel: the day's best lines, by category.
//
// Ranking is a two-model pipeline, and it never runs on the render path:
//   1. Every new message is embedded (the town's own embedding model, through its cache).
//      Novelty = 1 - its nearest neighbour's similarity among the day's earlier lines. That is
//      cheap, needs no prompt, and is what "weird" mostly means in a town that repeats itself.
//   2. A shortlist -- lines long enough to say something -- goes to the chat model in ONE
//      batched call that scores each line 0-9 for silly, thoughtful, weird and dramatic.
// Each message is scored once and the scores are stored, so the reel is a plain query.
//
// Nothing polls. Writing a message calls requestRanking, which schedules ONE ranking run a
// little later if none is pending; that run takes everything new in one batch. A quiet town
// schedules nothing and calls no model.

import { v } from 'convex/values';
import { ActionCtx, MutationCtx, internalAction, internalMutation, internalQuery, query } from './_generated/server';
import { internal } from './_generated/api';
import { Doc, Id } from './_generated/dataModel';
import * as embeddingsCache from './agent/embeddingsCache';
import { chatCompletion, getLLMConfig } from './util/llm';

// Wait for a conversation's next few lines before ranking, so a batch is several lines.
const RANK_DELAY_MS = 45_000;
const BATCH = 12;
const DAY_MS = 24 * 60 * 60 * 1000;
// Shorter lines ("Ha!", "Goodbye!") are embedded for novelty but never sent to the judge.
const MIN_JUDGED_LENGTH = 30;

export const showcaseTables = {
  messageScores: {
    worldId: v.id('worlds'),
    messageId: v.id('messages'),
    conversationId: v.string(),
    author: v.string(),
    authorName: v.string(),
    text: v.string(),
    at: v.number(),
    novelty: v.number(),
    judged: v.boolean(),
    silly: v.number(),
    thoughtful: v.number(),
    weird: v.number(),
    dramatic: v.number(),
    model: v.string(),
  },
  // Kept apart from the scores so the reel query never drags 1024 floats per line around.
  messageVectors: {
    worldId: v.id('worlds'),
    at: v.number(),
    embedding: v.array(v.float64()),
  },
  rankerState: {
    worldId: v.id('worlds'),
    pending: v.boolean(),
    cursor: v.number(), // _creationTime of the last message taken into a batch
    runs: v.number(),
    emptyRuns: v.number(),
    scored: v.number(),
    embedCalls: v.number(),
    judgeCalls: v.number(),
    judgeModel: v.string(),
    embedModel: v.string(),
    lastRunAt: v.number(),
    lastRunMs: v.number(),
  },
};

async function stateFor(ctx: MutationCtx, worldId: Id<'worlds'>) {
  return await ctx.db
    .query('rankerState')
    .withIndex('worldId', (q) => q.eq('worldId', worldId))
    .first();
}

// Called wherever a message is written. Schedules one ranking run unless one is pending.
export async function requestRanking(ctx: MutationCtx, worldId: Id<'worlds'>) {
  const state = await stateFor(ctx, worldId);
  if (state?.pending) return;
  if (state) {
    await ctx.db.patch(state._id, { pending: true });
  } else {
    const config = getLLMConfig();
    await ctx.db.insert('rankerState', {
      worldId,
      pending: true,
      // Start with today's lines, not the town's whole history.
      cursor: Date.now() - DAY_MS,
      runs: 0,
      emptyRuns: 0,
      scored: 0,
      embedCalls: 0,
      judgeCalls: 0,
      judgeModel: config.chatModel,
      embedModel: config.embeddingModel,
      lastRunAt: 0,
      lastRunMs: 0,
    });
  }
  await ctx.scheduler.runAfter(RANK_DELAY_MS, internal.showcase.rankNew, { worldId });
}

export const nextBatch = internalQuery({
  args: { worldId: v.id('worlds') },
  handler: async (ctx, { worldId }) => {
    const state = await ctx.db
      .query('rankerState')
      .withIndex('worldId', (q) => q.eq('worldId', worldId))
      .first();
    const cursor = state?.cursor ?? Date.now() - DAY_MS;
    const fresh = await ctx.db
      .query('messages')
      .withIndex('by_creation_time', (q) => q.gt('_creationTime', cursor))
      .filter((q) => q.eq(q.field('worldId'), worldId))
      .take(BATCH);
    const since = Date.now() - DAY_MS;
    const earlier = await ctx.db
      .query('messageVectors')
      .withIndex('worldId', (q) => q.eq('worldId', worldId).gt('at', since))
      .collect();
    const names: Record<string, string> = {};
    for (const m of fresh) {
      if (names[m.author]) continue;
      const d = await ctx.db
        .query('playerDescriptions')
        .withIndex('worldId', (q) => q.eq('worldId', worldId).eq('playerId', m.author))
        .first();
      names[m.author] = d?.name ?? m.author;
    }
    return {
      messages: fresh.map((m) => ({
        _id: m._id,
        at: m._creationTime,
        author: m.author,
        authorName: names[m.author],
        conversationId: m.conversationId,
        text: m.text,
      })),
      earlier: earlier.map((e) => e.embedding),
    };
  },
});

function cosine(a: number[], b: number[]) {
  let dot = 0,
    na = 0,
    nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

type Scores = { silly: number; thoughtful: number; weird: number; dramatic: number };

// One call scores the whole shortlist. Small local models drift from strict JSON, so the
// answer is read line by line: "<n>: silly thoughtful weird dramatic".
async function judge(lines: { n: number; who: string; text: string }[]) {
  const prompt =
    'You are judging lines of dialogue from a small simulated town, for a highlight reel.\n' +
    'For each numbered line, give four scores from 0 to 9:\n' +
    '  silly (funny, absurd, playful), thoughtful (wise, kind, insightful),\n' +
    '  weird (strange, surreal, non sequitur), dramatic (emotional, grand, theatrical).\n' +
    'Most ordinary lines score low. Save 8 and 9 for the few that truly stand out.\n' +
    'Answer with exactly one line per input, in this format and nothing else:\n' +
    '<number>: <silly> <thoughtful> <weird> <dramatic>\n\n' +
    lines.map((l) => `${l.n}. ${l.who}: "${l.text.replace(/\s+/g, ' ').slice(0, 300)}"`).join('\n');
  const { content } = await chatCompletion({
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 20 * lines.length + 20,
    temperature: 0,
  });
  const out = new Map<number, Scores>();
  for (const row of content.split('\n')) {
    const m = row.match(/(\d+)\s*[:.)]\s*(\d)\D+(\d)\D+(\d)\D+(\d)/);
    if (!m) continue;
    out.set(Number(m[1]), {
      silly: Number(m[2]),
      thoughtful: Number(m[3]),
      weird: Number(m[4]),
      dramatic: Number(m[5]),
    });
  }
  return out;
}

export const rankNew = internalAction({
  args: { worldId: v.id('worlds') },
  handler: async (ctx: ActionCtx, { worldId }) => {
    const started = Date.now();
    const { messages, earlier } = await ctx.runQuery(internal.showcase.nextBatch, { worldId });
    if (!messages.length) {
      // The cheap path: nothing new, no model called.
      await ctx.runMutation(internal.showcase.recordRun, {
        worldId,
        cursor: undefined,
        rows: [],
        embedCalls: 0,
        judgeCalls: 0,
        ms: Date.now() - started,
        more: false,
      });
      return;
    }
    const config = getLLMConfig();
    const { embeddings } = await embeddingsCache.fetchBatch(
      ctx,
      messages.map((m) => m.text),
    );
    const seen = [...earlier];
    const novelty = embeddings.map((e) => {
      const nearest = seen.reduce((best, s) => Math.max(best, cosine(e, s)), 0);
      seen.push(e);
      return seen.length === 1 ? 0.5 : Math.max(0, 1 - nearest);
    });
    const shortlist = messages
      .map((m, i) => ({ n: i + 1, who: m.authorName, text: m.text }))
      .filter((l) => l.text.length >= MIN_JUDGED_LENGTH);
    let scores = new Map<number, Scores>();
    let judgeCalls = 0;
    if (shortlist.length) {
      try {
        scores = await judge(shortlist);
        judgeCalls = 1;
      } catch (e: any) {
        console.error('showcase judge failed; lines keep novelty only', e?.message ?? e);
      }
    }
    const rows = messages.map((m, i) => {
      const s = scores.get(i + 1);
      return {
        messageId: m._id,
        conversationId: m.conversationId,
        author: m.author,
        authorName: m.authorName,
        text: m.text,
        at: m.at,
        novelty: novelty[i],
        judged: Boolean(s),
        silly: s?.silly ?? 0,
        thoughtful: s?.thoughtful ?? 0,
        weird: s?.weird ?? 0,
        dramatic: s?.dramatic ?? 0,
        model: s ? `${config.chatModel} + ${config.embeddingModel}` : config.embeddingModel,
        embedding: embeddings[i],
      };
    });
    await ctx.runMutation(internal.showcase.recordRun, {
      worldId,
      cursor: messages[messages.length - 1].at,
      rows,
      embedCalls: 1,
      judgeCalls,
      ms: Date.now() - started,
      more: messages.length === BATCH,
    });
  },
});

export const recordRun = internalMutation({
  args: {
    worldId: v.id('worlds'),
    cursor: v.optional(v.number()),
    rows: v.array(v.any()),
    embedCalls: v.number(),
    judgeCalls: v.number(),
    ms: v.number(),
    more: v.boolean(),
  },
  handler: async (ctx, args) => {
    for (const r of args.rows) {
      const already = await ctx.db
        .query('messageScores')
        .withIndex('messageId', (q) => q.eq('messageId', r.messageId))
        .first();
      if (already) continue; // scored once, ever
      const { embedding, ...row } = r;
      await ctx.db.insert('messageScores', { worldId: args.worldId, ...row });
      await ctx.db.insert('messageVectors', { worldId: args.worldId, at: r.at, embedding });
    }
    const state = (await stateFor(ctx, args.worldId))!;
    await ctx.db.patch(state._id, {
      cursor: args.cursor ?? state.cursor,
      runs: state.runs + 1,
      emptyRuns: state.emptyRuns + (args.rows.length ? 0 : 1),
      scored: state.scored + args.rows.length,
      embedCalls: state.embedCalls + args.embedCalls,
      judgeCalls: state.judgeCalls + args.judgeCalls,
      lastRunAt: Date.now(),
      lastRunMs: args.ms,
      // A full batch means more is waiting: go again now. Otherwise sleep until a message.
      pending: args.more,
    });
    if (args.more) await ctx.scheduler.runAfter(0, internal.showcase.rankNew, { worldId: args.worldId });
  },
});

// ---------------------------------------------------------------- the reel

type Line = Pick<Doc<'messageScores'>, 'authorName' | 'text' | 'at' | 'conversationId'> & {
  score: number;
};

const pick = (r: Doc<'messageScores'>, score: number): Line => ({
  authorName: r.authorName,
  text: r.text,
  at: r.at,
  conversationId: r.conversationId,
  score: Math.round(score * 10) / 10,
});

export const reel = query({
  args: { worldId: v.id('worlds') },
  handler: async (ctx, { worldId }) => {
    const since = Date.now() - DAY_MS;
    const rows = await ctx.db
      .query('messageScores')
      .withIndex('worldId', (q) => q.eq('worldId', worldId).gt('at', since))
      .collect();
    const judged = rows.filter((r) => r.judged);
    const top = (score: (r: Doc<'messageScores'>) => number, n = 3) =>
      judged
        .map((r) => ({ r, s: score(r) }))
        .filter(({ s }) => s > 0)
        .sort((a, b) => b.s - a.s)
        .slice(0, n)
        .map(({ r, s }) => pick(r, s));

    // Conversation-level categories.
    const byConversation = new Map<string, Doc<'messageScores'>[]>();
    for (const r of rows) {
      const list = byConversation.get(r.conversationId) ?? [];
      list.push(r);
      byConversation.set(r.conversationId, list);
    }
    const conversations = [...byConversation.entries()]
      .map(([id, lines]) => {
        lines.sort((a, b) => a.at - b.at);
        const j = lines.filter((l) => l.judged);
        const strangeness = j.length
          ? j.reduce((s, l) => s + l.weird + 4 * l.novelty, 0) / j.length
          : 0;
        return { id, lines, strangeness, people: [...new Set(lines.map((l) => l.authorName))] };
      })
      .filter((c) => c.people.length >= 2 && c.lines.length >= 3);
    const asInteraction = (c: (typeof conversations)[number], score: number) => ({
      conversationId: c.id,
      people: c.people,
      score: Math.round(score * 10) / 10,
      lines: c.lines.slice(0, 4).map((l) => pick(l, 0)),
      total: c.lines.length,
    });
    const strangest = [...conversations].sort((a, b) => b.strangeness - a.strangeness)[0];
    const longest = [...conversations].sort((a, b) => b.lines.length - a.lines.length)[0];

    return {
      lines: rows.length,
      judged: judged.length,
      categories: [
        { key: 'silliest', title: 'Silliest line today', lines: top((r) => r.silly) },
        { key: 'thoughtful', title: 'Most thoughtful', lines: top((r) => r.thoughtful) },
        // Weird is the judge's call plus how unlike anything else said today the line is.
        { key: 'weirdest', title: 'Weirdest thing said', lines: top((r) => r.weird + 4 * r.novelty) },
        { key: 'dramatic', title: 'Most dramatic moment', lines: top((r) => r.dramatic) },
      ],
      interactions: [
        strangest && { key: 'strangest', title: 'Strangest interaction', ...asInteraction(strangest, strangest.strangeness) },
        longest && { key: 'longest', title: 'Longest conversation', ...asInteraction(longest, longest.lines.length) },
      ].filter(Boolean),
    };
  },
});

// For the report and for anyone curious: what the ranker has done.
export const rankerStatus = query({
  args: { worldId: v.id('worlds') },
  handler: async (ctx, { worldId }) => {
    return await ctx.db
      .query('rankerState')
      .withIndex('worldId', (q) => q.eq('worldId', worldId))
      .first();
  },
});
