import { navitimeSource } from "./navitime/mod.ts";
import type { SourceAdapter } from "./types.ts";

// ODPT / GTFS-JP はここに odptSource / gtfsJpSource を追加する
export const sources: Record<string, SourceAdapter> = {
  navitime: navitimeSource,
};
