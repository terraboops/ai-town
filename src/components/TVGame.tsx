import { useState } from 'react';
import PixiGame from './PixiGame.tsx';

import { useElementSize } from 'usehooks-ts';
import { Stage } from '@pixi/react';
import { ConvexProvider, useConvex, useQuery } from 'convex/react';
import { api } from '../../convex/_generated/api';
import { useWorldHeartbeat } from '../hooks/useWorldHeartbeat.ts';
import { useHistoricalTime } from '../hooks/useHistoricalTime.ts';
import { GameId } from '../../convex/aiTown/ids.ts';
import { useServerGame } from '../hooks/serverGame.ts';

// A fullscreen, chrome-free view of the town: canvas edge to edge, no header, no side panel,
// no branding. For a TV. The panel and everything else live in Game.tsx; this is the canvas
// plus nothing. Same heartbeat as the main view, so the world stays awake while it is watched.
export default function TVGame() {
  const convex = useConvex();
  const [selectedElement, setSelectedElement] = useState<{
    kind: 'player';
    id: GameId<'players'>;
  }>();
  const [gameWrapperRef, { width, height }] = useElementSize();

  const worldStatus = useQuery(api.world.defaultWorldStatus);
  const worldId = worldStatus?.worldId;
  const engineId = worldStatus?.engineId;

  const game = useServerGame(worldId);
  useWorldHeartbeat();

  const worldState = useQuery(api.world.worldState, worldId ? { worldId } : 'skip');
  const { historicalTime, timeManager } = useHistoricalTime(worldState?.engine);

  if (!worldId || !engineId || !game) {
    return null;
  }
  return (
    <div ref={gameWrapperRef} className="fixed inset-0 overflow-hidden bg-brown-900">
      <Stage width={width} height={height} options={{ backgroundColor: 0x7ab5ff }}>
        <ConvexProvider client={convex}>
          <PixiGame
            game={game}
            worldId={worldId}
            engineId={engineId}
            width={width}
            height={height}
            historicalTime={historicalTime}
            setSelectedElement={setSelectedElement}
          />
        </ConvexProvider>
      </Stage>
    </div>
  );
}
