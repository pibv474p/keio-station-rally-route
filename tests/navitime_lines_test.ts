import { assertEquals } from "@std/assert";
import { fromFileUrl } from "@std/path";
import type { LineConfig } from "../src/model.ts";
import { navitimeLines } from "../src/sources/navitime/fetch.ts";

const load = async (id: string) =>
  JSON.parse(await Deno.readTextFile(fromFileUrl(new URL(`../config/lines/${id}.json`, import.meta.url)))) as LineConfig;

Deno.test("single-line config becomes one navitime line with all stations", async () => {
  const lines = navitimeLines({ line: await load("keio_inokashira"), service: "holiday", rawRoot: "" });
  assertEquals(lines.length, 1);
  assertEquals(lines[0].lineId, "7");
  assertEquals(lines[0].stations.length, 17);
});

Deno.test("network config: one navitime line per route, 京王新線 has reversed direction", async () => {
  const net = await load("keio_network");
  const lines = navitimeLines({ line: net, service: "holiday", rawRoot: "" });
  assertEquals(lines.map((l) => l.lineId), ["1", "2", "3", "4", "5", "6"]);
  assertEquals(lines[1].directionParam, { down: "0", up: "1" });
  assertEquals(lines[1].stations.map((s) => s.name), ["新宿", "初台", "幡ヶ谷", "笹塚"]);
  // 全 53 駅（KO01〜KO53）がどこかの線区に属する
  const covered = new Set(lines.flatMap((l) => l.stations.map((s) => s.id)));
  assertEquals(covered.size, net.stations.length);
  assertEquals(net.stations.length, 53);
});
