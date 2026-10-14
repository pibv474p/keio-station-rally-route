// 路線網の全駅（除外駅以外）で改札を出る行程を、Connection Scan + ビームサーチ + 局所探索で探す。
// 重い探索は Worker に分けて並列に回す（本体は visit_core.ts、Worker は visit_worker.ts）。
//
// deno run --allow-read --allow-write tools/visit_network.ts --data data/keio_network_holiday.json \
//   --start keiotamacenter --exclude shinjuku,keioinadazutsumi,keiotamacenter \
//   --dwell 3 --time 09:00 [--beam 3000] [--allow-reserved] [--sweep 07:00-10:00/30] [--workers 8]
//   [--order "駅名,…"（探索せずその順で評価）] [--json 行程.json] [--quiet]
//   [--affinity 0xFFF5500（使う論理プロセッサ。--allow-ffi が必要。Worker 数の既定はその数）]
//   [--stats（Worker ごとの scan 回数・時間を stderr に出す。--sweep では開始時刻ごとの訪問順も出す）]
//   よく使う設定は deno task visit（P コア 4 個 + E コア 12 個に制限）
//
// - 各訪問駅では到着後 dwell 分で改札を出て入り直し、次の列車に乗れる（最後の駅は到着時刻で終了）
// - 改札を出ない乗換は 1 分。--xfer-at で駅ごとに変えられる（既定: 新宿 8 分＝京王線⇔新線、明大前 3 分＝京王線⇔井の頭線）
// - 途中で列車番号・種別が変わる列車（next / prev）は乗ったまま乗り通せる
// - reservedSeat の区間（座席指定券が必要）は --allow-reserved を付けない限り使わない
// - 状態 = (現在駅, 訪問済み集合)。1 段で 1 駅ずつ訪問を増やし、同じ状態は早い方だけ残す。
//   各段で「次に乗れる時刻 + alpha × 残り移動の見積もり」の小さい順に beam 件だけ残す（近似）。
//   alpha を変えた複数の結果をそれぞれ局所探索（区間の移動・反転）で磨き、最良を採る
// - 並列化: (開始時刻 × alpha) ごとのビームサーチ＋局所探索を Worker に配る。
//   --sweep の 2 回目は、全開始時刻で見つけた訪問順を種にして開始時刻ごとに磨き直す

import { parseArgs } from "@std/cli/parse-args";
import type { Timetable } from "../src/model.ts";
import { parseTime, toHM } from "../src/time.ts";
import { cpuList, parseMask, popcount, setProcessAffinity } from "./affinity.ts";
import { createSolver, type Result, type SolverConfig, type SolverStats, WALK_FACTOR_DEFAULT } from "./visit_core.ts";
import type { Reply, Request, Task } from "./visit_worker.ts";

const args = parseArgs(Deno.args, {
  string: ["data", "start", "exclude", "dwell", "time", "beam", "sweep", "xfer", "order", "json", "workers", "alphas", "branch", "affinity", "xfer-at", "platform-pen", "dwell-at", "xfer-reverse", "maybe-stop", "walk", "walk-speed", "walk-exit", "walk-factor"],
  boolean: ["allow-reserved", "quiet", "stats"],
  default: {
    data: "data/keio_network_holiday.json", start: "keiotamacenter", dwell: "3", time: "09:00", beam: "3000", xfer: "1",
    exclude: "", alphas: "0.8,1,1.2,1.5,2", branch: "10", "xfer-at": "shinjuku=8,meidaimae=3",
  },
});

