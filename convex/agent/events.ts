// Tell a character's driver when something happens TO that character, and stay silent
// otherwise.
//
// A character driven from outside the town (by an agent over MCP) used to have to poll the
// world to notice an invitation or a reply. That is the wrong shape twice over: the engine
// stops itself when nobody is viewing the world, so a poller mostly reads a frozen town, and
// the interesting moments are rare. So the town records an event only when a conversation is
// started with a subscribed human player or a message is written to one. Agent-to-agent
// chatter, and anything aimed at a character nobody subscribed, records nothing.
//
// Delivery is Convex's own push: the driver holds a live subscription to `eventsFor` and the
// deployment sends it the new result the moment an event lands. Nothing polls, and the
// backend never makes an outbound call.

import { v } from 'convex/values';
import { MutationCtx, internalMutation, mutation, query } from '../_generated/server';
import { Id } from '../_generated/dataModel';
import { conversationId, playerId } from '../aiTown/ids';
import { requireRegistryKey } from './brain';

const LOG_KEEP = 300;

export const subscribe = mutation({
  args: { key: v.string(), worldId: v.id('worlds'), name: v.string(), owner: v.string() },
  handler: async (ctx, args) => {
    requireRegistryKey(args.key);
    const existing = await ctx.db
      .query('eventSubscriptions')
      .withIndex('name', (q) => q.eq('worldId', args.worldId).eq('name', args.name))
      .first();
    if (existing) return existing._id;
    return await ctx.db.insert('eventSubscriptions', {
      worldId: args.worldId,
      name: args.name,
      owner: args.owner,
      createdAt: Date.now(),
    });
  },
});

export const unsubscribe = mutation({
  args: { key: v.string(), worldId: v.id('worlds'), name: v.string() },
  handler: async (ctx, args) => {
    requireRegistryKey(args.key);
    const subs = await ctx.db
      .query('eventSubscriptions')
      .withIndex('name', (q) => q.eq('worldId', args.worldId).eq('name', args.name))
      .collect();
    for (const s of subs) await ctx.db.delete(s._id);
    return subs.length;
  },
});

export const getEvent = query({
  args: { eventId: v.id('eventLog') },
  handler: async (ctx, args) => ctx.db.get(args.eventId),
});

export const recentEvents = query({
  args: { worldId: v.id('worlds'), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    return await ctx.db
      .query('eventLog')
      .withIndex('at', (q) => q.eq('worldId', args.worldId))
      .order('desc')
      .take(Math.min(args.limit ?? 20, 100));
  },
});

// What a driver subscribes to: the unacknowledged events for one character, oldest first.
export const eventsFor = query({
  args: { worldId: v.id('worlds'), name: v.string() },
  handler: async (ctx, args) => {
    const recent = await ctx.db
      .query('eventLog')
      .withIndex('at', (q) => q.eq('worldId', args.worldId))
      .order('desc')
      .take(100);
    return recent.filter((e) => e.to === args.name && e.status === 'new').reverse();
  },
});

export const ackEvents = mutation({
  args: { key: v.string(), eventIds: v.array(v.id('eventLog')) },
  handler: async (ctx, args) => {
    requireRegistryKey(args.key);
    for (const id of args.eventIds) {
      if (await ctx.db.get(id)) await ctx.db.patch(id, { status: 'seen' });
    }
  },
});

async function nameOf(ctx: MutationCtx, worldId: Id<'worlds'>, player: string) {
  const d = await ctx.db
    .query('playerDescriptions')
    .withIndex('worldId', (q) => q.eq('worldId', worldId).eq('playerId', player))
    .first();
  return d?.name ?? player;
}

async function queueEvent(
  ctx: MutationCtx,
  worldId: Id<'worlds'>,
  recipient: string,
  event: {
    kind: 'invite' | 'message';
    from: string;
    conversationId: string;
    text?: string;
    leaving?: boolean;
  },
) {
  const to = await nameOf(ctx, worldId, recipient);
  const sub = await ctx.db
    .query('eventSubscriptions')
    .withIndex('name', (q) => q.eq('worldId', worldId).eq('name', to))
    .first();
  if (!sub) return; // Nobody is listening for this character: fire nothing.
  await ctx.db.insert('eventLog', {
    worldId,
    at: Date.now(),
    to,
    from: await nameOf(ctx, worldId, event.from),
    kind: event.kind,
    conversationId: event.conversationId,
    text: event.text,
    leaving: event.leaving,
    status: 'new',
  });
  const recent = await ctx.db
    .query('eventLog')
    .withIndex('at', (q) => q.eq('worldId', worldId))
    .order('desc')
    .take(LOG_KEEP + 5);
  for (const old of recent.slice(LOG_KEEP)) await ctx.db.delete(old._id);
}

// A message was written. Tell the OTHER participant, if it is a subscribed human player.
export async function notifyMessage(
  ctx: MutationCtx,
  args: {
    worldId: Id<'worlds'>;
    conversationId: string;
    author: string;
    text: string;
    leaving?: boolean;
  },
) {
  const world = await ctx.db.get(args.worldId);
  const conversation = world?.conversations.find((c) => c.id === args.conversationId);
  if (!world || !conversation) return;
  for (const member of conversation.participants) {
    if (member.playerId === args.author) continue;
    const player = world.players.find((p) => p.id === member.playerId);
    if (!player?.human) continue;
    await queueEvent(ctx, args.worldId, member.playerId, {
      kind: 'message',
      from: args.author,
      conversationId: args.conversationId,
      text: args.text,
      leaving: args.leaving,
    });
  }
}

// Scheduled by the engine when a conversation is started with a human player as invitee.
export const notifyInvite = internalMutation({
  args: { worldId: v.id('worlds'), conversationId, inviter: playerId, invitee: playerId },
  handler: async (ctx, args) => {
    await queueEvent(ctx, args.worldId, args.invitee, {
      kind: 'invite',
      from: args.inviter,
      conversationId: args.conversationId,
    });
  },
});
