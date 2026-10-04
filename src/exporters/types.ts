import type { Timetable } from "../model.ts";

export interface ExportOptions {
  /** スジ色を列車の color から付ける */
  colorByTrain?: boolean;
}

/** 正規化モデル → 各ツールのファイル形式。OuDia(.oud2) / 自作 SVG はここに追加する */
export interface Exporter {
  name: string;
  ext: string;
  export(tt: Timetable, opts?: ExportOptions): string;
}
