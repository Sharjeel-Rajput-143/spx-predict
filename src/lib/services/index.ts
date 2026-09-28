import { mockGameService, type GameService } from "./gameService";
import { liveGameService } from "./liveGameService";

/** NEXT_PUBLIC_DATA_SOURCE=mock|live, same switch as the chart's MarketDataFeed. */
export function getGameService(): GameService {
  return process.env.NEXT_PUBLIC_DATA_SOURCE === "live" ? liveGameService : mockGameService;
}

export type { GameService } from "./gameService";
