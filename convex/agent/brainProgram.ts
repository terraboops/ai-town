// Runs a resident's program at the two decision points upstream hard-codes: what to do next
// when idle (agentDoSomething), and whether to keep talking when it is our turn
// (agentGenerateMessage). The program is a router -- see brain.ts -- and this is the only
// code that interprets it.

import { v } from 'convex/values';
import { ActionCtx, internalQuery } from '../_generated/server';
import { Id } from '../_generated/dataModel';
import { api, internal } from '../_generated/api';
import { ACTIVITIES, ACTIVITY_COOLDOWN, CONVERSATION_COOLDOWN } from '../constants';
import { distance } from '../util/geometry';
import { WorldMap } from '../aiTown/worldMap';
import { SerializedPlayer } from '../aiTown/player';
import { SerializedAgent } from '../aiTown/agent';
import { ResolvedBrain, askGate, brainComplete } from './brain';
import { Speak } from './conversation';

export const playerNames = internalQuery({
  args: { worldId: v.id('worlds'), playerIds: v.array(v.string()) },
  handler: async (ctx, args) => {
    const out: Record<string, string> = {};
    for (const id of args.playerIds) {
      const d = await ctx.db
        .query('playerDescriptions')
        .withIndex('worldId', (q) => q.eq('worldId', args.worldId).eq('playerId', id))
        .first();
      out[id] = d?.name ?? id;
    }
    return out;
  },
});

type TickResult = {
  destination?: { x: number; y: number };
  invitee?: string;
  activity?: { description: string; emoji?: string; until: number };
  declinedInvite?: boolean;
};

function wanderDestination(worldMap: WorldMap) {
  return {
    x: 1 + Math.floor(Math.random() * (worldMap.width - 2)),
    y: 1 + Math.floor(Math.random() * (worldMap.height - 2)),
  };
}

function act(
  action: 'invite' | 'wander' | 'activity' | 'idle',
  rb: ResolvedBrain,
  map: WorldMap,
  invitee?: string,
): TickResult {
  const now = Date.now();
  switch (action) {
    case 'invite':
      return { invitee };
    case 'wander':
      return { destination: wanderDestination(map) };
    case 'activity': {
      const choices = rb.program.activities?.length
        ? rb.program.activities.map((a) => ({ ...a, duration: a.seconds * 1000 }))
        : ACTIVITIES;
      const a = choices[Math.floor(Math.random() * choices.length)];
      return { activity: { description: a.description, emoji: a.emoji, until: now + a.duration } };
    }
    case 'idle':
      return { activity: { description: 'idling', emoji: '💤', until: now + 20_000 } };
  }
}

// The idle-time decision. Returns the arguments for finishDoSomething.
export async function brainTick(
  ctx: ActionCtx,
  args: {
    worldId: Id<'worlds'>;
    player: SerializedPlayer;
    agent: SerializedAgent;
    otherFreePlayers: SerializedPlayer[];
  },
  rb: ResolvedBrain,
  map: WorldMap,
): Promise<TickResult> {
  const { player, agent } = args;
  const program = rb.program;
  const now = Date.now();
  const justLeftConversation =
    agent.lastConversation && now < agent.lastConversation + CONVERSATION_COOLDOWN;
  const recentlyConsidered =
    agent.lastInviteAttempt && now < agent.lastInviteAttempt + CONVERSATION_COOLDOWN;

  // Is there anybody worth a thought? This part is plain code and costs nothing.
  let candidate: { id: string; distance: number } | undefined;
  if (program.tick && !justLeftConversation && !recentlyConsidered) {
    const id = await ctx.runQuery(internal.aiTown.agent.findConversationCandidate, {
      now,
      worldId: args.worldId,
      player: args.player,
      otherFreePlayers: args.otherFreePlayers,
    });
    const other = id && args.otherFreePlayers.find((p) => p.id === id);
    if (other) {
      const d = distance(player.position, other.position);
      if (d <= (program.tick.maxDistance ?? Infinity)) {
        candidate = { id: other.id, distance: d };
      }
    }
  }

  if (!candidate) {
    // Nothing is happening: no model is called. Keep walking if already walking.
    await ctx.runMutation(internal.agent.brain.record, {
      brainId: rb.brain._id,
      agentId: agent.id,
      bump: { idleTicks: 1 },
    });
    if (player.pathfinding) return {};
    const recentActivity = player.activity && now < player.activity.until + ACTIVITY_COOLDOWN;
    const alone = program.alone ?? 'wander';
    // Mirror upstream's rhythm: after an activity or a conversation, move on.
    return act(alone === 'activity' && (recentActivity || justLeftConversation) ? 'wander' : alone, rb, map);
  }

  const tick = program.tick!;
  const names = await ctx.runQuery(internal.agent.brainProgram.playerNames, {
    worldId: args.worldId,
    playerIds: [player.id, candidate.id],
  });
  const yes = tick.gate
    ? await askGate(ctx, rb.brain, 'tick', tick.gate, {
        name: names[player.id],
        identity: rb.identity,
        plan: rb.plan,
        candidate: names[candidate.id],
        candidateDistance: candidate.distance.toFixed(1),
        minutesSinceConversation: agent.lastConversation
          ? ((now - agent.lastConversation) / 60_000).toFixed(1)
          : 'a long time ago',
      })
    : true;
  const action = yes ? tick.onYes : tick.onNo;
  const result = act(action, rb, map, candidate.id);
  if (action !== 'invite') result.declinedInvite = true;
  return result;
}

// Our turn in a conversation. Decides whether this turn continues or wraps up, and returns
// the speaker that will write the words.
export async function brainTurn(
  ctx: ActionCtx,
  args: {
    worldId: Id<'worlds'>;
    conversationId: string;
    playerId: string;
    otherPlayerId: string;
    type: 'start' | 'continue' | 'leave';
  },
  rb: ResolvedBrain,
): Promise<{ type: 'start' | 'continue' | 'leave'; speak: Speak }> {
  const converse = rb.program.converse;
  let type = args.type;
  if (type === 'continue' && converse) {
    const messages = await ctx.runQuery(api.messages.listMessages, {
      worldId: args.worldId,
      conversationId: args.conversationId,
    });
    if (converse.maxMessages && messages.length >= converse.maxMessages) {
      type = 'leave';
    } else if (converse.gate) {
      const names = await ctx.runQuery(internal.agent.brainProgram.playerNames, {
        worldId: args.worldId,
        playerIds: [args.playerId, args.otherPlayerId],
      });
      const transcript = messages
        .slice(-8)
        .map((m) => `${m.authorName}: ${m.text}`)
        .join('\n');
      const yes = await askGate(ctx, rb.brain, 'converse', converse.gate, {
        name: names[args.playerId],
        identity: rb.identity,
        plan: rb.plan,
        partner: names[args.otherPlayerId],
        numMessages: messages.length,
        lastMessage: messages[messages.length - 1]?.text ?? '',
        transcript: transcript || '(nothing yet)',
      });
      type = (yes ? converse.onYes : converse.onNo) === 'leave' ? 'leave' : 'continue';
    }
  }
  const role = converse?.speaker ?? 'chat';
  const speak: Speak = Object.assign(
    (body: Parameters<Speak>[0]) => brainComplete(ctx, rb.brain, role, `converse:${type}`, body),
    { style: rb.program.style },
  );
  return { type, speak };
}

