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

import http from 'node:http';
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
      const existing = await myPlayer(worldId, name);
      if (existing) {
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
        found = await myPlayer(worldId, name);
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
