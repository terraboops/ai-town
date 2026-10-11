import { useEffect, useMemo, useRef, useState } from 'react';
import { Stage } from '@pixi/react';
import { ConvexProvider, useConvex, useQuery } from 'convex/react';
import { Viewport } from 'pixi-viewport';
import { useElementSize } from 'usehooks-ts';
import PixiGame from './PixiGame.tsx';
import { api } from '../../convex/_generated/api';
import { useWorldHeartbeat } from '../hooks/useWorldHeartbeat.ts';
import { useHistoricalTime } from '../hooks/useHistoricalTime.ts';
import { useServerGame, ServerGame } from '../hooks/serverGame.ts';
import { GameId } from '../../convex/aiTown/ids.ts';

// The TV showcase (?tv=1&demo=1): the town as a diorama with a quiet director.
//
// When two people are talking, the camera drifts to them and their words run along the
// bottom of the screen. When nobody is, it shows the day's highlights -- silliest line, most
// thoughtful, weirdest, most dramatic, strangest interaction -- one card at a time, and drifts
// to whoever said it. Highlights are ranked on the server (convex/showcase.ts) as messages
// arrive; this view only reads the result, so the canvas never waits on a model.
//
// The look follows terratauri.com: warm paper and ink, one terracotta accent, hard edges, no
// glow. Sized to be read from a couch at 1080p.

const C = {
  ink: '#1A1410',
  panel: 'rgba(26, 20, 16, 0.92)',
  paper: '#F5EFE3',
  muted: '#E4D8C8',
  dim: 'rgba(228, 216, 200, 0.55)',
  accent: '#E57052',
  butter: '#F8D97E',
};
const SANS = '"Google Sans Flex", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const SERIF = '"Newsreader", ui-serif, "Iowan Old Style", Charter, Georgia, serif';

// Camera: a slow ease towards the target. TAU is how long it takes to cover ~63% of the way.
const TAU_MS = 2600;
const TALK_SCALE = 2.7;
const IDLE_SCALE = 2.05;
// Do not hop between conversations faster than this, or the camera never settles.
const MIN_DWELL_MS = 25_000;
const CARD_MS = 15_000;
// The town is rarely silent, so the reel is not only for silence: after this long on a live
// conversation, cut away for a short interlude of the day's highlights, then come back.
const LIVE_SEGMENT_MS = 50_000;
const INTERLUDE_MS = 2 * CARD_MS;
const LOWER_THIRD_PX = 300;

type Target = { x: number; y: number; scale: number };

function useFonts() {
  useEffect(() => {
    const hrefs = [
      'https://fonts.googleapis.com/css2?family=Google+Sans+Flex:wght@400;500;600&display=swap',
      'https://fonts.googleapis.com/css2?family=Newsreader:ital,opsz,wght@0,6..72,400;0,6..72,500;1,6..72,400&display=swap',
    ];
    const links = hrefs.map((href) => {
      const l = document.createElement('link');
      l.rel = 'stylesheet';
      l.href = href;
      document.head.appendChild(l);
      return l;
    });
    return () => links.forEach((l) => l.remove());
  }, []);
}

// The conversation worth watching: both people have arrived, and among those, the one the
// camera is already on wins until it ends or has been held long enough and another is livelier.
function pickConversation(game: ServerGame, current: string | undefined, since: number) {
  const live = [...game.world.conversations.values()].filter(
    (c) =>
      c.participants.size >= 2 &&
      [...c.participants.values()].every((m) => m.status.kind === 'participating'),
  );
  if (!live.length) return undefined;
  const stay = live.find((c) => c.id === current);
  if (stay && Date.now() - since < MIN_DWELL_MS) return stay;
  const liveliest = live.sort(
    (a, b) => (b.lastMessage?.timestamp ?? b.created) - (a.lastMessage?.timestamp ?? a.created),
  )[0];
  return stay && (stay.lastMessage?.timestamp ?? 0) >= (liveliest.lastMessage?.timestamp ?? 0)
    ? stay
    : liveliest;
}

