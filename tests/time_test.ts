import { assertEquals, assertThrows } from "@std/assert";
import { isoToServiceSeconds, parseTime, toHHMM, toHM, toHMS } from "../src/time.ts";

Deno.test("parseTime accepts HH:MM, HH:MM:SS, HHMM and >24h", () => {
  assertEquals(parseTime("05:35"), 5 * 3600 + 35 * 60);
  assertEquals(parseTime("0535"), 5 * 3600 + 35 * 60);
  assertEquals(parseTime("25:10:30"), 25 * 3600 + 10 * 60 + 30);
  assertThrows(() => parseTime("5時35分"));
});

Deno.test("formatting keeps or wraps hours past midnight", () => {
  const s = parseTime("24:10");
  assertEquals(toHMS(s), "24:10:00");
  assertEquals(toHM(s), "24:10");
  assertEquals(toHM(s, true), "00:10");
  assertEquals(toHHMM(s), "0010");
});

Deno.test("isoToServiceSeconds counts next-day times past 24h", () => {
  assertEquals(isoToServiceSeconds("2026-10-04T05:43:00+09:00", "2026-10-04"), parseTime("05:43"));
  assertEquals(isoToServiceSeconds("2026-10-05T00:10:00+09:00", "2026-10-04"), parseTime("24:10"));
});
