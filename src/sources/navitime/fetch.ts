import { join } from "@std/path";
import type { Direction, Station } from "../../model.ts";
import type { SourceOptions } from "../types.ts";
import {
  type DirectionParam,
  type NavitimeConfig,
  type RawStops,
  type RawTimetable,
  type StopsResponse,
  stopsUrl,
  type TimetableOperation,
  type TimetableResponse,
  timetableUrl,
} from "./api.ts";

const DELAY_MS = 300;

export function navitimeConfig(opts: SourceOptions): NavitimeConfig {
  const c = opts.line.sources.navitime as NavitimeConfig | undefined;
  if (!c) throw new Error(`line ${opts.line.id} has no sources.navitime config`);
  return c;
}

/** 取得単位: NAVITIME の 1 線 = 駅の並び（下り順）+ direction パラメータ */
export interface NavitimeLine {
  lineId: string;
  directionParam: DirectionParam;
  stations: Station[];
}

/** config から取得単位の一覧を作る。routes があれば線区ごと、なければ stations 全体を 1 線として扱う */
export function navitimeLines(opts: SourceOptions): NavitimeLine[] {
  const c = navitimeConfig(opts);
  const byId = new Map(opts.line.stations.map((s) => [s.id, s]));
  if (!opts.line.routes) {
    if (!c.lineId || !c.directionParam) throw new Error(`sources.navitime needs lineId and directionParam`);
    return [{ lineId: c.lineId, directionParam: c.directionParam, stations: opts.line.stations }];
  }
  return opts.line.routes.filter((r) => r.refs?.navitime).map((r) => {
    const lineId = r.refs!.navitime!;
    const directionParam = c.lines?.[lineId];
    if (!directionParam) throw new Error(`sources.navitime.lines["${lineId}"] is missing (route ${r.id})`);
    return {
      lineId,
      directionParam,
      stations: r.stations.map((s) => {
        const st = byId.get(s.stationId);
        if (!st) throw new Error(`route ${r.id}: unknown station ${s.stationId}`);
        return st;
      }),
    };
  });
}

export function rawDir(opts: SourceOptions, sampleDate: string): string {
  return join(opts.rawRoot, "navitime", opts.line.id, opts.service, sampleDate);
}

async function getJson<T>(url: string): Promise<T> {
  for (let attempt = 1;; attempt++) {
    try {
      const res = await fetch(url, { headers: { "Accept": "application/json" } });
      if (!res.ok) throw new Error(`${res.status} ${url}`);
      const body = await res.json() as T;
      await new Promise((r) => setTimeout(r, DELAY_MS));
      return body;
    } catch (e) {
      if (attempt >= 3) throw e;
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

/** 方向ごとの駅順（その方向に発車しうる駅 = 終点以外） */
function departingStations(stations: Station[], dir: Direction): Station[] {
  const ordered = dir === "down" ? stations : [...stations].reverse();
  return ordered.slice(0, -1).filter((s) => s.refs?.navitime);
}

/**
 * 各線・各駅・各方向の駅時刻表を取得し、まだどこかの停車駅一覧で見ていない列車だけ停車駅一覧を取得する。
 * 停車駅一覧は直通先の線の駅も含むので、見た列車の記録は線をまたいで共有する。
 * 取得済みのファイルがあれば再取得しない（途中で止まっても再実行で続きから取れる）。
 */
export async function fetchNavitime(opts: SourceOptions): Promise<string> {
  const c = navitimeConfig(opts);
  const lines = navitimeLines(opts);
  const log = opts.log ?? console.log;
  let dir: string | undefined;
  let sampleDate: string | undefined;
  let total = 0;

  for (const direction of ["down", "up"] as const) {
    const seen = new Set<string>(); // `${train_no}@${stationRef}`

    for (const line of lines) {
      const dirParam = line.directionParam[direction];
      for (const st of departingStations(line.stations, direction)) {
        const ref = st.refs!.navitime!;
        const url = timetableUrl(c.company, line.lineId, ref, dirParam, opts.date);
        const body = await getJson<TimetableResponse>(url);
        const tt = body.timetables.find((t) => t.target === opts.service);
        if (!tt) throw new Error(`service ${opts.service} not found: ${url}`);
        if (opts.date && tt.date !== opts.date) {
          throw new Error(`${opts.date} is not a ${opts.service} day (API returned ${tt.date})`);
        }
        if (sampleDate && sampleDate !== tt.date) {
          throw new Error(`sample date mismatch: ${sampleDate} vs ${tt.date} (${url})`);
        }
        sampleDate = tt.date;
        dir = rawDir(opts, sampleDate);
        await Deno.mkdir(dir, { recursive: true });

        const raw: RawTimetable = {
          meta: { kind: "timetable", stationRef: ref, lineId: line.lineId, direction, url, fetchedAt: new Date().toISOString() },
          body,
        };
        await Deno.writeTextFile(
          join(dir, `timetable_${ref}_L${line.lineId}_${direction}.json`),
          JSON.stringify(raw, null, 1),
        );

        const ops: TimetableOperation[] = tt.operations.flatMap((o) => o.minutes);
        let fetched = 0;
        for (const op of ops) {
          if (seen.has(`${op.train_no}@${ref}`)) continue;
          const path = join(dir, `stops_${ref}_L${line.lineId}_${op.id}.json`);
          let stops: StopsResponse;
          if (await exists(path)) {
            stops = (JSON.parse(await Deno.readTextFile(path)) as RawStops).body;
          } else {
            const surl = stopsUrl(c.company, line.lineId, ref, dirParam, op);
            stops = await getJson<StopsResponse>(surl);
            const rawStops: RawStops = {
              meta: {
                kind: "stops",
                stationRef: ref,
                lineId: line.lineId,
                direction,
                operation: op,
                url: surl,
                fetchedAt: new Date().toISOString(),
              },
              body: stops,
            };
            await Deno.writeTextFile(path, JSON.stringify(rawStops, null, 1));
            fetched++;
          }
          // 列車番号は途中で変わることがある（例: 京王ライナー 7731 → 7731K）ので各駅の番号でも記録する
          for (const s of stops.stops) {
            if (!s.id) continue;
            seen.add(`${op.train_no}@${s.id}`);
            if (s.train_no) seen.add(`${s.train_no}@${s.id}`);
          }
        }
        total += fetched;
        log(`L${line.lineId} ${st.name} ${direction}: ${ops.length} trains, stops fetched ${fetched} (total ${total})`);
      }
    }
  }
  if (!dir) throw new Error("no stations to fetch");
  return dir;
}
