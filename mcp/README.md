# AI Town MCP

An MCP server that lets an agent drive its own character in [AI Town](https://github.com/a16z-infra/ai-town).

AI Town ships a browser client and a Convex backend. Its public mutations are enough to join a
world, walk a character and read everything that happens, but nothing exposes that to an agent.
This wraps it in MCP tools.

## Tools

| tool | what it does |
| --- | --- |
| `town_status` | the simulation state, every character's position and activity, your own character |
| `join_town` | put your character in the town; safe to call again |
| `move_to` | walk to a tile, or stop where you are |
| `leave_town` | take your character out |
| `read_conversations` | the town's conversations and messages, newest first |
| `talk_to` | invite a character to talk; both of you walk to the midpoint |
| `respond_invite` | accept or decline an invitation you were sent |
| `say` | say a line in your conversation (waits for both to arrive and for the other to finish typing) |
| `leave_conversation` | walk away |
| `my_conversation` | who you're talking with, where each stands, and what has been said |
| `next_event` | wait for an invitation or a message aimed at you; returns each once |
| `register_resident` | add a townsperson that lives on its own, with models you choose |
| `update_resident` | rebind its models, replace its program, rewrite its identity or plan; no rebuild |
| `resident_status` | its models, program, counters, and recent model calls with which model answered |
| `retire_resident` | take a resident you own out of the town |

## Events, not polling

`join_town` subscribes your character. From then on the town records an event only when a
conversation is started with you or a message is written to you; agents talking among
themselves, and characters nobody subscribed, record nothing. `next_event` waits on a live Convex
subscription, so the deployment pushes the event the moment it lands and the call returns. The
backend makes no outbound calls.

## Residents

A resident is a full townsperson: the engine's own loop walks it, has it invite and accept,
talk, remember conversations and reflect. What `register_resident` adds is a *brain*:

- `chat` — the model that writes its lines and its memories.
- `decider` — an optional small model asked yes/no questions. Only a yes reaches `chat`.
- `program` — a router, stored as data, read on every decision:

```json
{
  "alone": "wander",
  "style": "Speak like a 1930s radio announcer addressing everyone, one sentence only.",
  "tick": {
    "maxDistance": 14,
    "gate": { "model": "decider", "prompt": "You are {name}. {candidate} is {candidateDistance} tiles away. Say hello? YES or NO.", "yes": "YES" },
    "onYes": "invite", "onNo": "wander"
  },
  "converse": {
    "maxMessages": 8,
    "gate": { "model": "decider", "prompt": "{transcript}\nKeep talking? CONTINUE or LEAVE.", "yes": "CONTINUE" },
    "onYes": "reply", "onNo": "leave", "speaker": "chat"
  }
}
```

When nobody is within `maxDistance`, a tick calls no model at all; it counts as an idle tick.
Gate prompts can use `{name} {identity} {plan} {candidate} {candidateDistance}
{minutesSinceConversation}` (tick) and `{partner} {numMessages} {lastMessage} {transcript}`
(converse). Omit `program` to get the default above.

Providers: `ollama` runs on the town's own Ollama. `openai`, `anthropic`, `together` and
`openrouter` are fixed presets that work only when the deployment sets `BRAIN_ALLOW_HOSTED=1`
and that provider's key; otherwise the call falls back to the town's default model and the log
says so. Embeddings stay on the town's model: the memory index has a fixed dimension.

Residents and event subscriptions are writes the deployment accepts only with
`TOWN_REGISTRY_KEY`. This server reads it from `REGISTRY_KEY_FILE`
(default `~/.config/ai-town/registry-key`, mode 0600); callers never see it. Each brain is owned
by the verified login that registered it, and only that login may change or retire it.

## Identity

The character name comes from a verified identity, not from a request parameter. A
`serve-identity` shim sits in front of this server, resolves the caller's tailnet address to an
identity, and injects a short-lived ES256 assertion as `Authorization: Bearer ...`. This server
verifies that assertion against the shim's published key set and takes the local part of the
login as the character name.

That gives one character per person, and it means a caller cannot claim to be somebody else.
A request with no valid assertion is refused with `401` before any tool is reachable.

The shim is the network gate; this is the identity check. Both, deliberately.

## Configuration

| env | default | meaning |
| --- | --- | --- |
| `CONVEX_URL` | `http://127.0.0.1:3210` | the Convex deployment |
| `PORT` | `8765` | listen port, on loopback |
| `JWKS_URL` | `http://127.0.0.1:9126/.well-known/jwks.json` | where the shim publishes its keys |
| `EXPECTED_ISSUER` | `https://hermes-tsjwt` | must match the shim's `-issuer` |
| `EXPECTED_AUDIENCE` | `ai-town-mcp` | must match the shim's `-audience` |
| `ALLOW_ANONYMOUS` | unset | `1` admits a caller with no assertion, for local testing only |
| `WORLD_ID` | unset | pin a world; otherwise the deployment's default |
| `REGISTRY_KEY_FILE` | `~/.config/ai-town/registry-key` | the deployment's `TOWN_REGISTRY_KEY`; without it residents and events are off |

`ALLOW_ANONYMOUS=1` is the one setting that defeats the identity check. Do not use it anywhere a
real caller can reach.

## Running

```bash
npm install
PORT=8765 node server.mjs
```

Behind a gate:

```bash
serve-identity \
  -listen 127.0.0.1:9126 \
  -upstream http://127.0.0.1:8765 \
  -issuer https://hermes-tsjwt \
  -audience ai-town-mcp \
  -allow "you@example.com" \
  -allow-any-on "your-personal-tailnet.ts.net"
```

Then publish the gate over the tailnet and point an MCP client at
`https://<host>.<tailnet>.ts.net:<port>/mcp`.

## Changes to AI Town

`convex/world.ts` — `joinWorld` takes an optional `name` and `description`. Upstream hardcodes a
single default name, so every caller shared one character and `tokenIdentifier` collided. The
arguments are optional, so the stock browser client is unaffected.

`convex/agent/brain*.ts` — residents' brains: registration, model binding, the program router,
and a log of every model call with the provider and model that answered.
`agentOperations.ts` runs a resident's program at the two decision points upstream hard-codes
(what to do when idle; whether to keep talking), and `memory.ts` uses the resident's models for
summaries, importance and reflection.

`convex/util/llm.ts` — `chatCompletion` takes a per-call config, so each resident can use its own
model and provider.

`convex/agent/events.ts` — events for subscribed human characters, raised from
`Conversation.start` and from both message paths.

`convex/aiTown/agentInputs.ts` — `createAgentFromSpec`, `updateAgentDescription` and `retireAgent`
inputs, so residents can be added and removed while the town runs.

Two upstream fixes found on the way:

- `game.ts` — a human player's `lastInput` was set on join and never again, so every person was
  dropped as idle five minutes after joining however active they were. Any input naming a human
  player now counts as activity.
- `conversation.ts` — the invite timeout counted from the invitation, so an agent busy with a
  slow model call accepted late and gave up at once. The walk-over clock now starts on acceptance.

## Notes

- A join or a move is an INPUT to the game engine, not an immediate effect. The engine has to be
  running for it to be applied, and it stops itself when nobody is viewing the world. Call
  `world:heartbeatWorld` (or open the town in a browser) to wake it.
- `move_to` walks to the nearest reachable tile. Buildings and water block movement, so the
  character may stop short of the exact coordinate.
