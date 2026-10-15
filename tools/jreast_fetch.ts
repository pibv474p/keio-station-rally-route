// JR東日本 公式時刻表サイトから、指定駅の駅時刻表と、そこに載る列車の停車駅一覧を取得する。
//   deno run --allow-net --allow-read --allow-write tools/jreast_fetch.ts config/jreast/suica_penguin.json [--service holiday,weekday]
// 生 HTML は raw/jreast/ に保存し（取得済みは再取得しない）、まとめた JSON を data/jreast/<id>_<service>.json に出す。
// 時刻データは交通新聞社「JR時刻表」に基づくもので転載・加工の再配布は禁止。個人の範囲で使い、リポジトリに入れないこと。
import { parseArgs } from "@std/cli/parse-args";
import { dirname, join } from "@std/path";
import {
  detectVersion,
  parseStationList,
  parseStationTimetable,
  parseTrainPage,
  type StationTimetablePage,
  type TrainColumn,
} from "../src/sources/jreast/parse.ts";

const BASE = "https://timetables.jreast.co.jp/";
const DELAY_MS = 300;
const RAW = "raw/jreast";

const args = parseArgs(Deno.args, { string: ["service"], default: { service: "holiday,weekday" } });
const cfgPath = String(args._[0] ?? "config/jreast/suica_penguin.json");
const cfg = JSON.parse(await Deno.readTextFile(cfgPath)) as {
  id: string;
  stations: { code: string; name: string; lines: string }[];
};

let lastReq = 0, fetched = 0;
async function get(path: string, refresh = false): Promise<string> {
  const file = join(RAW, path);
  if (!refresh) {
    try {
      return await Deno.readTextFile(file);
    } catch { /* 未取得 */ }
  }
  for (let attempt = 1;; attempt++) {
    const wait = lastReq + DELAY_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastReq = Date.now();
    try {
      const res = await fetch(BASE + path);
      if (!res.ok) throw new Error(`HTTP ${res.status} ${path}`);
      const text = await res.text();
      await Deno.mkdir(dirname(file), { recursive: true });
      await Deno.writeTextFile(file, text);
      fetched++;
      return text;
    } catch (e) {
      if (attempt >= 3) throw e;
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
}

const services = String(args.service).split(",") as ("holiday" | "weekday")[];
for (const service of services) {
  const pages: (StationTimetablePage & { station: string; line: string; direction: string; path: string })[] = [];
  let version = "";
  for (const s of cfg.stations) {
    const list = await get(`timetable/list${s.code}.html`, true); // 版が変わるので駅ページは毎回取り直す
    version ||= detectVersion(list) ?? "";
    const re = new RegExp(s.lines);
    for (const l of parseStationList(list)) {
      if (!re.test(l.line)) continue;
      const path = l[service];
      if (!path) continue;
      const st = parseStationTimetable(await get(path), path);
      pages.push({ ...st, station: s.code, line: l.line, direction: l.direction, path });
      console.error(`${s.name} ${l.line} ${l.direction}: ${st.departures.length} 本`);
    }
  }

  const trainPaths = [...new Set(pages.flatMap((p) => p.departures.map((d) => d.train)))];
  console.error(`${service}: 列車ページ ${trainPaths.length} 件`);
  const trains: (TrainColumn & { id: string; page: string; next?: string; prev?: string })[] = [];
  let i = 0;
  for (const tp of trainPaths) {
    const cols = parseTrainPage(await get(tp));
    cols.forEach((c, k) => {
      const id = `${tp.replace(/^\d+\/train\//, "").replace(/\.html$/, "")}#${k}`;
      trains.push({
        id,
        page: tp,
        ...c,
        prev: k > 0 ? id.replace(/#\d+$/, `#${k - 1}`) : undefined,
        next: k < cols.length - 1 ? id.replace(/#\d+$/, `#${k + 1}`) : undefined,
      });
    });
    if (++i % 50 === 0) console.error(`  ${i}/${trainPaths.length}（新規取得 ${fetched}）`);
  }

  const stations: Record<string, string> = {};
  for (const t of trains) for (const s of t.stops) if (s.station) stations[s.station] = s.name;
  const out = {
    source: { type: "jreast", url: BASE, version, service, fetchedAt: new Date().toISOString() },
    stations,
    stationTimetables: pages,
    trains,
  };
  const outFile = `data/jreast/${cfg.id}_${service}.json`;
  await Deno.mkdir(dirname(outFile), { recursive: true });
  await Deno.writeTextFile(outFile, JSON.stringify(out));
  console.error(`→ ${outFile}（版 ${version}、駅時刻表 ${pages.length}、列車 ${trains.length}、駅 ${Object.keys(stations).length}）`);
}