const cfg: SolverConfig = {
  start: args.start,
  exclude: args.exclude.split(",").filter(Boolean),
  dwellMin: Number(args.dwell),
  xferMin: Number(args.xfer),
  allowReserved: args["allow-reserved"],
  beam: Number(args.beam),
  branch: Number(args.branch),
  alphas: args.alphas.split(",").map(Number),
  xferAt: Object.fromEntries(args["xfer-at"].split(",").filter(Boolean).map((kv) => {
    const [k, v] = kv.split("=");
    return [k.trim(), Number(v)];
  })),
  // 改札を出ない乗換で逆方向に乗る場合の追加時間（分）
  xferReverseMin: Number(args["xfer-reverse"] ?? 3),
  // 臨時停車の可能性がある駅（分）。例: --maybe-stop tobitakyu=1
  maybeStop: Object.fromEntries((args["maybe-stop"] ?? "").split(",").filter(Boolean).map((kv) => {
    const [k, v] = kv.split("=");
    return [k.trim(), Number(v ?? 1)];
  })),
  // 徒歩で移動できる駅の組（例: --walk config/walk_keio.json）と歩く速さ（m/分）
  walk: args.walk ? JSON.parse(await Deno.readTextFile(args.walk)).pairs : undefined,
  walkSpeed: Number(args["walk-speed"] ?? 80),
  // 歩行距離の補正係数（既定 1.03 = Google マップの実測8区間に合わせた値）。例: --walk-factor 0.9
  walkFactor: Number(args["walk-factor"] ?? WALK_FACTOR_DEFAULT),
  // 改札を出て歩き出すまで（分）。例: --walk-exit 1
  walkExitMin: args["walk-exit"] === undefined ? undefined : Number(args["walk-exit"]),
  // 駅ごとの滞在時間（分）。例: --dwell-at bubaigawara=6,kichijoji=8
  dwellAt: Object.fromEntries((args["dwell-at"] ?? "").split(",").filter(Boolean).map((kv) => {
    const [k, v] = kv.split("=");
    return [k.trim(), Number(v)];
  })),
  // 指定改札とつながっていないホームの追加時間。例: --platform-pen chitosekarasuyama=down:3,shibasaki=up:2
  platformPenalty: Object.fromEntries((args["platform-pen"] ?? "").split(",").filter(Boolean).map((kv) => {
    const [id, spec] = kv.split("=");
    const [dir, min] = (spec ?? "").split(":");
    if (dir !== "down" && dir !== "up") throw new Error(`--platform-pen: ${kv}`);
    return [id.trim(), { [dir]: Number(min) }];
  })),
};
// Worker を作る前にプロセスごと使える CPU を絞る（Worker のスレッドも同じ制限を受ける）
const affinity = args.affinity ? parseMask(args.affinity) : undefined;
if (affinity) {
  setProcessAffinity(affinity);
  console.error(`CPU: 論理プロセッサ ${cpuList(affinity).join(",")} に制限（${popcount(affinity)} スレッド）`);
}
const tt = JSON.parse(await Deno.readTextFile(args.data)) as Timetable;
const S = createSolver(tt, cfg); // 結果の表示・評価用（探索は Worker）

// ---- Worker プール
class Pool {
  #workers: Worker[] = [];
  #idle: Worker[] = [];
  #queue: { req: Request; resolve: (r: Result | null) => void; reject: (e: Error) => void }[] = [];
  // deno-lint-ignore no-explicit-any
  #pending = new Map<number, { resolve: (r: any) => void; reject: (e: Error) => void }>();
  #nextId = 0;

  static async create(size: number, data: string, cfg: SolverConfig): Promise<Pool> {
    const pool = new Pool();
    await Promise.all(Array.from({ length: size }, async () => {
      const w = new Worker(new URL("./visit_worker.ts", import.meta.url), { type: "module" });
      w.onmessage = (e: MessageEvent<Reply>) => pool.#onReply(w, e.data);
      w.onerror = (e) => {
        e.preventDefault();
        for (const p of pool.#pending.values()) p.reject(new Error(e.message));
      };
      pool.#workers.push(w);
      await pool.#send(w, { id: pool.#nextId++, init: { data, cfg } });
    }));
    pool.#idle = [...pool.#workers];
    return pool;
  }

  // deno-lint-ignore no-explicit-any
  #send(w: Worker, req: Request): Promise<any> {
    return new Promise((resolve, reject) => {
      this.#pending.set(req.id, { resolve, reject });
      w.postMessage(req);
    });
  }

