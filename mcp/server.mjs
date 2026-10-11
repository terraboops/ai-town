#!/usr/bin/env node
// An MCP server that lets an agent drive its own character in AI Town.
//
// Why it exists: AI Town ships a browser client and a Convex backend, and its public
// mutations are enough to join a world, walk a character and read everything. Nothing in the
// app exposes that to an agent, so this wraps it in MCP tools.
//
// Identity comes from tsjwt, the same way the Hermes dashboard gets it. A `serve-identity`
// shim sits in front of this server, resolves the tailnet caller and injects a short-lived
// ES256 assertion as `Authorization: Bearer ...`. This server VERIFIES that assertion against
// the shim's published key set rather than trusting a header, then uses the caller's login as
// the character's identity. That is what makes one character per person, and what stops a
// caller claiming to be somebody else.
//
// The shim is the network gate; this is the identity check. Both, deliberately.
//
// Config (env):
//   CONVEX_URL        Convex deployment, default http://127.0.0.1:3210
//   PORT              listen port, default 8765
//   JWKS_URL          key set for verification, default http://127.0.0.1:9126/.well-known/jwks.json
//   EXPECTED_ISSUER   default https://hermes-tsjwt
//   EXPECTED_AUDIENCE default ai-town-mcp
//   ALLOW_ANONYMOUS   "1" admits a caller with no assertion, named by X-Agent-Name. For local
//                     testing only; it is the one setting that defeats the identity check.
//   WORLD_ID          pin a world; otherwise the default world is used.
//   REGISTRY_KEY_FILE file holding the deployment's TOWN_REGISTRY_KEY, default
//                     ~/.config/ai-town/registry-key. Without it, residents and events are off.

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import { ConvexClient } from 'convex/browser';
import { makeFunctionReference } from 'convex/server';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

const CONVEX_URL = (process.env.CONVEX_URL || 'http://127.0.0.1:3210').replace(/\/$/, '');
const PORT = Number(process.env.PORT || 8765);
const JWKS_URL = process.env.JWKS_URL || 'http://127.0.0.1:9126/.well-known/jwks.json';
const EXPECTED_ISSUER = process.env.EXPECTED_ISSUER || 'https://hermes-tsjwt';
const EXPECTED_AUDIENCE = process.env.EXPECTED_AUDIENCE || 'ai-town-mcp';
const ALLOW_ANONYMOUS = process.env.ALLOW_ANONYMOUS === '1';
const PINNED_WORLD = process.env.WORLD_ID || '';

