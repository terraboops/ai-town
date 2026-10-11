import { ObjectType, v } from 'convex/values';
import { GameId, agentId, parseGameId } from './ids';
import { Id } from '../_generated/dataModel';

export class AgentDescription {
  agentId: GameId<'agents'>;
  identity: string;
  plan: string;
  // Set for a resident registered at runtime: the brain that runs it. See agent/brain.ts.
  brainId?: Id<'agentBrains'>;

  constructor(serialized: SerializedAgentDescription) {
    const { agentId, identity, plan, brainId } = serialized;
    this.agentId = parseGameId('agents', agentId);
    this.identity = identity;
    this.plan = plan;
    this.brainId = brainId;
  }

  serialize(): SerializedAgentDescription {
    const { agentId, identity, plan, brainId } = this;
    return { agentId, identity, plan, brainId };
  }
}

export const serializedAgentDescription = {
  agentId,
  identity: v.string(),
  plan: v.string(),
  brainId: v.optional(v.id('agentBrains')),
};
export type SerializedAgentDescription = ObjectType<typeof serializedAgentDescription>;
