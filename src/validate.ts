import { Ajv } from "ajv";
import schema from "../schemas/timetable.v1.json" with { type: "json" };
import type { Timetable } from "./model.ts";

const validateSchema = new Ajv({ allErrors: true }).compile(schema);

/** JSON Schema + スキーマで表せない整合性（駅ID・時刻の単調増加）を検査し、問題の一覧を返す */
export function validateTimetable(tt: Timetable): string[] {
  const errors: string[] = [];
  if (!validateSchema(tt)) {
    for (const e of validateSchema.errors ?? []) errors.push(`${e.instancePath} ${e.message}`);
    return errors;
  }
  const stationIds = new Set(tt.stations.map((s) => s.id));
  const ids = new Set<string>();
  for (const t of tt.trains) {
    if (ids.has(t.id)) errors.push(`duplicate train id ${t.id}`);
    ids.add(t.id);
    let prev = -1;
    for (const s of t.stops) {
      if (!stationIds.has(s.stationId)) errors.push(`${t.id}: unknown station ${s.stationId}`);
      for (const v of [s.arr, s.dep]) {
        if (v === undefined) continue;
        if (v < prev) errors.push(`${t.id}: time goes backwards at ${s.stationId}`);
        prev = v;
      }
    }
  }
  return errors;
}