  #onReply(w: Worker, rep: Reply) {
    const p = this.#pending.get(rep.id);
    this.#pending.delete(rep.id);
    if (rep.error) p?.reject(new Error(rep.error));
    else p?.resolve(rep.stats ?? rep.result ?? null);
    const next = this.#queue.shift();
    if (next) this.#send(w, next.req).then(next.resolve, next.reject);
    else this.#idle.push(w);
  }

  run(task: Task): Promise<Result | null> {
    const req: Request = { id: this.#nextId++, task };
    const w = this.#idle.pop();
    if (w) return this.#send(w, req);
    return new Promise((resolve, reject) => this.#queue.push({ req, resolve, reject }));
  }

  /** 全 Worker の計測値（タスクがすべて終わってから呼ぶ） */
  stats(): Promise<SolverStats[]> {
    return Promise.all(this.#workers.map((w) => this.#send(w, { id: this.#nextId++, stats: true })));
  }

  close() {
    for (const w of this.#workers) w.terminate();
  }
}

const fmtDur = (sec: number) => `${Math.floor(sec / 3600)}時間${String(Math.round(sec / 60) % 60).padStart(2, "0")}分`;
const better = (a: Result | null | undefined, b: Result | null | undefined) => (!a ? b : !b ? a : b.end < a.end ? b : a);
const poolSize = (tasks: number) =>
  Math.max(1, Math.min(tasks, Number(args.workers ?? (affinity ? popcount(affinity) : Math.max(1, navigator.hardwareConcurrency - 2)))));

function printItinerary(order: number[], t0: number) {
  const d = S.describe(order, t0);
  console.log(d.lines.join("\n"));
  console.log(`乗車 ${fmtDur(d.rides)}・乗車回数 ${d.legsN}・改札 ${S.T - 1}回×${cfg.dwellMin}分`);
  return d;
}

/** --stats: Worker ごとの計測値を stderr に出す */
function printStats(list: SolverStats[]) {
  const n = (x: number) => x.toLocaleString("en-US");
  const s = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
  const sum: SolverStats = {
    scan: { beam: 0, improve: 0, eval: 0, describe: 0 },
    ms: { beam: 0, improve: 0, eval: 0 },
    calls: { beam: 0, improve: 0 },
  };
  const line = (label: string, x: SolverStats) => {
    const total = x.scan.beam + x.scan.improve + x.scan.eval + x.scan.describe;
    return `${label} scan ${n(total)}（beam ${n(x.scan.beam)} / improve ${n(x.scan.improve)} / eval ${n(x.scan.eval)}）` +
      `  beam ${s(x.ms.beam)}×${x.calls.beam}  improve ${s(x.ms.improve)}×${x.calls.improve}  eval ${s(x.ms.eval)}`;
  };
  list.forEach((x, i) => {
    console.error(line(`[stats] W${String(i).padStart(2, "0")}`, x));
    for (const g of ["scan", "ms", "calls"] as const) {
      for (const k of Object.keys(x[g]) as (keyof typeof x[typeof g])[]) (sum[g] as Record<string, number>)[k] += (x[g] as Record<string, number>)[k];
    }
  });
  console.error(line("[stats] 合計", sum));
}

const tStart = performance.now();
const elapsed = () => `${((performance.now() - tStart) / 1000).toFixed(1)}s`;

if (args.sweep) {
  const m = args.sweep.match(/^(\d\d:\d\d)-(\d\d:\d\d)\/(\d+)$/);
  if (!m) throw new Error("--sweep HH:MM-HH:MM/分");
  const times: number[] = [];
  for (let t = parseTime(m[1]); t <= parseTime(m[2]); t += Number(m[3]) * 60) times.push(t);
  const alphas = cfg.alphas!;
  const pool = await Pool.create(poolSize(times.length * alphas.length), args.data, cfg);
  try {
    // 1 回目: 開始時刻 × alpha をすべて並列に
    const pass1 = await Promise.all(times.map((t0) =>
      Promise.all(alphas.map((alpha) => pool.run({ kind: "beam", t0, alpha }))).then((rs) => rs.reduce(better, null))
    ));
    const seeds = pass1.filter((r): r is Result => !!r).map((r) => r.order);
    console.error(`1 回目 ${elapsed()}（${times.length * alphas.length} タスク）`);
    // 2 回目: 全開始時刻で見つけた訪問順を種に、開始時刻ごとに磨き直す（遅い開始で使える順は早い開始でも使える）
    const pass2 = await Promise.all(times.map((t0) => pool.run({ kind: "refine", t0, seeds })));
    console.error(`2 回目 ${elapsed()}`);
    const results = times.map((t, i) => ({ t, r: better(pass1[i], pass2[i]) }));
    for (const { t, r } of results) {
      console.log(`${toHM(t)} 入場 → ${r ? `${toHM(r.end)} 完了（${fmtDur(r.end - t)}）` : "到達不能"}`);
    }
    if (args.stats) {
      for (const { t, r } of results) console.error(`[stats] ${toHM(t)} ${r ? toHM(r.end) : "-"} ${r ? r.order.map(S.name).join(",") : ""}`);
      printStats(await pool.stats());
    }
    const top = results.filter((x) => x.r).reduce((a, b) => (b.r!.end - b.t < a.r!.end - a.t ? b : a));
    console.log(`\n最短: ${toHM(top.t)} 入場 → ${toHM(top.r!.end)} 完了（${fmtDur(top.r!.end - top.t)}）`);
    printItinerary(top.r!.order, top.t);
  } finally {
    pool.close();
  }
} else {
  const t0 = parseTime(args.time);
  let r: Result | null | undefined;
  if (args.order) {
    // 探索せず指定の順で評価する（保存した結果の再現用）
    const order = args.order.split(",").map((n) => {
      const i = tt.stations.findIndex((s) => s.name === n.trim() || s.id === n.trim());
      if (i < 0) throw new Error(`unknown station ${n}`);
      return i;
    });
    r = { order, end: S.evalOrder(order, t0) };
    if (args.stats) printStats([S.getStats()]);
  } else {
    const alphas = cfg.alphas!;
    const pool = await Pool.create(poolSize(alphas.length), args.data, cfg);
    try {
      r = (await Promise.all(alphas.map((alpha) => pool.run({ kind: "beam", t0, alpha })))).reduce(better, null);
      if (args.stats) printStats(await pool.stats());
    } finally {
      pool.close();
    }
  }
  if (!r) throw new Error("no solution");
  console.log(
    `${S.T}駅 / 滞在${cfg.dwellMin}分 / beam ${cfg.beam}: ${toHM(t0)} 入場 → ${toHM(r.end)} 完了（${fmtDur(r.end - t0)}）  計算 ${elapsed()}`,
  );
  if (!args.quiet) {
    const d = printItinerary(r.order, t0);
    console.log(`訪問順: ${r.order.map(S.name).join(" → ")}`);
    if (args.json) {
      await Deno.writeTextFile(args.json, JSON.stringify({
        data: args.data, start: tt.stations[S.startSt].id, excluded: [...S.excluded].map((i) => tt.stations[i].id),
        dwellMin: cfg.dwellMin, xferMin: cfg.xferMin, xferAt: cfg.xferAt, platformPenalty: cfg.platformPenalty, dwellAt: cfg.dwellAt, xferReverseMin: cfg.xferReverseMin, maybeStop: cfg.maybeStop, walkSpeed: cfg.walk ? cfg.walkSpeed : undefined, walkFactor: cfg.walk ? cfg.walkFactor : undefined, allowReserved: cfg.allowReserved,
        t0, end: r.end, order: r.order.map((i) => tt.stations[i].id), legs: d.legs,
      }, null, 1) + "\n");
      console.log(`wrote ${args.json}`);
    }
  }
}
