import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';
import { agentTables } from './agent/schema';
import { aiTownTables } from './aiTown/schema';
import { conversationId, playerId } from './aiTown/ids';
import { engineTables } from './engine/schema';
import { showcaseTables } from './showcase';

export default defineSchema({
  music: defineTable({
    storageId: v.string(),
    type: v.union(v.literal('background'), v.literal('player')),
  }),

  messages: defineTable({
    conversationId,
    messageUuid: v.string(),
    author: playerId,
    text: v.string(),
    worldId: v.optional(v.id('worlds')),
  })
    .index('conversationId', ['worldId', 'conversationId'])
    .index('messageUuid', ['conversationId', 'messageUuid']),

  ...agentTables,
  ...aiTownTables,
  ...engineTables,

  // The TV showcase's highlight reel. See showcase.ts.
  messageScores: defineTable(showcaseTables.messageScores)
    .index('worldId', ['worldId', 'at'])
    .index('messageId', ['messageId']),
  messageVectors: defineTable(showcaseTables.messageVectors).index('worldId', ['worldId', 'at']),
  rankerState: defineTable(showcaseTables.rankerState).index('worldId', ['worldId']),
});
