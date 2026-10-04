// 時刻はすべて「サービス日 0 時からの秒数」で扱う（GTFS と同じく 24 時以降は 86400 以上）。

const DAY = 86400;

/** "HH:MM" / "HH:MM:SS" / "HHMM"（24 時以降も可） → 秒 */
export function parseTime(s: string): number {
  const m = s.trim().match(/^(\d{1,2}):?(\d{2})(?::?(\d{2}))?$/);
  if (!m) throw new Error(`invalid time: ${s}`);
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3] ?? 0);
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** 秒 → "HH:MM:SS"（GTFS 形式。24 時以降もそのまま） */
export function toHMS(sec: number): string {
  return `${pad(Math.floor(sec / 3600))}:${pad(Math.floor(sec / 60) % 60)}:${pad(sec % 60)}`;
}

/** 秒 → "HH:MM"。wrap=true なら 24 時以降を 0 時台に戻す */
export function toHM(sec: number, wrap = false): string {
  const s = wrap ? sec % DAY : sec;
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}`;
}

/** 秒 → "HHMM"（train-diagram 形式） */
export function toHHMM(sec: number, wrap = true): string {
  return toHM(sec, wrap).replace(":", "");
}

/**
 * ISO 8601 の日時（例 "2026-10-05T00:10:00+09:00"）を、serviceDate ("2026-10-04") 基準の秒に変換。
 * 日時のオフセット（現地時刻）の日付・時刻をそのまま使う。
 */
export function isoToServiceSeconds(iso: string, serviceDate: string): number {
  const m = iso.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) throw new Error(`invalid datetime: ${iso}`);
  const days = (Date.parse(m[1]) - Date.parse(serviceDate)) / (DAY * 1000);
  return days * DAY + Number(m[2]) * 3600 + Number(m[3]) * 60 + Number(m[4] ?? 0);
}
