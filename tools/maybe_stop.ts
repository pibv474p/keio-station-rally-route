// 臨時停車の可能性がある駅の扱い（例: 土休日の飛田給。味の素スタジアムの催しに合わせて特急などが臨時停車する）。
// 停まるかどうか・どの列車かは事前に分からないので、保守的に
//   - その駅を通過する列車は、駅を過ぎた後の時刻を delaySec 遅らせる（停まった場合に乗り継ぎが崩れないように）
//   - その列車でその駅に乗り降りする前提にはしない（停まらないかもしれないので）
// として時刻表を書き換える。探索（visit_core）と描画（render_itinerary）の両方で同じ処理をかける。

import type { Timetable, Train } from "../src/model.ts";

export function applyMaybeStop(tt: Timetable, stationId: string, delaySec: number): number {
  const routes = (tt.routes ?? []).filter((r) => r.stations.some((s) => s.stationId === stationId));
  const idx = routes.map((r) => new Map(r.stations.map((s, i) => [s.stationId, i])));
  const straddles = (a: string, b: string) =>
    idx.some((m) => {
      const ia = m.get(a), ib = m.get(b), is = m.get(stationId)!;
      return ia !== undefined && ib !== undefined && Math.min(ia, ib) < is && is < Math.max(ia, ib);
    });

  const byId = new Map(tt.trains.map((t) => [t.id, t]));
  let affected = 0;
  // 直通（next）は同じ編成なので遅れを引き継ぐ。先頭（prev なし）からたどる
  for (const head of tt.trains.filter((t) => !t.prev || !byId.has(t.prev))) {
    let offset = 0;
    for (let t: Train | undefined = head; t; t = t.next ? byId.get(t.next) : undefined) {
      const stops = t.stops.filter((s) => !s.pass);
      let hit = false;
      stops.forEach((s, k) => {
        if (k > 0 && straddles(stops[k - 1].stationId, s.stationId)) (offset += delaySec, hit = true);
        if (offset && k > 0) {
          if (s.arr !== undefined) s.arr += offset;
          if (s.dep !== undefined) s.dep += offset;
        } else if (offset && k === 0 && s.dep !== undefined) {
          s.dep += offset; // 直通の続きの列車の始発駅
        }
      });
      if (hit) affected++;
    }
  }
  return affected;
}
