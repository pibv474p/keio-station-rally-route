import type { LineConfig, SourceInfo, StopTime, Timetable, Train } from "../../model.ts";
import { isoToServiceSeconds } from "../../time.ts";
import type { RawStops, RawTimetable } from "./api.ts";

/** 全角数字などを半角に（番線 "１" → "1"） */
function nfkc(s: string | undefined): string | undefined {
  return s?.normalize("NFKC");
}

/** raw の駅時刻表・停車駅一覧から正規化モデルを作る（純粋関数） */
export function convertNavitime(
  line: LineConfig,
  service: string,
  timetables: RawTimetable[],
  stopsFiles: RawStops[],
): Timetable {
  const byRef = new Map(line.stations.map((s) => [s.refs?.navitime, s.id]));

  // 番線: 駅時刻表にだけ載っているので (駅, 列車番号) で引く
  const tracks = new Map<string, string>();
  let sampleDate: string | undefined;
  let validFrom: string | undefined;
  for (const t of timetables) {
    const tt = t.body.timetables.find((x) => x.target === service);
    if (!tt) continue;
    sampleDate ??= tt.date;
    validFrom ??= t.body.detail?.revision?.[service]?.date;
    for (const op of tt.operations.flatMap((o) => o.minutes)) {
      if (op.platform) tracks.set(`${t.meta.stationRef}:${op.train_no}`, nfkc(op.platform)!);
    }
  }
  if (!sampleDate) throw new Error(`no ${service} timetable in raw data`);

  // 種別色: 凡例の文字色が白（帯色付き表示）のときは帯色を使う
  const typeColor = new Map<string, string>();
  for (const t of timetables) {
    for (const ty of t.body.timetables.find((x) => x.target === service)?.legend?.types ?? []) {
      const c = ty.color?.toLowerCase() === "#ffffff" ? ty.background_color : ty.color;
      if (c && /^#[0-9a-fA-F]{6}$/.test(c)) typeColor.set(ty.name, c);
    }
  }

  // 同じ編成の運行（run）は、どの駅の時刻表から取っても同じ停車駅一覧になるので、停車駅一覧そのもので重複を除く。
  // 1 つの run は列車番号・種別が変わる所で列車（Train）に分け、next / prev でつなぐ。
  const trains: Train[] = [];
  const seenRuns = new Set<string>();
  const usedIds = new Set<string>();
  for (const f of stopsFiles) {
    const op = f.meta.operation;
    const entries = f.body.stops.filter((s) => s.id && byRef.has(s.id)); // 空要素・路線外（直通先）を除く
    if (entries.length < 2) continue;
    const sig = entries.map((s) => `${s.id}:${s.arrive_time ?? ""}:${s.departure_time ?? ""}`).join("|");
    if (seenRuns.has(sig)) continue;
    seenRuns.add(sig);

    // 区間ごとに分ける。駅の train_no / train_short_name はその駅を出る列車のもの
    type Seg = { no: string; shortName: string; entries: typeof entries };
    const segs: Seg[] = [];
    for (const e of entries) {
      const no = e.train_no ?? op.train_no;
      const shortName = e.train_short_name ?? op.type;
      const cur = segs.at(-1);
      if (cur && cur.no === no && cur.shortName === shortName) {
        cur.entries.push(e);
      } else {
        cur?.entries.push(e); // 境界駅は前の列車の終点（着）でもある
        segs.push({ no, shortName, entries: [e] });
      }
    }
    const kept = segs.filter((s) => s.entries.length >= 2);

    const ids: string[] = [];
    kept.forEach((seg, k) => {
      const stops: StopTime[] = seg.entries.map((s, i) => {
        const st: StopTime = { stationId: byRef.get(s.id)! };
        if (s.arrive_time && i > 0) st.arr = isoToServiceSeconds(s.arrive_time, sampleDate!);
        if (s.departure_time && i < seg.entries.length - 1) st.dep = isoToServiceSeconds(s.departure_time, sampleDate!);
        const track = tracks.get(`${s.id}:${seg.no}`);
        if (track) st.track = track;
        return st;
      });
      // 有料列車 = 座席指定券が必要な区間（京王ライナー・Mt.TAKAO号）。ライナー = 京王ライナーの指定券不要区間
      const reservedSeat = seg.shortName === "有料列車";
      const trainType = reservedSeat || seg.shortName === "ライナー" ? op.type : seg.shortName;
      let id = `${seg.no}@${stops[0].dep}`;
      while (usedIds.has(id)) id += "'";
      usedIds.add(id);
      ids.push(id);
      const color = typeColor.get(trainType) ?? (op.type === trainType ? op.color : undefined);
      trains.push({
        id,
        direction: f.meta.direction,
        number: seg.no,
        trainType,
        ...(color && /^#[0-9a-fA-F]{6}$/.test(color) ? { color } : {}),
        destination: op.destinations.map((d) => d.name).join("・"),
        stops,
        ...(reservedSeat ? { reservedSeat } : {}),
        ...(k > 0 ? { prev: ids[k - 1] } : {}),
        refs: { navitime: op.id },
      });
    });
    for (let k = 0; k < ids.length - 1; k++) trains[trains.length - ids.length + k].next = ids[k + 1];
  }

  const firstTime = (t: Train) => t.stops[0].dep ?? t.stops[0].arr ?? 0;
  const sorted = [...trains].sort((a, b) =>
    a.direction === b.direction ? firstTime(a) - firstTime(b) : a.direction === "down" ? -1 : 1
  );

  const sources: SourceInfo[] = [{
    type: "navitime",
    url: timetables[0]?.meta.url.replace(/\/timetable\/.*$/, ""),
    fetchedAt: timetables.map((t) => t.meta.fetchedAt).sort().at(-1),
  }];

  return {
    schemaVersion: 1,
    line: { id: line.id, name: line.name, operator: line.operator },
    service: { id: service, ...(validFrom ? { validFrom } : {}), sampleDate },
    stations: line.stations,
    ...(line.routes ? { routes: line.routes } : {}),
    trains: sorted,
    sources,
  };
}
