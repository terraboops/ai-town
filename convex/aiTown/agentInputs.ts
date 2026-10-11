import { v } from 'convex/values';
import { agentId, conversationId, parseGameId } from './ids';
import { Player, activity } from './player';
import { Conversation, conversationInputs } from './conversation';
import { movePlayer } from './movement';
import { inputHandler } from './inputHandler';
import { point } from '../util/types';
import { Descriptions } from '../../data/characters';
import { AgentDescription } from './agentDescription';
import { Agent } from './agent';

export const agentInputs = {
  finishRememberConversation: inputHandler({
    args: {
      operationId: v.string(),
      agentId,
    },
    handler: (game, now, args) => {
      const agentId = parseGameId('agents', args.agentId);
      const agent = game.world.agents.get(agentId);
      if (!agent) {
        throw new Error(`Couldn't find agent: ${agentId}`);
      }
      if (
        !agent.inProgressOperation ||
        agent.inProgressOperation.operationId !== args.operationId
      ) {
        console.debug(`Agent ${agentId} isn't remembering ${args.operationId}`);
      } else {
        delete agent.inProgressOperation;
        delete agent.toRemember;
      }
      return null;
    },
  }),
  finishDoSomething: inputHandler({
    args: {
      operationId: v.string(),
      agentId: v.id('agents'),
      destination: v.optional(point),
      invitee: v.optional(v.id('players')),
      activity: v.optional(activity),
      // The brain considered someone and decided against it: back off as if it had asked,
      // so the question is not put to the model again on the very next tick.
      declinedInvite: v.optional(v.boolean()),
    },
    handler: (game, now, args) => {
      const agentId = parseGameId('agents', args.agentId);
      const agent = game.world.agents.get(agentId);
      if (!agent) {
        throw new Error(`Couldn't find agent: ${agentId}`);
      }
      if (
        !agent.inProgressOperation ||
        agent.inProgressOperation.operationId !== args.operationId
      ) {
        console.debug(`Agent ${agentId} didn't have ${args.operationId} in progress`);
        return null;
      }
      delete agent.inProgressOperation;
      const player = game.world.players.get(agent.playerId)!;
      if (args.invitee) {
        const inviteeId = parseGameId('players', args.invitee);
        const invitee = game.world.players.get(inviteeId);
        if (!invitee) {
          throw new Error(`Couldn't find player: ${inviteeId}`);
        }
        Conversation.start(game, now, player, invitee);
        agent.lastInviteAttempt = now;
      }
      if (args.destination) {
        movePlayer(game, now, player, args.destination);
      }
      if (args.activity) {
        player.activity = args.activity;
      }
      if (args.declinedInvite) {
        agent.lastInviteAttempt = now;
      }
      return null;
    },
  }),
  agentFinishSendingMessage: inputHandler({
    args: {
      agentId,
      conversationId,
      timestamp: v.number(),
      operationId: v.string(),
      leaveConversation: v.boolean(),
    },
    handler: (game, now, args) => {
      const agentId = parseGameId('agents', args.agentId);
      const agent = game.world.agents.get(agentId);
      if (!agent) {
        throw new Error(`Couldn't find agent: ${agentId}`);
      }
      const player = game.world.players.get(agent.playerId);
      if (!player) {
        throw new Error(`Couldn't find player: ${agent.playerId}`);
      }
      const conversationId = parseGameId('conversations', args.conversationId);
      const conversation = game.world.conversations.get(conversationId);
      if (!conversation) {
        throw new Error(`Couldn't find conversation: ${conversationId}`);
      }
      if (
        !agent.inProgressOperation ||
        agent.inProgressOperation.operationId !== args.operationId
      ) {
        console.debug(`Agent ${agentId} wasn't sending a message ${args.operationId}`);
        return null;
      }
      delete agent.inProgressOperation;
      conversationInputs.finishSendingMessage.handler(game, now, {
        playerId: agent.playerId,
        conversationId: args.conversationId,
        timestamp: args.timestamp,
      });
      if (args.leaveConversation) {
        conversation.leave(game, now, player);
      }
      return null;
    },
  }),
  createAgent: inputHandler({
    args: {
      descriptionIndex: v.number(),
    },
    handler: (game, now, args) => {
      const description = Descriptions[args.descriptionIndex];
      const playerId = Player.join(
        game,
        now,
        description.name,
        description.character,
        description.identity,
      );
      const agentId = game.allocId('agents');
      game.world.agents.set(
        agentId,
        new Agent({
          id: agentId,
          playerId: playerId,
          inProgressOperation: undefined,
          lastConversation: undefined,
          lastInviteAttempt: undefined,
          toRemember: undefined,
        }),
      );
      game.agentDescriptions.set(
        agentId,
        new AgentDescription({
          agentId: agentId,
          identity: description.identity,
          plan: description.plan,
        }),
      );
      return { agentId };
    },
  }),
  // A new resident, described by the caller rather than picked from data/characters.ts. It
  // gets exactly the loop the seeded townsfolk get -- wander, invite, talk, remember,
  // reflect -- with its own brain deciding how. See agent/brain.ts.
  createAgentFromSpec: inputHandler({
    args: {
      name: v.string(),
      character: v.string(),
      identity: v.string(),
      plan: v.string(),
      brainId: v.optional(v.id('agentBrains')),
    },
    handler: (game, now, args) => {
      for (const p of game.playerDescriptions.values()) {
        if (p.name === args.name && game.world.players.has(p.playerId)) {
          throw new Error(`${args.name} already lives here`);
        }
      }
      const playerId = Player.join(game, now, args.name, args.character, args.identity);
      const agentId = game.allocId('agents');
      game.world.agents.set(
        agentId,
        new Agent({
          id: agentId,
          playerId,
          inProgressOperation: undefined,
          lastConversation: undefined,
          lastInviteAttempt: undefined,
          toRemember: undefined,
        }),
      );
      game.agentDescriptions.set(
        agentId,
        new AgentDescription({
          agentId,
          identity: args.identity,
          plan: args.plan,
          brainId: args.brainId,
        }),
      );
      game.descriptionsModified = true;
      return { agentId, playerId };
    },
  }),
  updateAgentDescription: inputHandler({
    args: {
      agentId,
      identity: v.optional(v.string()),
      plan: v.optional(v.string()),
    },
    handler: (game, now, args) => {
      const id = parseGameId('agents', args.agentId);
      const description = game.agentDescriptions.get(id);
      if (!description) {
        throw new Error(`Couldn't find agent: ${id}`);
      }
      if (args.identity) description.identity = args.identity;
      if (args.plan) description.plan = args.plan;
      game.descriptionsModified = true;
      return null;
    },
  }),
  // Move a resident out. The agent goes with its player: an agent whose player has left
  // would fail every tick.
  retireAgent: inputHandler({
    args: { agentId },
    handler: (game, now, args) => {
      const id = parseGameId('agents', args.agentId);
      const agent = game.world.agents.get(id);
      if (!agent) {
        throw new Error(`Couldn't find agent: ${id}`);
      }
      const player = game.world.players.get(agent.playerId);
      game.world.agents.delete(id);
      player?.leave(game, now);
      return null;
    },
  }),
};
