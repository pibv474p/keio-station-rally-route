// 正規化モデル。GTFS (stops / trips / stop_times) と ODPT (Station / TrainTimetable) に
// 対応付けられる粒度で持つ。どの Source adapter もこの形を出力し、Exporter はこの形だけを読む。

export type Direction = "down" | "up";
export type SourceType = "navitime" | "odpt" | "gtfs" | string;

/** ソースごとの外部ID（navitime 駅ID、odpt:Station の owl:sameAs、GTFS stop_id など） */
export type Refs = Partial<Record<SourceType, string>>;

export interface Timetable {
  schemaVersion: 1;
  line: { id: string; name: string; operator: string };
  service: { id: string; validFrom?: string; sampleDate?: string };
  /** 単線区なら下り方向の順。路線網なら全駅（並びは routes で表す） */
  stations: Station[];
  /** 分岐のある路線網の各線区（なければ stations の並びが 1 本の線区） */
  routes?: Route[];
  trains: Train[];
  sources: SourceInfo[];
}

/** 路線網の中の 1 線区（GTFS の route / ODPT の Railway に相当） */
export interface Route {
  id: string;
  name: string;
  /** 下り方向の順。km はこの線区の起点からのキロ程 */
  stations: { stationId: string; km: number }[];
  refs?: Refs;
}

export interface Station {
  id: string;
  name: string;
  /** 起点からのキロ程 */
  km: number;
  /** 駅の強調度 1:細 2:中 3:太（train-diagram の駅種） */
  kind?: number;
  refs?: Refs;
}

export interface Train {
  /** ソース内で一意。ODPT: TrainTimetable の id、GTFS: trip_id */
  id: string;
  direction: Direction;
  number?: string;
  name?: string;
  trainType?: string;
  /** 表示用の色（ソースが種別色を持つ場合） */
  color?: string;
  destination?: string;
  /** 停車・通過の順 */
  stops: StopTime[];
  /** 座席指定券などの追加料金が必要（例: 京王ライナーの有料区間、Mt.TAKAO号） */
  reservedSeat?: boolean;
  /**
   * 途中で列車番号・種別が変わる場合の続き（同じ編成のまま乗り通せる）。
   * ODPT の odpt:nextTrainTimetable、GTFS の block_id に相当。境界駅は前の列車の最後（着）と次の列車の最初（発）に入る
   */
  next?: string;
  prev?: string;
  refs?: Refs;
}

export interface StopTime {
  stationId: string;
  /** サービス日の 0 時からの秒数。翌日にまたがる場合は 86400 以上 */
  arr?: number;
  dep?: number;
  track?: string;
  pass?: boolean;
  /** 推定で補った項目 */
  estimated?: ("arr" | "dep")[];
}

export interface SourceInfo {
  type: SourceType;
  url?: string;
  fetchedAt?: string;
  note?: string;
}

/** config/lines/*.json */
export interface LineConfig {
  id: string;
  name: string;
  operator: string;
  stations: Station[];
  routes?: Route[];
  sources: Record<string, unknown>;
}
