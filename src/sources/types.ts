import type { LineConfig, Timetable } from "../model.ts";

export interface SourceOptions {
  line: LineConfig;
  /** "weekday" | "holiday" など */
  service: string;
  /** raw/<source>/ の親ディレクトリ */
  rawRoot: string;
  /** 対象日 YYYY-MM-DD（その日のダイヤ）。省略時は直近の該当日 / raw の最新 */
  date?: string;
  log?: (msg: string) => void;
}

/**
 * 入力元ごとのアダプタ。fetch で生データを raw/ に保存し、load で raw/ から正規化モデルを作る。
 * load はネットワークに触れない（テストは raw のフィクスチャだけで回せる）。
 */
export interface SourceAdapter {
  name: string;
  fetch?(opts: SourceOptions): Promise<void>;
  load(opts: SourceOptions): Promise<Timetable>;
}
