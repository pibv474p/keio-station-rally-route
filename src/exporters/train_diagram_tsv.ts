// https://www.train-diagram.com/ の「時刻データ」形式（タブ区切り）。
// 列: No / 上下 / 駅種 / 駅色 / 距離 / 項目・駅 / 着発 / 列車...（1 列 = 1 列車）
// 上下: 1=下り 2=上り。距離は「1 つ上の駅との距離(km)」。時刻は HHMM。

import type { Direction, Station, StopTime, Timetable, Train } from "../model.ts";
import { toHHMM } from "../time.ts";
import type { Exporter, ExportOptions } from "./types.ts";

const PASS = "レ";
const DIR_CODE: Record<Direction, string> = { down: "1", up: "2" };

function fmtKm(km: number): string {
  return String(Math.round(km * 100) / 100);
}

function cell(t: Train, stationIdx: number, order: Station[], kind: "arr" | "dep"): string {
  const pos = new Map(order.map((s, i) => [s.id, i]));
  const first = pos.get(t.stops[0].stationId)!;
  const last = pos.get(t.stops.at(-1)!.stationId)!;
  if (stationIdx < first || stationIdx > last) return "";
  const st: StopTime | undefined = t.stops.find((s) => s.stationId === order[stationIdx].id);
  if (!st || st.pass) return PASS;
  if (kind === "arr") {
    if (stationIdx === first) return "";
    const v = st.arr ?? st.dep;
    return v === undefined ? "" : toHHMM(v);
  }
  if (stationIdx === last) return "";
  const v = st.dep ?? st.arr;
  return v === undefined ? "" : toHHMM(v);
}

function directionRows(tt: Timetable, dir: Direction, opts: ExportOptions): string[][] {
  const order = dir === "down" ? tt.stations : [...tt.stations].reverse();
  const trains = tt.trains.filter((t) => t.direction === dir);
  const pre = (...cols: string[]) => ["1", DIR_CODE[dir], ...cols];
  const rows: string[][] = [];

  if (opts.colorByTrain && trains.some((t) => t.color)) {
    rows.push([...pre("", "", "", "スジ色", ""), ...trains.map((t) => t.color ?? "")]);
  }
  rows.push([...pre("", "", "", "列車番号", ""), ...trains.map((t) => t.number ?? "")]);
  if (trains.some((t) => t.name)) {
    rows.push([...pre("", "", "", "列車名", ""), ...trains.map((t) => t.name ?? "")]);
  }

  order.forEach((s, i) => {
    // 着行: その駅で終着する列車、または着発時刻が違う列車がある
    // 発行: その駅から先へ発車する列車がある
    let needArr = false, needDep = false;
    for (const t of trains) {
      const k = t.stops.findIndex((x) => x.stationId === s.id);
      if (k < 0 || t.stops[k].pass) continue;
      const st = t.stops[k];
      if (k > 0 && (k === t.stops.length - 1 || (st.arr !== undefined && st.arr !== st.dep))) needArr = true;
      if (k < t.stops.length - 1) needDep = true;
    }
    if (!needArr && !needDep) needDep = true;

    const km = i === 0 ? "" : fmtKm(Math.abs(s.km - order[i - 1].km));
    const kind = s.kind && s.kind !== 1 ? String(s.kind) : "";
    const kinds: ("arr" | "dep")[] = [...(needArr ? ["arr" as const] : []), ...(needDep ? ["dep" as const] : [])];
    kinds.forEach((k, j) => {
      const head = j === 0 ? pre(kind, "", km) : pre("", "", "");
      rows.push([...head, s.name, k === "arr" ? "着" : "発", ...trains.map((t) => cell(t, i, order, k))]);
    });
  });
  return rows;
}

export const trainDiagramTsv: Exporter = {
  name: "train-diagram-tsv",
  ext: "tsv",
  export(tt, opts = {}) {
    const rows = [...directionRows(tt, "down", opts), ...directionRows(tt, "up", opts)];
    return rows.map((r) => r.join("\t")).join("\n") + "\n";
  },
};
