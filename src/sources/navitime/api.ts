// transfer-train.navitime.biz（京王などの公式時刻表サイト）の JSON API の型。
// 画面と同じ API を使う: /api/<company>/timetable/<station>/<line>/<direction>
//                         /api/<company>/stops/<station>/<line>?operation_id=..&datetime=..&direction=..

export const BASE = "https://transfer-train.navitime.biz/api";

/** 正規化モデルの down/up → API の direction パラメータ（線ごとに違う。京王新線は逆） */
export interface DirectionParam {
  down: string;
  up: string;
}

/**
 * 単線区: lineId + directionParam。
 * 路線網: lines（NAVITIME の線ID → DirectionParam）。各線区の駅の並びは config の routes（refs.navitime = 線ID）。
 */
export interface NavitimeConfig {
  company: string;
  lineId?: string;
  directionParam?: DirectionParam;
  lines?: Record<string, DirectionParam>;
}

export interface TimetableOperation {
  time: string;
  id: string;
  train_no: string;
  type: string;
  color?: string;
  is_departure: boolean;
  destinations: { name: string; legend?: string }[];
  platform?: string;
}

export interface TimetableResponse {
  station: { id: string; name: string };
  timetables: {
    target: string;
    date: string;
    legend?: { types?: { name: string; color?: string; background_color?: string }[] };
    operations: { hour: number; minutes: TimetableOperation[] }[];
  }[];
  detail?: { revision?: Record<string, { date: string; type: string }> };
}

export interface StopEntry {
  id?: string;
  name?: string;
  arrive_time?: string;
  departure_time?: string;
  train_no?: string;
  train_short_name?: string;
  /** この駅から先の線ID（直通列車は途中で変わる） */
  advancing_line_id?: string;
}

export interface StopsResponse {
  stops: StopEntry[];
}

/** raw/ に保存する形。取得条件を一緒に残す */
export interface RawFile<M, B> {
  meta: M & { url: string; fetchedAt: string };
  body: B;
}

export interface TimetableMeta {
  kind: "timetable";
  stationRef: string;
  /** 旧形式（単線区）では省略 */
  lineId?: string;
  direction: "down" | "up";
}

export interface StopsMeta {
  kind: "stops";
  stationRef: string;
  lineId?: string;
  direction: "down" | "up";
  operation: TimetableOperation;
}

export type RawTimetable = RawFile<TimetableMeta, TimetableResponse>;
export type RawStops = RawFile<StopsMeta, StopsResponse>;

export function timetableUrl(company: string, lineId: string, stationRef: string, dirParam: string, date?: string): string {
  // datetime を付けるとその日以降で最初の平日・土休日のダイヤが返る（終日分）
  const dt = date ? `&datetime=${encodeURIComponent(`${date}T12:00:00+09:00`)}` : "";
  return `${BASE}/${company}/timetable/${stationRef}/${lineId}/${dirParam}?lang=ja${dt}`;
}

export function stopsUrl(company: string, lineId: string, stationRef: string, dirParam: string, op: TimetableOperation): string {
  const q = new URLSearchParams({ operation_id: op.id, datetime: op.time, lang: "ja", direction: dirParam });
  return `${BASE}/${company}/stops/${stationRef}/${lineId}?${q}`;
}
