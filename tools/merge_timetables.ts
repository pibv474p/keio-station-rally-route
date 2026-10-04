// 複数の正規化データ（data/*.json）を 1 つの路線網にまとめる。
// 駅は id で突き合わせ（同じ id は同じ駅。refs が食い違えばエラー）、線区は routes を足し合わせる。
// routes のないデータは、その stations の並びを 1 線区として加える。列車 id は元の line.id を前に付けて重複を防ぐ。
//
// deno run --allow-read --allow-write tools/merge_timetables.ts --id keio_all --name "京王電鉄 全線" \
//   --out data/keio_all_holiday.json data/keio_network_holiday.json data/keio_inokashira_holiday.json

import { parseArgs } from "@std/cli/parse-args";
import type { Route, Station, Timetable, Train } from "../src/model.ts";
import { validateTimetable } from "../src/validate.ts";

const args = parseArgs(Deno.args, { string: ["id", "name", "out"] });
const inputs = args._.map(String);
if (!args.id || !args.out || inputs.length < 2) {
  console.error("usage: merge_timetables.ts --id <id> [--name <name>] --out <path> <a.json> <b.json> ...");
  Deno.exit(2);
}

const tts = await Promise.all(inputs.map(async (p) => JSON.parse(await Deno.readTextFile(p)) as Timetable));
const service = tts[0].service;
for (const t of tts) {
  if (t.service.id !== service.id || t.service.sampleDate !== service.sampleDate) {
    throw new Error(`service mismatch: ${t.line.id} ${JSON.stringify(t.service)} vs ${JSON.stringify(service)}`);
  }
}

const stations = new Map<string, Station>();
const routes: Route[] = [];
const trains: Train[] = [];
for (const t of tts) {
  for (const s of t.stations) {
    const old = stations.get(s.id);
    if (!old) stations.set(s.id, s);
    else {
      for (const [k, v] of Object.entries(s.refs ?? {})) {
        if (old.refs?.[k] && old.refs[k] !== v) throw new Error(`station ${s.id}: refs.${k} ${old.refs[k]} vs ${v}`);
      }
      old.refs = { ...s.refs, ...old.refs };
    }
  }
  routes.push(...(t.routes ?? [{
    id: t.line.id.replace(/^keio_/, ""),
    name: t.line.name.replace(/^京王/, ""),
    stations: t.stations.map((s) => ({ stationId: s.id, km: s.km })),
  }]));
  const pre = (id: string) => `${t.line.id}:${id}`;
  for (const tr of t.trains) {
    trains.push({
      ...tr,
      id: pre(tr.id),
      ...(tr.next ? { next: pre(tr.next) } : {}),
      ...(tr.prev ? { prev: pre(tr.prev) } : {}),
    });
  }
}

const merged: Timetable = {
  schemaVersion: 1,
  line: { id: args.id, name: args.name ?? args.id, operator: tts[0].line.operator },
  service,
  stations: [...stations.values()],
  routes,
  trains,
  sources: tts.flatMap((t) => t.sources),
};
const errors = validateTimetable(merged);
if (errors.length) {
  console.error(errors.slice(0, 20).join("\n"));
  Deno.exit(1);
}
await Deno.writeTextFile(args.out, JSON.stringify(merged, null, 1) + "\n");
console.log(
  `wrote ${args.out}: ${merged.stations.length} stations, ${routes.length} routes (${routes.map((r) => r.name).join("・")}), ${trains.length} trains`,
);
