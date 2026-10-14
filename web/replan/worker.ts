// ブラウザ用 Worker（スマホの再計算画面から使う）。deno bundle で worker.js にまとめる。
// 探索の本体は tools/visit_core.ts をそのまま使う。
//   init     … 時刻表 JSON（文字列）と条件で solver を作る
//   beam     … 重み alpha でビームサーチ → 局所探索
//   describe … 訪問順から行程（乗車区間の一覧）を作る

/// <reference lib="webworker" />
import type { Timetable } from "../../src/model.ts";
import { createSolver, type Solver, type SolverConfig } from "../../tools/visit_core.ts";

type Msg =
  | { id: number; init: { data: string; cfg: SolverConfig } }
  | { id: number; beam: { t0: number; alpha: number } }
  | { id: number; describe: { order: number[]; t0: number } };

let solver: Solver | undefined;

self.onmessage = (e: MessageEvent<Msg>) => {
  const m = e.data;
  try {
    if ("init" in m) {
      solver = createSolver(JSON.parse(m.init.data) as Timetable, m.init.cfg);
      self.postMessage({ id: m.id, ok: true, targets: solver.T });
      return;
    }
    if (!solver) throw new Error("worker not initialized");
    if ("beam" in m) {
      const order = solver.beam(m.beam.t0, m.beam.alpha);
      const r = order ? solver.improve(order, m.beam.t0) : null;
      self.postMessage({ id: m.id, ok: true, result: r });
    } else {
      const d = solver.describe(m.describe.order, m.describe.t0);
      self.postMessage({ id: m.id, ok: true, legs: d.legs });
    }
  } catch (err) {
    self.postMessage({ id: m.id, ok: false, error: String((err as Error)?.message ?? err) });
  }
};
