import type { Timetable, Train } from "./model.ts";

/**
 * 路線網の Timetable から 1 線区だけを取り出し、単線区の Timetable にする（ダイヤグラム出力用）。
 * 列車はその線区内の停車だけに切り詰め、線区内で 2 駅以上止まる列車だけ残す。
 */
export function projectRoute(tt: Timetable, routeId: string): Timetable {
  const route = tt.routes?.find((r) => r.id === routeId);
  if (!route) throw new Error(`unknown route ${routeId}. routes: ${tt.routes?.map((r) => r.id).join(", ")}`);
  const byId = new Map(tt.stations.map((s) => [s.id, s]));
  const inRoute = new Set(route.stations.map((s) => s.stationId));

  const trains: Train[] = [];
  for (const t of tt.trains) {
    // 線区に出入りする区間ごとに分ける（例: 京王線→相模原線→京王線… は起きないが、念のため連続区間で切る）
    let run: Train["stops"] = [];
    const flush = () => {
      if (run.length >= 2) {
        const stops = run.map((s, i) => {
          const c = { ...s };
          if (i === 0) delete c.arr;
          if (i === run.length - 1) delete c.dep;
          return c;
        });
        trains.push({ ...t, id: trains.some((x) => x.id === t.id) ? `${t.id}#${trains.length}` : t.id, stops });
      }
      run = [];
    };
    for (const s of t.stops) inRoute.has(s.stationId) ? run.push(s) : flush();
    flush();
  }

  return {
    ...tt,
    line: { ...tt.line, id: `${tt.line.id}.${route.id}`, name: route.name },
    stations: route.stations.map((rs) => ({ ...byId.get(rs.stationId)!, km: rs.km })),
    routes: undefined,
    trains,
  };
}
