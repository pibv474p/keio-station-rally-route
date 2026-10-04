import { assertEquals } from "@std/assert";
import { trainDiagramTsv } from "../src/exporters/train_diagram_tsv.ts";
import type { Timetable } from "../src/model.ts";
import { parseTime as t } from "../src/time.ts";

// A─B─C の 3 駅。下り 2 本（1 本は B 通過、1 本は B 止まり）、上り 1 本
const tt: Timetable = {
  schemaVersion: 1,
  line: { id: "x", name: "X線", operator: "X" },
  service: { id: "holiday" },
  stations: [
    { id: "a", name: "A", km: 0, kind: 2 },
    { id: "b", name: "B", km: 1.5 },
    { id: "c", name: "C", km: 3.7, kind: 2 },
  ],
  trains: [
    {
      id: "1",
      direction: "down",
      number: "1",
      color: "#cc0000",
      stops: [{ stationId: "a", dep: t("05:00") }, { stationId: "b", pass: true }, { stationId: "c", arr: t("05:10") }],
    },
    {
      id: "3",
      direction: "down",
      number: "3",
      stops: [{ stationId: "a", dep: t("06:00") }, { stationId: "b", arr: t("06:05") }],
    },
    {
      id: "2",
      direction: "up",
      number: "2",
      name: "快速",
      stops: [
        { stationId: "c", dep: t("23:55") },
        { stationId: "b", arr: t("24:00"), dep: t("24:01") },
        { stationId: "a", arr: t("24:05") },
      ],
    },
  ],
  sources: [],
};

const tsv = (rows: string[][]) => rows.map((r) => r.join("\t")).join("\n") + "\n";

Deno.test("train-diagram TSV: rows per station, passes, short runs, distance and color", () => {
  assertEquals(
    trainDiagramTsv.export(tt, { colorByTrain: true }),
    tsv([
      ["1", "1", "", "", "", "スジ色", "", "#cc0000", ""],
      ["1", "1", "", "", "", "列車番号", "", "1", "3"],
      ["1", "1", "2", "", "", "A", "発", "0500", "0600"],
      ["1", "1", "", "", "1.5", "B", "着", "レ", "0605"],
      ["1", "1", "2", "", "2.2", "C", "着", "0510", ""],
      ["1", "2", "", "", "", "列車番号", "", "2"],
      ["1", "2", "", "", "", "列車名", "", "快速"],
      ["1", "2", "2", "", "", "C", "発", "2355"],
      ["1", "2", "", "", "2.2", "B", "着", "0000"],
      ["1", "2", "", "", "", "B", "発", "0001"],
      ["1", "2", "2", "", "1.5", "A", "着", "0005"],
    ]),
  );
});