function timeOf(ms: number) {
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export default function ShowcaseTV() {
  useFonts();
  const convex = useConvex();
  const [gameWrapperRef, { width, height }] = useElementSize();
  const viewportRef = useRef<Viewport | undefined>();
  const [, setSelectedElement] = useState<{ kind: 'player'; id: GameId<'players'> }>();

  const worldStatus = useQuery(api.world.defaultWorldStatus);
  const worldId = worldStatus?.worldId;
  const engineId = worldStatus?.engineId;
  const game = useServerGame(worldId);
  useWorldHeartbeat();
  const worldState = useQuery(api.world.worldState, worldId ? { worldId } : 'skip');
  const { historicalTime } = useHistoricalTime(worldState?.engine);
  const reel = useQuery(api.showcase.reel, worldId ? { worldId } : 'skip');

  // ---- director: which conversation, if any
  const focus = useRef<{ id?: string; since: number }>({ since: 0 });
  const live = game ? pickConversation(game, focus.current.id, focus.current.since) : undefined;
  if (live?.id !== focus.current.id) {
    focus.current = { id: live?.id, since: Date.now() };
  }
  // A clock, so the programme advances even when nothing in the world changes.
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const messages = useQuery(
    api.messages.listMessages,
    worldId && live ? { worldId, conversationId: live.id } : 'skip',
  );
  const names = (id: string) => game?.playerDescriptions.get(id as GameId<'players'>)?.name ?? '';

  // ---- idle: rotate through highlight cards
  const cards = useMemo(() => {
    if (!reel) return [];
    const out: Array<
      | { kind: 'line'; title: string; line: { authorName: string; text: string; at: number } }
      | { kind: 'talk'; title: string; people: string[]; lines: { authorName: string; text: string }[]; total: number }
    > = [];
    for (const c of reel.categories) {
      if (c.lines[0]) out.push({ kind: 'line', title: c.title, line: c.lines[0] });
    }
    for (const i of reel.interactions as any[]) {
      out.push({ kind: 'talk', title: i.title, people: i.people, lines: i.lines, total: i.total });
    }
    // Second-best lines too, so a long quiet spell does not loop on four cards.
    for (const c of reel.categories) {
      if (c.lines[1]) out.push({ kind: 'line', title: c.title, line: c.lines[1] });
    }
    return out;
  }, [reel]);
  // ---- the programme: live segments, highlight interludes, and the reel alone when quiet
  const programme = useRef({ mode: 'reel' as 'live' | 'reel', since: Date.now(), base: 0 });
  const p = programme.current;
  const cardAt = () => p.base + Math.floor((now - p.since) / CARD_MS);
  if (p.mode === 'live' && (!live || (now - p.since > LIVE_SEGMENT_MS && cards.length))) {
    programme.current = { mode: 'reel', since: now, base: p.base };
  } else if (p.mode === 'reel' && live && (now - p.since > INTERLUDE_MS || !cards.length)) {
    programme.current = { mode: 'live', since: now, base: cardAt() + 1 };
  }
  const conversation = programme.current.mode === 'live' ? live : undefined;
  const cardIndex = programme.current.base + Math.floor((now - programme.current.since) / CARD_MS);
  const card = cards.length ? cards[cardIndex % cards.length] : undefined;

  // ---- camera target
  const target = useRef<Target | null>(null);
  const wander = useRef({ x: 0, y: 0, at: 0 });
  if (game) {
    const tile = game.worldMap.tileDim;
    const posOf = (name: string) =>
      [...game.world.players.values()].find((p) => names(p.id) === name)?.position;
    if (conversation) {
      const ps = [...conversation.participants.keys()]
        .map((id) => game.world.players.get(id)?.position)
        .filter(Boolean) as { x: number; y: number }[];
      if (ps.length) {
        const x = ps.reduce((s, p) => s + p.x, 0) / ps.length;
        const y = ps.reduce((s, p) => s + p.y, 0) / ps.length;
        target.current = { x: (x + 0.5) * tile, y: (y + 0.5) * tile, scale: TALK_SCALE };
      }
    } else {
      const who = card?.kind === 'line' ? card.line.authorName : card?.kind === 'talk' ? card.people[0] : undefined;
      const p = who ? posOf(who) : undefined;
      if (p) {
        target.current = { x: (p.x + 0.5) * tile, y: (p.y + 0.5) * tile, scale: IDLE_SCALE };
      } else {
        // Nobody to follow: drift between random spots, a new one every 20 s.
        if (Date.now() - wander.current.at > 20_000) {
          wander.current = {
            x: (0.2 + 0.6 * Math.random()) * game.worldMap.width * tile,
            y: (0.2 + 0.6 * Math.random()) * game.worldMap.height * tile,
            at: Date.now(),
          };
        }
        target.current = { x: wander.current.x, y: wander.current.y, scale: IDLE_SCALE };
      }
    }
  }

  // One animation loop for the life of the view; it eases towards whatever target is current.
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const step = (now: number) => {
      const vp = viewportRef.current;
      const t = target.current;
      const dt = Math.min(100, now - last);
      last = now;
      if (vp && t) {
        const k = 1 - Math.exp(-dt / TAU_MS);
        const c = vp.center;
        const scale = vp.scale.x + (t.scale - vp.scale.x) * k;
        vp.setZoom(scale, true);
        // Frame the subject in the part of the screen above the lower third.
        const ty = t.y + LOWER_THIRD_PX / 2 / scale;
        vp.moveCenter(c.x + (t.x - c.x) * k, c.y + (ty - c.y) * k);
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, []);

  if (!worldId || !engineId || !game) {
    return <div className="fixed inset-0" style={{ background: C.ink }} />;
  }

  const typing = conversation?.isTyping ? names(conversation.isTyping.playerId) : undefined;
  const recent = (messages ?? []).slice(-2);
  const people = conversation ? [...conversation.participants.keys()].map(names) : [];

  return (
    <div className="fixed inset-0 overflow-hidden" style={{ background: C.ink, fontFamily: SANS }}>
      <div ref={gameWrapperRef} className="absolute inset-0">
        <Stage width={width} height={height} options={{ backgroundColor: 0x1a1410 }}>
          <ConvexProvider client={convex}>
            <PixiGame
              game={game}
              worldId={worldId}
              engineId={engineId}
              width={width}
              height={height}
              historicalTime={historicalTime}
              setSelectedElement={setSelectedElement}
              viewportRef={viewportRef}
            />
          </ConvexProvider>
        </Stage>
      </div>

      {/* Mark: what this screen is showing. */}
      <div
        className="absolute"
        style={{
          top: 36,
          left: 48,
          padding: '10px 16px',
          background: C.panel,
          color: C.paper,
          fontSize: 18,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          boxShadow: `3px 3px 0 ${C.accent}`,
        }}
      >
        AI Town <span style={{ color: C.accent, margin: '0 0.5em' }}>·</span>
        {conversation ? 'Live' : 'Today'}
      </div>

      {/* Lower third. */}
      <div
        className="absolute left-0 right-0 bottom-0"
        style={{
          background: C.panel,
          borderTop: `3px solid ${C.accent}`,
          color: C.paper,
          padding: '34px 72px 40px',
          minHeight: 250,
        }}
      >
        {conversation ? (
          <div>
            <div style={{ fontSize: 20, letterSpacing: '0.14em', textTransform: 'uppercase', color: C.accent }}>
              {people.join('  &  ')}
            </div>
            {recent.length === 0 && (
              <div style={{ fontFamily: SERIF, fontSize: 40, color: C.dim, marginTop: 18 }}>
                {typing ? `${typing} is thinking…` : 'They have just met.'}
              </div>
            )}
            {recent.map((m, i) => (
              <div
                key={m._id}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '180px 1fr',
                  columnGap: 32,
                  marginTop: 18,
                  opacity: i === recent.length - 1 ? 1 : 0.55,
                }}
              >
                <div style={{ fontSize: 22, color: C.butter, paddingTop: 10, textAlign: 'right' }}>
                  {m.authorName}
                </div>
                <div style={{ fontFamily: SERIF, fontSize: i === recent.length - 1 ? 40 : 30, lineHeight: 1.25 }}>
                  {m.text.replace(/^"|"$/g, '')}
                </div>
              </div>
            ))}
            {typing && recent.length > 0 && (
              <div style={{ marginTop: 14, marginLeft: 212, fontSize: 18, color: C.dim }}>{typing} is thinking…</div>
            )}
          </div>
        ) : card ? (
          <div key={cardIndex}>
            <div style={{ fontSize: 20, letterSpacing: '0.14em', textTransform: 'uppercase', color: C.accent }}>
              {card.title}
            </div>
            {card.kind === 'line' ? (
              <>
                <div style={{ fontFamily: SERIF, fontSize: 46, lineHeight: 1.22, marginTop: 16, maxWidth: 1600 }}>
                  “{card.line.text.replace(/^"|"$/g, '')}”
                </div>
                <div style={{ fontSize: 22, color: C.muted, marginTop: 16 }}>
                  — {card.line.authorName}
                  <span style={{ color: C.dim }}>, {timeOf(card.line.at)}</span>
                </div>
              </>
            ) : (
              <>
                {card.lines.slice(0, 3).map((l, i) => (
                  <div
                    key={i}
                    style={{ display: 'grid', gridTemplateColumns: '180px 1fr', columnGap: 32, marginTop: 14 }}
                  >
                    <div style={{ fontSize: 22, color: C.butter, paddingTop: 6, textAlign: 'right' }}>{l.authorName}</div>
                    <div style={{ fontFamily: SERIF, fontSize: 30, lineHeight: 1.25 }}>{l.text.replace(/^"|"$/g, '')}</div>
                  </div>
                ))}
                <div style={{ fontSize: 18, color: C.dim, marginTop: 14, marginLeft: 212 }}>
                  {card.people.join(' and ')} · {card.total} lines
                </div>
              </>
            )}
          </div>
        ) : (
          <div style={{ fontFamily: SERIF, fontSize: 40, color: C.muted }}>
            The town is quiet. The day’s best lines will appear here as people talk.
          </div>
        )}
      </div>
    </div>
  );
}
