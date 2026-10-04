import { assertEquals } from "@std/assert";
import { fromFileUrl } from "@std/path";
import type { LineConfig } from "../src/model.ts";
import { convertNavitime } from "../src/sources/navitime/convert.ts";
import { readRawDir } from "../src/sources/navitime/mod.ts";
import { parseTime } from "../src/time.ts";
import { validateTimetable } from "../src/validate.ts";

const fixtures = fromFileUrl(new URL("./fixtures", import.meta.url));
const line = JSON.parse(
  await Deno.readTextFile(fromFileUrl(new URL("../config/lines/keio_dobutsuen.json", import.meta.url))),
) as LineConfig;

Deno.test("convertNavitime builds trains with real arrival times and tracks", async () => {
  const { timetables, stops } = await readRawDir(fixtures);
  const tt = convertNavitime(line, "holiday", timetables, stops);

  assertEquals(tt.service, { id: "holiday", validFrom: "2026-08-16", sampleDate: "2026-10-04" });
  assertEquals(tt.trains.length, 2);

  const [down, up] = tt.trains;
  assertEquals(down.direction, "down");
  assertEquals(down.number, "6301");
  assertEquals(down.stops, [
    { stationId: "takahatafudo", dep: parseTime("05:35"), track: "1" },
    { stationId: "tamadobutsukoen", arr: parseTime("05:38") },
  ]);
  assertEquals(up.direction, "up");
  assertEquals(up.number, "6300");
  assertEquals(up.stops, [
    { stationId: "tamadobutsukoen", dep: parseTime("05:43"), track: "2" },
    { stationId: "takahatafudo", arr: parseTime("05:47") },
  ]);
  assertEquals(validateTimetable(tt), []);
});

Deno.test("validateTimetable reports time going backwards and unknown stations", async () => {
  const { timetables, stops } = await readRawDir(fixtures);
  const tt = convertNavitime(line, "holiday", timetables, stops);
  tt.trains[0].stops[1].arr = 0;
  tt.trains[1].stops[1].stationId = "nowhere";
  const errors = validateTimetable(tt);
  assertEquals(errors.length, 2);
});
