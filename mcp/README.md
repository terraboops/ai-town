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

## Notes

- A join or a move is an INPUT to the game engine, not an immediate effect. The engine has to be
  running for it to be applied, and it stops itself when nobody is viewing the world. Call
  `world:heartbeatWorld` (or open the town in a browser) to wake it.
- `move_to` walks to the nearest reachable tile. Buildings and water block movement, so the
  character may stop short of the exact coordinate.
