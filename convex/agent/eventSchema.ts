// Table shapes for the town's outbound events. See events.ts.

import { v } from 'convex/values';
import { conversationId } from '../aiTown/ids';

export const eventTables = {
  // A character that wants to be told when someone invites it or speaks to it.
  eventSubscriptions: {
    worldId: v.id('worlds'),
    name: v.string(),
    owner: v.string(),
    createdAt: v.number(),
  },
  // Every event that fired; status is new until the driver acknowledges it. Bounded.
  eventLog: {
    worldId: v.id('worlds'),
    at: v.number(),
    kind: v.union(v.literal('invite'), v.literal('message')),
    to: v.string(),
    from: v.string(),
    conversationId,
    text: v.optional(v.string()),
    leaving: v.optional(v.boolean()),
    status: v.string(),
  },
};
