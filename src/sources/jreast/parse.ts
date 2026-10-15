// JR東日本 公式時刻表サイト（timetables.jreast.co.jp）の HTML を読む。ネットワークには触れない。
//   list<駅コード>.html                     … 駅の路線・方面ごとの時刻表へのリンク
//   <版>/timetable/tt<駅>/<駅><nn><d>.html   … 駅時刻表（d: 0 平日 / 1 土曜・休日）
//   <版>/train/<nnn>/<file>.html             … 列車の停車駅一覧（1 ページに続けて走る列車が複数列で並ぶ）

export interface StationLineLink {
  line: string;
  direction: string;
  weekday?: string;
  holiday?: string;
}

export interface StationDeparture {
  /** 0 時からの秒（深夜 0〜2 時台は 86400 以上） */
  dep: number;
  trainType: string;
  dest: string;
  /** 停車駅一覧ページ（サイトのルートからの相対パス。例: 2610/train/010/011171.html） */
  train: string;
}

export interface StationTimetablePage {
  title: string;
  departures: StationDeparture[];
}

export interface TrainStop {
  station: string; // 駅コード（list<code>.html）
  name: string;
  arr?: number;
  dep?: number;
  track?: string;
  pass?: boolean;
}

export interface TrainColumn {
  trainType: string;
  number: string;
  name?: string;
  days: string;
  stops: TrainStop[];
}

const decode = (s: string) =>
  s.replace(/<[^>]+>/g, "").replace(/&emsp;|&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/[ \t\r\n　]+/g, " ").trim();

const zen2han = (s: string) => s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));

/** 版（例: "2610"）を駅ページのリンクから取る */
export function detectVersion(listHtml: string): string | undefined {
  return listHtml.match(/\.\.\/(\d{4})\/timetable\/tt\d+\//)?.[1];
}

export function parseStationList(html: string): StationLineLink[] {
  const out: StationLineLink[] = [];
  let line = "";
  for (const tr of html.matchAll(/<tr>([\s\S]*?)<\/tr>/g)) {
    const body = tr[1];
    const th = body.match(/<th[^>]*>([\s\S]*?)<\/th>/);
    if (th) line = decode(th[1]);
    const dir = body.match(/<td>([\s\S]*?)<\/td>/);
    if (!dir) continue;
    const wd = body.match(/<td class="weekday"><a href="\.\.\/([^"]+\/timetable\/tt[^"]+)"/);
    const hd = body.match(/<td class="holiday"><a href="\.\.\/([^"]+\/timetable\/tt[^"]+)"/);
    if (!wd && !hd) continue;
    out.push({ line, direction: decode(dir[1]), weekday: wd?.[1], holiday: hd?.[1] });
  }
  return out;
}

/** 駅時刻表。pagePath はこのページのパス（列車リンクの相対パスを解決する） */
export function parseStationTimetable(html: string, pagePath: string): StationTimetablePage {
  const title = decode(html.match(/<h2>([\s\S]*?)<\/h2>/)?.[1] ?? "");
  const base = pagePath.split("/").slice(0, -1);
  const departures: StationDeparture[] = [];
  let prev = -1;
  for (const row of html.matchAll(/<tr id="time_(\d+)">([\s\S]*?)<\/tr>/g)) {
    const hour = Number(row[1]);
    for (const d of row[2].matchAll(/<div class="timetable_time"([^>]*)>([\s\S]*?)<\/div>/g)) {
      const attr = d[1];
      const href = d[2].match(/<a href="([^"]+)"/)?.[1];
      const min = d[2].match(/<span class="minute">(\d+)<\/span>/)?.[1];
      if (!href || min === undefined) continue;
      let t = hour * 3600 + Number(min) * 60;
      if (t < prev - 12 * 3600) t += 86400; // 0 時台以降（翌日）
      prev = t;
      departures.push({
        dep: t,
        trainType: attr.match(/data-train="([^"]*)"/)?.[1] ?? "",
        dest: attr.match(/data-dest="([^"]*)"/)?.[1] ?? "",
        train: resolve(base, href),
      });
    }
  }
  return { title, departures };
}

function resolve(base: string[], href: string): string {
  const parts = [...base];
  for (const p of href.split("/")) {
    if (p === "..") parts.pop();
    else if (p !== ".") parts.push(p);
  }
  return parts.join("/");
}

/** 列車の停車駅一覧。複数列（途中で列車番号が変わる・環状運転）はそれぞれ 1 列車として返す（並びは走る順） */
export function parseTrainPage(html: string): TrainColumn[] {
  const rows = [...html.matchAll(/<tr class="(train|time)">([\s\S]*?)<\/tr>/g)];
  const header = (label: string): string[] => {
    for (const r of rows) {
      if (r[1] !== "train") continue;
      if (!new RegExp(`<th>${label}</th>`).test(r[2])) continue;
      return [...r[2].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => decode(m[1]));
    }
    return [];
  };
  const types = header("列車種別");
  const numbers = header("列車番号");
  const names = header("列車名");
  const days = header("運転日");
  const n = Math.max(types.length, numbers.length);
  const cols: TrainColumn[] = Array.from({ length: n }, (_, i) => ({
    trainType: types[i] ?? "",
    number: numbers[i] ?? "",
    name: names[i] || undefined,
    days: days[i] ?? "",
    stops: [],
  }));

  let station = "", name = "";
  const last = new Array<number>(n).fill(-1);
  for (const r of rows) {
    if (r[1] !== "time") continue;
    const th = r[2].match(/<th class="time">([\s\S]*?)<\/th>/)?.[1] ?? "";
    const link = th.match(/list(\d+)\.html">([^<]*)</);
    if (link) [station, name] = [link[1], link[2].trim()];
    else if (decode(th) && !link) [station, name] = ["", decode(th)]; // 他社線の駅など（リンクなし）
    const cells = [...r[2].matchAll(/<td class="(time|platform)">([\s\S]*?)<\/td>/g)];
    for (let c = 0; c < n; c++) {
      const time = cells[c * 2]?.[2] ?? "";
      const plat = cells[c * 2 + 1]?.[2] ?? "";
      const txt = decode(time);
      if (!txt) continue;
      const col = cols[c];
      let stop = col.stops.at(-1);
      if (!stop || stop.name !== name || stop.station !== station) {
        stop = { station, name };
        col.stops.push(stop);
      }
      for (const m of txt.matchAll(/(\d{1,2}):(\d{2})\s*(着|発)/g)) {
        let t = Number(m[1]) * 3600 + Number(m[2]) * 60;
        while (t < last[c] - 12 * 3600) t += 86400;
        if (last[c] < 0 && t < 3 * 3600) t += 86400; // 0〜2 時台に始まる列車は前日のサービス日（深夜）として扱う
        last[c] = Math.max(last[c], t);
        if (m[3] === "着") stop.arr = t;
        else stop.dep = t;
      }
      if (stop.arr === undefined && stop.dep === undefined && /レ|↓|｜|\|/.test(txt)) stop.pass = true;
      const track = zen2han(decode(plat));
      if (track) stop.track = track;
    }
  }
  for (const c of cols) c.stops = c.stops.filter((s) => s.arr !== undefined || s.dep !== undefined || s.pass);
  return cols;
}