const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------------------------------------------------------------- Convex over HTTP
// The public function path is `<module>:<function>`, and the deployment answers plain HTTP.
// No client library: one POST per call keeps this server free of the app's build toolchain.
async function convex(kind, path, args) {
  const res = await fetch(`${CONVEX_URL}/api/${kind}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, args: args || {}, format: 'json' }),
  });
  const body = await res.json().catch(() => null);
  if (!body || body.status !== 'success') {
    const msg = body?.errorMessage || `HTTP ${res.status}`;
    throw new Error(`${path} failed: ${String(msg).split('\n')[0]}`);
  }
  return body.value;
}
const query = (path, args) => convex('query', path, args);
const mutate = (path, args) => convex('mutation', path, args);

async function worldIds() {
  if (PINNED_WORLD) {
    const status = await query('world:defaultWorldStatus', {});
    return { worldId: PINNED_WORLD, engineId: status.engineId };
  }
  const status = await query('world:defaultWorldStatus', {});
  if (!status?.worldId || !status?.engineId) {
    throw new Error('no default world in this deployment');
  }
  return { worldId: status.worldId, engineId: status.engineId };
}

// An input is applied by the engine on its next tick. Wait for the result so a tool can say
// whether it worked, not just that it was queued.
async function sendInput(engineId, name, args, timeoutMs = 20000) {
  const inputId = await mutate('world:sendWorldInput', { engineId, name, args });
  for (const end = Date.now() + timeoutMs; Date.now() < end; ) {
    const r = await query('aiTown/main:inputStatus', { inputId });
    if (r) {
      if (r.kind === 'error') throw new Error(`${name}: ${r.message}`);
      return r.value;
    }
    await new Promise((res) => setTimeout(res, 400));
  }
  throw new Error(`${name}: not applied within ${timeoutMs / 1000}s (is the town running?)`);
}

// ---------------------------------------------------------------- the registry key
// Registering residents and subscribing to events are writes the deployment only takes with
// TOWN_REGISTRY_KEY. This server holds the key and callers never see it: the identity gate
// in front decides who may use it, and each brain is owned by the verified login that made it.
const REGISTRY_KEY_FILE =
  process.env.REGISTRY_KEY_FILE || `${os.homedir()}/.config/ai-town/registry-key`;
let registryKey = null;
function key() {
  if (registryKey === null) {
    try {
      registryKey = fs.readFileSync(REGISTRY_KEY_FILE, 'utf8').trim();
    } catch {
      registryKey = '';
    }
  }
  if (!registryKey) throw new Error('this server has no registry key; residents and events are off');
  return registryKey;
}

// ---------------------------------------------------------------- events
// One live Convex subscription per character, held for the life of the process. The
// deployment pushes a new result whenever an event for that character lands, so next_event
// waits on a push, not a loop of reads. Nothing happens to a character nobody invited or
// spoke to, so nothing is pushed.
let pushClient = null;
const eventsForRef = makeFunctionReference('agent/events:eventsFor');
const watches = new Map(); // `${worldId}/${name}` -> { events, waiters:Set<fn> }
function watch(worldId, name) {
  const id = `${worldId}/${name}`;
  let w = watches.get(id);
  if (w) return w;
  pushClient ??= new ConvexClient(CONVEX_URL);
  w = { events: [], waiters: new Set(), ready: null };
  w.ready = new Promise((resolve) => {
    pushClient.onUpdate(eventsForRef, { worldId, name }, (events) => {
      w.events = events || [];
      resolve();
      for (const wake of w.waiters) wake();
    });
  });
  watches.set(id, w);
  return w;
}

async function nextEvents(worldId, name, waitMs) {
  const w = watch(worldId, name);
  await w.ready;
  if (!w.events.length && waitMs > 0) {
    await new Promise((resolve) => {
      const wake = () => {
        if (!w.events.length) return;
        clearTimeout(timer);
        w.waiters.delete(wake);
        resolve();
      };
      const timer = setTimeout(() => {
        w.waiters.delete(wake);
        resolve();
      }, waitMs);
      w.waiters.add(wake);
    });
  }
  const events = w.events;
  if (events.length) {
    await mutate('agent/events:ackEvents', { key: key(), eventIds: events.map((e) => e._id) });
  }
  return events.map((e) => ({
    kind: e.kind,
    from: e.from,
    conversationId: e.conversationId,
    ...(e.text !== undefined ? { text: e.text } : {}),
    ...(e.leaving ? { leaving: true } : {}),
    at: new Date(e.at).toISOString(),
  }));
}

// ---------------------------------------------------------------- identity
let jwks = null;
const jwksFor = () => (jwks ??= createRemoteJWKSet(new URL(JWKS_URL)));

// The character name for a caller. A verified login, so two people never share a character
// and nobody can take someone else's.
function nameFor(login) {
  return login.split('@')[0].replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 24) || 'agent';
}

async function identityOf(req) {
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) {
    if (ALLOW_ANONYMOUS) {
      const raw = String(req.headers['x-agent-name'] || 'anon');
      return { login: `${nameFor(raw)}@anonymous`, verified: false };
    }
    return null;
  }
  try {
    const { payload } = await jwtVerify(token, jwksFor(), {
      issuer: EXPECTED_ISSUER,
      audience: EXPECTED_AUDIENCE,
    });
    const login = String(payload.email || payload.sub || '').toLowerCase();
    if (!login) return null;
    return { login, verified: true };
  } catch (e) {
    log('assertion refused:', e.message);
    return null;
  }
}

// ---------------------------------------------------------------- game helpers
// A player's name lives in playerDescriptions, not in worldState, so resolving "which
// character is mine" is a lookup by name. The newest match wins, so a rejoin after a
// dropped connection picks up the character that was just created rather than a stale one.
async function myPlayer(worldId, name) {
  const d = await query('world:gameDescriptions', { worldId });
  const mine = (d.playerDescriptions || [])
    .filter((p) => p.name === name)
    .sort((a, b) => (b._creationTime || 0) - (a._creationTime || 0));
  return mine[0] || null;
}

function describePlayer(p, desc) {
  const act = p.activity?.description || 'idle';
  const pos = p.position || {};
  return {
    playerId: p.id,
    name: desc?.name ?? '?',
    character: desc?.character ?? '?',
    x: Math.round(pos.x * 10) / 10,
    y: Math.round(pos.y * 10) / 10,
    activity: act,
    moving: (p.speed || 0) > 0,
  };
}

// ---------------------------------------------------------------- the tools
function buildServer(identity) {
  const name = nameFor(identity.login);
  const server = new McpServer({ name: 'ai-town', version: '0.1.0' });

  server.registerTool(
    'town_status',
    {
      title: 'Town status',
      description:
        'The state of the town: whether the simulation is running, who is present, where ' +
        'everyone is and what they are doing. Call this first to find your own character.',
      inputSchema: {},
    },
    async () => {
      const { worldId, engineId } = await worldIds();
      const st = await query('world:worldState', { worldId });
      const d = await query('world:gameDescriptions', { worldId });
      const byPlayer = new Map((d.playerDescriptions || []).map((p) => [p.playerId, p]));
      const players = (st.world.players || []).map((p) =>
        describePlayer(p, byPlayer.get(p.id)),
      );
      const mine = players.find((p) => p.name === name) || null;
      const agents = (st.world.agents || []).map((a) => {
        const p = (st.world.players || []).find((x) => x.id === a.playerId);
        return {
          agentId: a.id,
          x: Math.round((p?.position?.x ?? 0) * 10) / 10,
          y: Math.round((p?.position?.y ?? 0) * 10) / 10,
          activity: p?.activity?.description ?? 'idle',
          thinking: Boolean(a.inProgressOperation),
        };
      });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                you: { login: identity.login, characterName: name, verified: identity.verified },
                yourPlayer: mine,
                simulationRunning: Boolean(st.engine?.running),
                worldId,
                engineId,
                players,
                agents,
                conversations: (st.world.conversations || []).length,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.registerTool(
    'join_town',
    {
      title: 'Join the town',
      description:
        'Put your character into the town. Safe to call again: it returns your existing ' +
        'character if you already have one.',
      inputSchema: {},
    },
    async () => {
      const { worldId } = await worldIds();
      // Ask the town to record invitations and messages aimed at this character, so
      // next_event has something to wait on. Idempotent.
      await mutate('agent/events:subscribe', { key: key(), worldId, name, owner: identity.login })
        .catch((e) => log('subscribe failed:', e.message));
      const existing = await myPlayer(worldId, name);
      const present = existing && (await query('world:worldState', { worldId })).world.players
        .some((p) => p.id === existing.playerId);
      if (present) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                { joined: false, alreadyPresent: true, playerId: existing.playerId, character: existing.character, name },
                null,
                2,
              ),
            },
          ],
        };
      }
      await mutate('world:joinWorld', {
        worldId,
        name,
        description: `${name} is an agent-driven player, authenticated as ${identity.login}`,
      });
      // The join is an input to the engine and is applied on a tick, so the player appears
      // a moment later rather than in the same breath.
      let found = null;
      for (let i = 0; i < 20 && !found; i++) {
        await new Promise((r) => setTimeout(r, 500));
        const candidate = await myPlayer(worldId, name);
        const live = (await query('world:worldState', { worldId })).world.players;
        if (candidate && live.some((p) => p.id === candidate.playerId)) found = candidate;
      }
      if (!found) {
        return {
          content: [{ type: 'text', text: 'joined, but no character appeared within 10s' }],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ joined: true, playerId: found.playerId, character: found.character, name }, null, 2),
          },
        ],
      };
    },
  );

  server.registerTool(
    'move_to',
    {
      title: 'Walk to a point',
      description:
        'Walk your character to a tile. The map is roughly 70 wide and 70 tall; buildings ' +
        'and water block movement, and the character stops when it arrives. Pass null to ' +
        'stop where you are.',
      inputSchema: {
        x: z.number().nullable().describe('target x, or null to stop'),
        y: z.number().nullable().describe('target y, or null to stop'),
      },
    },
    async ({ x, y }) => {
      const { worldId, engineId } = await worldIds();
      const me = await myPlayer(worldId, name);
      if (!me) {
        return {
          content: [{ type: 'text', text: 'not in the town yet: call join_town first' }],
          isError: true,
        };
      }
      const destination = x === null || y === null ? null : { x, y };
      await mutate('world:sendWorldInput', {
        engineId,
        name: 'moveTo',
        args: { playerId: me.playerId, destination },
      });
      return {
        content: [
          {
            type: 'text',
            text: destination
              ? `walking to (${destination.x}, ${destination.y})`
              : 'stopped',
          },
        ],
      };
    },
  );

  server.registerTool(
    'leave_town',
    {
      title: 'Leave the town',
      description: 'Take your character out of the town.',
      inputSchema: {},
    },
    async () => {
      const { worldId } = await worldIds();
      const me = await myPlayer(worldId, name);
      if (!me) {
        return { content: [{ type: 'text', text: 'you are not in the town' }] };
      }
      await mutate('world:sendWorldInput', {
        engineId: (await worldIds()).engineId,
        name: 'leave',
        args: { playerId: me.playerId },
      });
      return { content: [{ type: 'text', text: `left as ${me.playerId}` }] };
    },
  );

  server.registerTool(
    'read_conversations',
    {
      title: 'Read recent conversations',
      description:
        'The town\'s conversations with their messages, newest first. Agents talk to each ' +
        'other on their own; this is how you hear what they said.',
      inputSchema: {
        limit: z.number().int().min(1).max(20).default(5).describe('how many conversations'),
      },
    },
    async ({ limit }) => {
      const { worldId } = await worldIds();
      const st = await query('world:worldState', { worldId });
      const d = await query('world:gameDescriptions', { worldId });
      const byPlayer = new Map((d.playerDescriptions || []).map((p) => [p.playerId, p]));
      const convos = (st.world.conversations || []).slice(-limit).reverse();
      const out = [];
      for (const c of convos) {
        let messages = [];
        try {
          messages = await query('messages:listMessages', { worldId, conversationId: c.id });
        } catch {
          messages = [];
        }
        out.push({
          conversationId: c.id,
          participants: (c.participants || []).map(
            (p) => byPlayer.get(p.playerId)?.name ?? p.playerId,
          ),
          messageCount: c.numMessages ?? messages.length,
          messages: messages.map((m) => ({
            author: byPlayer.get(m.author)?.name ?? m.author,
            text: m.text,
          })),
        });
      }
      return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
    },
  );

  // ------------------------------------------------------------ speaking
  const ok = (value) => ({
    content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
  });
  const fail = (message) => ({ content: [{ type: 'text', text: message }], isError: true });

  // My player (if present), and the conversation I'm in (if any), with names resolved.
  async function here() {
    const { worldId, engineId } = await worldIds();
    const st = await query('world:worldState', { worldId });
    const desc = await myPlayer(worldId, name);
    const me = desc && st.world.players.find((p) => p.id === desc.playerId);
    const conversation = me && st.world.conversations.find((c) =>
      c.participants.some((p) => p.playerId === me.id),
    );
    return { worldId, engineId, st, me, conversation };
  }
  // Head for the midpoint, as the townsfolk do. Walking to where the other one stands means
  // both walk to where the other WAS, and they pass each other.
  const meetingPoint = (a, b) => ({ x: Math.floor((a.x + b.x) / 2), y: Math.floor((a.y + b.y) / 2) });
  async function namesOf(worldId) {
    const d = await query('world:gameDescriptions', { worldId });
    return new Map((d.playerDescriptions || []).map((p) => [p.playerId, p.name]));
  }

  server.registerTool(
    'talk_to',
    {
      title: 'Start a conversation',
      description:
        'Invite another character to talk. Townsfolk accept a person straight away and walk ' +
        'over; your character walks towards them too. Then wait for next_event or call say.',
      inputSchema: { with: z.string().describe("the other character's name") },
    },
    async ({ with: other }) => {
      const { worldId, engineId, st, me, conversation } = await here();
      if (!me) return fail('not in the town: call join_town first');
      if (conversation) return fail(`already in conversation ${conversation.id}; leave_conversation first`);
      const names = await namesOf(worldId);
      const them = st.world.players.find((p) => names.get(p.id) === other && p.id !== me.id);
      if (!them) return fail(`nobody called ${other} is in the town`);
      const conversationId = await sendInput(engineId, 'startConversation', {
        playerId: me.id,
        invitee: them.id,
      });
      await sendInput(engineId, 'moveTo', {
        playerId: me.id,
        destination: meetingPoint(me.position, them.position),
      }).catch(() => {});
      return ok({ conversationId, invited: other });
    },
  );

  server.registerTool(
    'respond_invite',
    {
      title: 'Answer an invitation',
      description: 'Accept or decline the invitation you have been sent (see next_event).',
      inputSchema: { accept: z.boolean() },
    },
    async ({ accept }) => {
      const { engineId, st, me, conversation } = await here();
      if (!me) return fail('not in the town: call join_town first');
      const member = conversation?.participants.find((p) => p.playerId === me.id);
      if (member?.status.kind !== 'invited') return fail('you have no invitation waiting');
      await sendInput(engineId, accept ? 'acceptInvite' : 'rejectInvite', {
        playerId: me.id,
        conversationId: conversation.id,
      });
      if (accept) {
        const other = conversation.participants.find((p) => p.playerId !== me.id);
        const pos = st.world.players.find((p) => p.id === other?.playerId)?.position;
        if (pos) {
          await sendInput(engineId, 'moveTo', {
            playerId: me.id,
            destination: meetingPoint(me.position, pos),
          }).catch(() => {});
        }
      }
      return ok(accept ? `accepted ${conversation.id}` : `declined ${conversation.id}`);
    },
  );

  server.registerTool(
    'say',
    {
      title: 'Say something',
      description:
        'Say a line in your current conversation. Both of you must have arrived (status ' +
        'participating); if the other side is mid-sentence, this waits for them to finish.',
      inputSchema: { text: z.string().min(1).max(600) },
    },
    async ({ text }) => {
      let { worldId, engineId, me, conversation } = await here();
      if (!me) return fail('not in the town: call join_town first');
      if (!conversation) return fail('you are not in a conversation: talk_to someone first');
      // Wait (briefly) until both have arrived and nobody else holds the typing lock.
      for (const end = Date.now() + 45000; ; ) {
        const notHere = conversation.participants.some((p) => p.status.kind !== 'participating');
        const busy = conversation.isTyping && conversation.isTyping.playerId !== me.id;
        if (!notHere && !busy) break;
        if (Date.now() > end) {
          return fail(notHere ? 'still walking over; try again shortly' : 'they are still talking; try again shortly');
        }
        await mutate('world:heartbeatWorld', { worldId });
        await new Promise((r) => setTimeout(r, 1500));
        ({ conversation } = await here());
        if (!conversation) return fail('the conversation ended');
      }
      const messageUuid = crypto.randomUUID();
      await sendInput(engineId, 'startTyping', {
        playerId: me.id,
        conversationId: conversation.id,
        messageUuid,
      });
      await mutate('messages:writeMessage', {
        worldId,
        conversationId: conversation.id,
        messageUuid,
        playerId: me.id,
        text,
      });
      return ok({ said: text, conversationId: conversation.id });
    },
  );

  server.registerTool(
    'leave_conversation',
    { title: 'Leave the conversation', description: 'Walk away from your current conversation.', inputSchema: {} },
    async () => {
      const { engineId, me, conversation } = await here();
      if (!conversation) return ok('you are not in a conversation');
      await sendInput(engineId, 'leaveConversation', { playerId: me.id, conversationId: conversation.id });
      return ok(`left ${conversation.id}`);
    },
  );

  server.registerTool(
    'my_conversation',
    {
      title: 'Your conversation',
      description: 'Who you are talking with, where each of you stands, and what has been said.',
      inputSchema: {},
    },
    async () => {
      const { worldId, me, conversation } = await here();
      if (!me) return fail('not in the town: call join_town first');
      if (!conversation) return ok({ conversation: null });
      const names = await namesOf(worldId);
      const messages = await query('messages:listMessages', { worldId, conversationId: conversation.id });
      return ok({
        conversationId: conversation.id,
        participants: conversation.participants.map((p) => ({
          name: names.get(p.playerId) ?? p.playerId,
          status: p.status.kind,
        })),
        typing: conversation.isTyping ? names.get(conversation.isTyping.playerId) : null,
        messages: messages.map((m) => ({ author: m.authorName ?? names.get(m.author), text: m.text })),
      });
    },
  );

  server.registerTool(
    'next_event',
    {
      title: 'Wait for something to happen to you',
      description:
        'Returns the invitations and messages aimed at your character since you last asked, ' +
        'waiting up to waitSeconds for the first one. The town pushes them; nothing aimed ' +
        'at you means nothing returns. Each event is returned once.',
      inputSchema: { waitSeconds: z.number().int().min(0).max(300).default(60) },
    },
    async ({ waitSeconds }) => {
      const { worldId } = await worldIds();
      const events = await nextEvents(worldId, name, waitSeconds * 1000);
      return ok({ events });
    },
  );

  // ------------------------------------------------------------ residents
  const modelRef = z.object({
    provider: z.enum(['ollama', 'openai', 'anthropic', 'together', 'openrouter']),
    model: z.string(),
  });

  async function myBrain(worldId, resident) {
    const brain = await query('agent/brain:getBrain', { worldId, name: resident });
    if (!brain) throw new Error(`no resident called ${resident}`);
    if (brain.owner !== identity.login) throw new Error(`${resident} belongs to someone else`);
    return brain;
  }

  server.registerTool(
    'register_resident',
    {
      title: 'Add a resident to the town',
      description:
        'Create a new townsperson that lives on its own: it walks, invites, talks, remembers ' +
        'and reflects like the original residents, using the models you bind. `decider` is a ' +
        'small cheap model asked yes/no questions; only a yes reaches `chat`. `program` ' +
        "(optional) is the resident's router — see the README — and can be changed later " +
        'with update_resident, no rebuild needed. Hosted providers work only if the town ' +
        'operator enabled them.',
      inputSchema: {
        name: z.string().min(1).max(32),
        character: z.string().describe('sprite: f1 … f8'),
        identity: z.string().describe('who they are, in the third person'),
        plan: z.string().describe('what they want'),
        chat: modelRef,
        decider: modelRef.optional(),
        program: z.record(z.any()).optional(),
      },
    },
    async (args) => {
      const { worldId } = await worldIds();
      const { brainId, inputId } = await mutate('agent/brain:registerResident', {
        key: key(),
        worldId,
        owner: identity.login,
        ...args,
      });
      let created = null;
      for (let i = 0; i < 40 && !created; i++) {
        await new Promise((r) => setTimeout(r, 500));
        const r = await query('aiTown/main:inputStatus', { inputId });
        if (r?.kind === 'error') return fail(r.message);
        if (r) created = r.value;
      }
      return ok({ brainId, ...(created || { pending: 'the town will add them on its next tick' }) });
    },
  );

  server.registerTool(
    'update_resident',
    {
      title: "Change a resident's models, program or personality",
      description:
        'Rebind models, replace the program (null restores the default), or rewrite identity ' +
        'and plan. Takes effect on their next decision. Only the resident’s owner may do this.',
      inputSchema: {
        name: z.string(),
        chat: modelRef.optional(),
        decider: modelRef.nullable().optional(),
        program: z.record(z.any()).nullable().optional(),
        identity: z.string().optional(),
        plan: z.string().optional(),
      },
    },
    async ({ name: resident, ...changes }) => {
      const { worldId } = await worldIds();
      const brain = await myBrain(worldId, resident);
      await mutate('agent/brain:updateBrain', { key: key(), brainId: brain._id, owner: identity.login, ...changes });
      return ok(`updated ${resident}`);
    },
  );

  server.registerTool(
    'resident_status',
    {
      title: 'How a resident is doing',
      description:
        'Their models, program, counters (idle ticks that called no model, gate calls and ' +
        'yeses, chat calls, fallbacks) and the latest model calls with which model answered.',
      inputSchema: { name: z.string(), log: z.number().int().min(0).max(50).default(10) },
    },
    async ({ name: resident, log: n }) => {
      const { worldId } = await worldIds();
      const brain = await query('agent/brain:getBrain', { worldId, name: resident });
      if (!brain) return fail(`no resident called ${resident}`);
      const entries = n ? await query('agent/brain:brainLog', { brainId: brain._id, limit: n }) : [];
      return ok({
        name: brain.name,
        owner: brain.owner,
        agentId: brain.agentId,
        chat: brain.chat,
        decider: brain.decider ?? null,
        program: brain.effectiveProgram,
        stats: brain.stats,
        recent: entries.map((e) => ({
          at: new Date(e.at).toISOString(),
          phase: e.phase,
          model: `${e.provider}/${e.model}`,
          paid: e.paid,
          ms: e.ms,
          answer: e.answer,
          outcome: e.outcome,
          ...(e.error ? { error: e.error } : {}),
        })),
      });
    },
  );

  server.registerTool(
    'retire_resident',
    {
      title: 'Retire a resident',
      description: 'Take a resident you own out of the town for good.',
      inputSchema: { name: z.string() },
    },
    async ({ name: resident }) => {
      const { worldId } = await worldIds();
      const brain = await myBrain(worldId, resident);
      await mutate('agent/brain:retireResident', { key: key(), brainId: brain._id, owner: identity.login });
      return ok(`${resident} has left the town`);
    },
  );

  return server;
}

// ---------------------------------------------------------------- transport
// Stateless streamable HTTP: one server instance per request, no session to keep. An agent
// fleet is many short-lived clients, and a session table would only be something else to
// expire.
const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (url.pathname !== '/mcp') {
    res.writeHead(404).end();
    return;
  }

  const identity = await identityOf(req);
  if (!identity) {
    // Refused before any tool is reachable, and the reason stays in the log.
    log('refusing an unauthenticated caller');
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'a valid tsjwt assertion is required' }));
    return;
  }

  let body = '';
  for await (const chunk of req) body += chunk;
  let parsed;
  try {
    parsed = body ? JSON.parse(body) : undefined;
  } catch {
    res.writeHead(400).end();
    return;
  }

  const server = buildServer(identity);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    transport.close();
    server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, parsed);
  } catch (e) {
    log('request failed:', e.message);
    if (!res.headersSent) res.writeHead(500).end();
  }
});

httpServer.listen(PORT, '127.0.0.1', () => {
  log(
    `ai-town MCP on 127.0.0.1:${PORT}/mcp | convex=${CONVEX_URL} ` +
      `issuer=${EXPECTED_ISSUER} audience=${EXPECTED_AUDIENCE} ` +
      `jwks=${JWKS_URL} anonymous=${ALLOW_ANONYMOUS}`,
  );
});
