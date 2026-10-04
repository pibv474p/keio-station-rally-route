// visit_network.ts から起動される Worker。init で時刻表を読んで solver を作り、以降はタスクを 1 つずつ処理する。

/// <reference lib="deno.worker" />
import type { Timetable } from "../src/model.ts";
import { createSolver, type Solver, type SolverConfig } from "./visit_core.ts";

export type Task =
  /** 重み alpha でビームサーチ → 局所探索 */
  | { kind: "beam"; t0: number; alpha: number }
  /** 種の訪問順のうち一番早いものを局所探索 */
  | { kind: "refine"; t0: number; seeds: number[][] };

export type Request = { id: number; init: { data: string; cfg: SolverConfig } } | { id: number; task: Task };
export type Reply = { id: number; result?: { order: number[]; end: number } | null; error?: string };

let solver: Solver | undefined;

self.onmessage = async (e: MessageEvent<Request>) => {
  const msg = e.data;
  try {
    if ("init" in msg) {
      const tt = JSON.parse(await Deno.readTextFile(msg.init.data)) as Timetable;
      solver = createSolver(tt, msg.init.cfg);
      self.postMessage({ id: msg.id, result: null } satisfies Reply);
      return;
    }
    if (!solver) throw new Error("worker not initialized");
    const task = msg.task;
    let result: { order: number[]; end: number } | null = null;
    if (task.kind === "beam") {
      const order = solver.beam(task.t0, task.alpha);
      result = order ? solver.improve(order, task.t0) : null;
    } else {
      let best: number[] | undefined, bestEnd = Infinity;
      for (const o of task.seeds) {
        const end = solver.evalOrder(o, task.t0, bestEnd);
        if (end < bestEnd) (best = o, bestEnd = end);
      }
      result = best ? solver.improve(best, task.t0) : null;
    }
    self.postMessage({ id: msg.id, result } satisfies Reply);
  } catch (err) {
    self.postMessage({ id: msg.id, error: String((err as Error)?.stack ?? err) } satisfies Reply);
  }
};
