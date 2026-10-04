import { assertEquals } from "@std/assert";
import { fromFileUrl } from "@std/path";
import type { LineConfig } from "../src/model.ts";
import { projectRoute } from "../src/route.ts";
import { convertNavitime } from "../src/sources/navitime/convert.ts";
import { readRawDir } from "../src/sources/navitime/mod.ts";
import { validateTimetable } from "../src/validate.ts";

const net = JSON.parse(
  await Deno.readTextFile(fromFileUrl(new URL("../config/lines/keio_network.json", import.meta.url))),
) as LineConfig;
const fixtures = fromFileUrl(new URL("./fixtures_network", import.meta.url));

// 京王ライナー 7731: 新宿・明大前は有料（7731）、京王永山から指定券不要（7731K）。
// 新宿と京王永山の両方の時刻表から同じ編成の停車駅一覧を取っている
Deno.test("a run fetched twice becomes one run, split where the train number changes", async () => {
  const { timetables, stops } = await readRawDir(fixtures);
  const tt = convertNavitime(net, "holiday", timetables, stops);
  assertEquals(validateTimetable(tt), []);
  assertEquals(tt.trains.length, 2);

  const [paid, free] = tt.trains;
  assertEquals([paid.number, paid.trainType, paid.reservedSeat, paid.next], ["7731", "京王ライナー", true, free.id]);
  assertEquals(paid.stops.map((s) => s.stationId), ["shinjuku", "meidaimae", "keionagayama"]);
  assertEquals(paid.stops.at(-1)!.dep, undefined);

  assertEquals([free.number, free.trainType, free.reservedSeat, free.prev], ["7731K", "京王ライナー", undefined, paid.id]);
  assertEquals(free.stops.map((s) => s.stationId), ["keionagayama", "keiotamacenter", "minamiosawa", "hashimoto"]);
  assertEquals(free.stops[0].arr, undefined);
  assertEquals(free.color, "#0a458e"); // 凡例の文字色が白なので帯色
});

Deno.test("projectRoute clips trains to one route", async () => {
  const { timetables, stops } = await readRawDir(fixtures);
  const tt = projectRoute(convertNavitime(net, "holiday", timetables, stops), "sagamihara");
  assertEquals(tt.stations[0].name, "調布");
  assertEquals(tt.stations.at(-1)!.km, 22.6);
  // 有料区間は京王線内（新宿・明大前）→ 京王永山の 1 駅しか相模原線に入らないので落ちる
  assertEquals(tt.trains.map((t) => t.number), ["7731K"]);
});
