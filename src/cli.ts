// deno task fetch --line keio_dobutsuen --service holiday [--source navitime] [--date YYYY-MM-DD]
// deno task build --line keio_dobutsuen --service holiday [--source navitime] [--format train-diagram-tsv] [--color]
// 路線網（routes あり）は --route <id> を付けた線区だけ TSV を出す（付けなければ data/*.json のみ）

import { parseArgs } from "@std/cli/parse-args";
import { fromFileUrl, join } from "@std/path";
import { exporters } from "./exporters/index.ts";
import type { LineConfig } from "./model.ts";
import { sources } from "./sources/index.ts";
import type { SourceOptions } from "./sources/types.ts";
import { projectRoute } from "./route.ts";
import { validateTimetable } from "./validate.ts";

const ROOT = fromFileUrl(new URL("..", import.meta.url));

const args = parseArgs(Deno.args, {
  string: ["line", "service", "source", "format", "date", "route"],
  boolean: ["color"],
  default: { source: "navitime", format: "train-diagram-tsv" },
});
const [cmd] = args._;
if (!args.line || !args.service || (cmd !== "fetch" && cmd !== "build")) {
  console.error("usage: cli.ts <fetch|build> --line <id> --service <weekday|holiday> [--source navitime] [--date YYYY-MM-DD]");
  Deno.exit(2);
}

const line = JSON.parse(await Deno.readTextFile(join(ROOT, "config", "lines", `${args.line}.json`))) as LineConfig;
const source = sources[args.source];
if (!source) throw new Error(`unknown source: ${args.source}`);
const opts: SourceOptions = { line, service: args.service, rawRoot: join(ROOT, "raw"), date: args.date };

if (cmd === "fetch") {
  if (!source.fetch) throw new Error(`source ${source.name} has no fetch`);
  await source.fetch(opts);
} else {
  const tt = await source.load(opts);
  const errors = validateTimetable(tt);
  if (errors.length) {
    console.error(errors.slice(0, 20).join("\n"));
    Deno.exit(1);
  }
  const base = `${line.id}_${args.service}`;
  const dataPath = join(ROOT, "data", `${base}.json`);
  await Deno.mkdir(join(ROOT, "data"), { recursive: true });
  await Deno.writeTextFile(dataPath, JSON.stringify(tt, null, 1) + "\n");

  const count = (d: string) => tt.trains.filter((t) => t.direction === d).length;
  console.log(`trains: down ${count("down")}, up ${count("up")}`);
  console.log(`wrote ${dataPath}`);

  if (tt.routes && !args.route) {
    console.log(`network data: add --route <${tt.routes.map((r) => r.id).join("|")}> to export a diagram`);
  } else {
    const target = args.route ? projectRoute(tt, args.route) : tt;
    const exporter = exporters[args.format];
    if (!exporter) throw new Error(`unknown format: ${args.format}`);
    const outPath = join(ROOT, "out", `${args.route ? `${base}_${args.route}` : base}.${exporter.ext}`);
    await Deno.mkdir(join(ROOT, "out"), { recursive: true });
    await Deno.writeTextFile(outPath, exporter.export(target, { colorByTrain: args.color }));
    console.log(`wrote ${outPath}`);
  }
}
