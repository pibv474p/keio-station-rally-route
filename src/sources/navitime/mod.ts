import { join } from "@std/path";
import type { SourceAdapter, SourceOptions } from "../types.ts";
import type { RawStops, RawTimetable } from "./api.ts";
import { convertNavitime } from "./convert.ts";
import { fetchNavitime } from "./fetch.ts";

/** raw/navitime/<line>/<service>/ の中で一番新しい日付のディレクトリ */
async function latestDir(opts: SourceOptions): Promise<string> {
  const base = join(opts.rawRoot, "navitime", opts.line.id, opts.service);
  if (opts.date) return join(base, opts.date);
  const dates: string[] = [];
  for await (const e of Deno.readDir(base)) if (e.isDirectory) dates.push(e.name);
  if (!dates.length) throw new Error(`no raw data in ${base}. run fetch first`);
  return join(base, dates.sort().at(-1)!);
}

export async function readRawDir(dir: string): Promise<{ timetables: RawTimetable[]; stops: RawStops[] }> {
  const timetables: RawTimetable[] = [];
  const stops: RawStops[] = [];
  const names: string[] = [];
  for await (const e of Deno.readDir(dir)) if (e.isFile && e.name.endsWith(".json")) names.push(e.name);
  for (const name of names.sort()) {
    const raw = JSON.parse(await Deno.readTextFile(join(dir, name)));
    if (raw.meta?.kind === "timetable") timetables.push(raw);
    else if (raw.meta?.kind === "stops") stops.push(raw);
  }
  return { timetables, stops };
}

export const navitimeSource: SourceAdapter = {
  name: "navitime",
  async fetch(opts) {
    const dir = await fetchNavitime(opts);
    (opts.log ?? console.log)(`saved: ${dir}`);
  },
  async load(opts) {
    const { timetables, stops } = await readRawDir(await latestDir(opts));
    return convertNavitime(opts.line, opts.service, timetables, stops);
  },
};
