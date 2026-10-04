// 全駅下車の行程探索（Connection Scan + ビームサーチ + 局所探索）の本体。
// 状態を関数の中に閉じ込めてあるので、Worker ごとに createSolver して並列に使える。
// 探索の考え方は visit_network.ts の冒頭を参照。

import type { Timetable } from "../src/model.ts";
import { toHM } from "../src/time.ts";

export interface SolverConfig {
  start: string;
  exclude: string[];
  dwellMin: number;
  xferMin: number;
  allowReserved: boolean;
  beam: number;
  branch?: number;
  /** 駅ごとの乗換時間（分）。既定は新宿 8 分（京王線⇔新線のホームが離れている） */
  xferAt?: Record<string, number>;
  /**
   * 指定した改札とつながっていないホームの追加時間（分）。駅 id → { down?, up? }。
   * その方向の列車で着いた場合（改札まで遠回り）と、その方向の列車に乗る場合（改札からホームまで遠回り）にそれぞれ足す。
   * 例: 千歳烏山（北口＝上りホーム側）{ down: 3 }、柴崎（南口＝下りホーム側）{ up: 2 }
   */
  platformPenalty?: Record<string, { down?: number; up?: number }>;
  alphas?: number[];
}

export interface Result {
  order: number[];
  end: number;
}

export function createSolver(tt: Timetable, cfg: SolverConfig) {
const N = tt.stations.length;
const idx = new Map(tt.stations.map((s, i) => [s.id, i]));
const sid = (id: string) => {
  const i = idx.get(id);
  if (i === undefined) throw new Error(`unknown station ${id}`);
  return i;
};
const name = (i: number) => tt.stations[i].name;
const DWELL = cfg.dwellMin * 60;
const XFER = new Array(N).fill(cfg.xferMin * 60);
for (const [id, min] of Object.entries(cfg.xferAt ?? { shinjuku: 8 })) if (idx.has(id)) XFER[sid(id)] = min * 60;

// ---- 接続（隣り合う停車駅の間の 1 区間）。trip = 乗ったまま乗り通せる一続きの運行
const byId = new Map(tt.trains.map((t) => [t.id, t]));
const usable = (t: Timetable["trains"][number]) => cfg.allowReserved || !t.reservedSeat;
const tripOf = new Map<string, number>();
let nTrips = 0;
for (const t of tt.trains) {
  if (tripOf.has(t.id) || !usable(t)) continue;
  // prev をたどって先頭へ（使えない区間の手前で切る）
  let head = t;
  while (head.prev && byId.get(head.prev) && usable(byId.get(head.prev)!)) head = byId.get(head.prev)!;
  const trip = nTrips++;
  for (let cur: typeof t | undefined = head; cur && usable(cur); cur = cur.next ? byId.get(cur.next) : undefined) {
    tripOf.set(cur.id, trip);
  }
}
interface Conn { dep: number; arr: number; from: number; to: number; trip: number; train: string; up: boolean }
// 駅ごと・方向ごとの追加時間（秒）。[down, up]
const PEN: [number, number][] = Array.from({ length: N }, () => [0, 0]);
for (const [id, v] of Object.entries(cfg.platformPenalty ?? {})) PEN[sid(id)] = [(v.down ?? 0) * 60, (v.up ?? 0) * 60];
const pen = (st: number, up: boolean) => PEN[st][up ? 1 : 0];
const conns: Conn[] = [];
for (const t of tt.trains) {
  const trip = tripOf.get(t.id);
  if (trip === undefined) continue;
  const stops = t.stops.filter((s) => !s.pass);
  for (let k = 0; k + 1 < stops.length; k++) {
    const a = stops[k], b = stops[k + 1];
    const dep = a.dep ?? a.arr, arr = b.arr ?? b.dep;
    if (dep === undefined || arr === undefined) continue;
    conns.push({ dep, arr, from: sid(a.stationId), to: sid(b.stationId), trip, train: t.id, up: t.direction === "up" });
  }
}
conns.sort((x, y) => x.dep - y.dep || x.arr - y.arr);
const lowerBound = (t: number) => {
  let lo = 0, hi = conns.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    conns[m].dep < t ? lo = m + 1 : hi = m;
  }
  return lo;
};

// ---- Connection Scan: src を t0 に出発できるとき、各駅の改札に着ける最早時刻（arrival）。
// arrival は列車の到着にホームの追加時間を足したもの。src で乗る列車には乗る側の追加時間を課す
const WINDOW = 150 * 60;
const ready = new Float64Array(N), arrival = new Float64Array(N);
const arrConn = new Int32Array(N), readyConn = new Int32Array(N);
let tripStamp = new Int32Array(nTrips), stamp = 0;
let tripBoardConn = new Int32Array(nTrips);
function scan(src: number, t0: number) {
  ready.fill(Infinity);
  arrival.fill(Infinity);
  arrConn.fill(-1);
  readyConn.fill(-1);
  ready[src] = t0;
  stamp++;
  if (stamp === 2 ** 31 - 1) (tripStamp = new Int32Array(nTrips), stamp = 1);
  const end = t0 + WINDOW;
  for (let j = lowerBound(t0); j < conns.length; j++) {
    const c = conns[j];
    if (c.dep > end) break;
    const onTrip = tripStamp[c.trip] === stamp;
    if (!onTrip && ready[c.from] + (c.from === src ? pen(src, c.up) : 0) > c.dep) continue;
    if (!onTrip) (tripStamp[c.trip] = stamp, tripBoardConn[c.trip] = j);
    const gate = c.arr + pen(c.to, c.up);
    if (gate < arrival[c.to]) (arrival[c.to] = gate, arrConn[c.to] = j);
    const r = c.arr + XFER[c.to];
    if (r < ready[c.to]) (ready[c.to] = r, readyConn[c.to] = j);
  }
}

/** 直前の scan の結果から v までの乗車区間（列車ごと）を復元 */
interface Leg { from: number; dep: number; to: number; arr: number; train: string }
function legsTo(v: number, src: number): Leg[] {
  const legs: Leg[] = [];
  let j = arrConn[v];
  let to = v;
  while (j >= 0) {
    const c = conns[j];
    const b = conns[tripBoardConn[c.trip]];
    legs.push({ from: b.from, dep: b.dep, to, arr: conns[j].arr, train: b.train });
    if (b.from === src) break;
    to = b.from;
    j = readyConn[b.from];
  }
  return legs.reverse();
}

// ---- 残りの移動時間の見積もり（ビームの並べ替え用）
// 路線網を木とみなし（京王線 新宿–笹塚 を除くと木になる）、隣接駅間の最短所要を辺の重みにする。
// 現在駅と未訪問駅をすべて結ぶ部分木の重さ W、現在駅から最も遠い未訪問駅までの距離 D とすると、
// 全部を回る移動は少なくとも 2W − D かかる（待ち時間・滞在は含まない）。
const adj: [number, number][][] = Array.from({ length: N }, () => []);
{
  const minRun = new Map<string, number>();
  for (const c of conns) {
    const k = `${c.from}-${c.to}`;
    minRun.set(k, Math.min(minRun.get(k) ?? Infinity, c.arr - c.dep));
  }
  for (const r of tt.routes ?? [{ id: "line", stations: tt.stations.map((s) => ({ stationId: s.id })) }]) {
    for (let k = 0; k + 1 < r.stations.length; k++) {
      const a = sid(r.stations[k].stationId), b = sid(r.stations[k + 1].stationId);
      if (r.id === "keio" && name(a) === "新宿") continue; // 閉路を切る
      const w = Math.min(minRun.get(`${a}-${b}`) ?? Infinity, minRun.get(`${b}-${a}`) ?? Infinity);
      adj[a].push([b, w === Infinity ? 60 : w]);
      adj[b].push([a, w === Infinity ? 60 : w]);
    }
  }
}
const dist: Float64Array[] = Array.from({ length: N }, (_, s) => {
  const d = new Float64Array(N).fill(Infinity);
  d[s] = 0;
  const q = [s];
  while (q.length) {
    const u = q.pop()!;
    for (const [v, w] of adj[u]) if (d[v] === Infinity) (d[v] = d[u] + w, q.push(v));
  }
  return d;
});

// ---- ビームサーチ
const startSt = sid(cfg.start);
const excluded = new Set(cfg.exclude.map(sid));
const targets = tt.stations.map((_, i) => i).filter((i) => !excluded.has(i) && i !== startSt);
const T = targets.length;
// 訪問済み集合は 3 つの 26 bit 整数（a: 0〜25, b: 26〜51, c: 52〜77）で持つ（BigInt より速い）。最大 78 駅
const bitOf = new Int32Array(N).fill(-1);
targets.forEach((v, k) => (bitOf[v] = k));
if (T > 78) throw new Error(`too many target stations: ${T} (max 78)`);
const WORD = (k: number) => (k / 26) | 0;
const BIT = (k: number) => 1 << (k % 26);
const has = (a: number, b: number, c: number, k: number) => {
  const w = WORD(k);
  return ((w === 0 ? a : w === 1 ? b : c) & BIT(k)) !== 0;
};
const BEAM = cfg.beam;
const BRANCH = cfg.branch ?? 10;

// 木の辺（根 0 から見た子側の部分木に含まれる対象駅の集合）
const ROOT = 0;
const parent = new Int32Array(N).fill(-1), order: number[] = [];
{
  const seen = new Uint8Array(N);
  const st = [ROOT];
  seen[ROOT] = 1;
  while (st.length) {
    const u = st.pop()!;
    order.push(u);
    for (const [v] of adj[u]) if (!seen[v]) (seen[v] = 1, parent[v] = u, st.push(v));
  }
}
const subA = new Int32Array(N), subB = new Int32Array(N), subC = new Int32Array(N);
const inSub: Uint8Array[] = Array.from({ length: N }, () => new Uint8Array(N));
for (const u of [...order].reverse()) {
  const k = bitOf[u];
  if (k >= 0) [subA, subB, subC][WORD(k)][u] |= BIT(k);
  inSub[u][u] = 1;
  const p = parent[u];
  if (p >= 0) {
    subA[p] |= subA[u];
    subB[p] |= subB[u];
    subC[p] |= subC[u];
    for (let x = 0; x < N; x++) if (inSub[u][x]) inSub[p][x] = 1;
  }
}
const edgeW = new Float64Array(N);
for (let v = 0; v < N; v++) if (parent[v] >= 0) edgeW[v] = dist[v][parent[v]];
const fullWord = (w: number) => {
  const n = Math.max(0, Math.min(26, T - 26 * w));
  return n === 0 ? 0 : (1 << n) - 1;
};
const ALL_A = fullWord(0), ALL_B = fullWord(1), ALL_C = fullWord(2);

function remainingLB(cur: number, a: number, b: number, c: number): number {
  const uA = ALL_A & ~a, uB = ALL_B & ~b, uC = ALL_C & ~c; // 未訪問
  if (!uA && !uB && !uC) return 0;
  let W = 0;
  for (let v = 0; v < N; v++) {
    if (parent[v] < 0) continue;
    const inside = (uA & subA[v]) !== 0 || (uB & subB[v]) !== 0 || (uC & subC[v]) !== 0 || inSub[v][cur] === 1;
    const outside = (uA & ~subA[v]) !== 0 || (uB & ~subB[v]) !== 0 || (uC & ~subC[v]) !== 0 || inSub[v][cur] === 0;
    if (inside && outside) W += edgeW[v];
  }
  let D = 0;
  for (const v of targets) if (!has(a, b, c, bitOf[v]) && dist[cur][v] > D) D = dist[cur][v];
  return 2 * W - D;
}

interface State { at: number; a: number; b: number; c: number; ready: number; arrived: number; score: number; parent?: State }

/** ビームサーチ。alpha = 残り移動の見積もりの重み。訪問順（駅 index の配列）を返す */
function beam(t0: number, alpha: number): number[] | undefined {
  let layer: State[] = [{ at: startSt, a: 0, b: 0, c: 0, ready: t0, arrived: t0, score: 0 }];
  const cand: number[] = [];
  for (let step = 0; step < T; step++) {
    const next = new Map<string, State>();
    for (const s of layer) {
      scan(s.at, s.ready);
      cand.length = 0;
      for (const v of targets) if (!has(s.a, s.b, s.c, bitOf[v]) && arrival[v] !== Infinity) cand.push(v);
      cand.sort((x, y) => arrival[x] - arrival[y]);
      for (const v of cand.slice(0, BRANCH)) {
        const k = bitOf[v], w = WORD(k), bit = BIT(k);
        const a = w === 0 ? s.a | bit : s.a, b = w === 1 ? s.b | bit : s.b, c = w === 2 ? s.c | bit : s.c;
        const key = `${v}:${a}:${b}:${c}`;
        const old = next.get(key);
        const ready = arrival[v] + DWELL;
        if (old && old.ready <= ready) continue;
        next.set(key, { at: v, a, b, c, ready, arrived: arrival[v], score: 0, parent: s });
      }
    }
    layer = [...next.values()];
    for (const s of layer) s.score = s.ready + alpha * remainingLB(s.at, s.a, s.b, s.c);
    layer = layer.sort((x, y) => x.score - y.score).slice(0, BEAM);
    if (!layer.length) return undefined;
  }
  const best = layer.sort((x, y) => x.arrived - y.arrived)[0];
  const order: number[] = [];
  for (let s: State | undefined = best; s?.parent; s = s.parent) order.push(s.at);
  return order.reverse();
}

/** 訪問順どおりに回ったときの完了時刻（各駅へは最早到着、着いたら滞在して次へ） */
function evalOrder(order: number[], t0: number, limit = Infinity): number {
  let at = startSt, ready = t0, arr = t0;
  for (const v of order) {
    scan(at, ready);
    arr = arrival[v];
    if (arr === Infinity || arr >= limit) return Infinity;
    at = v;
    ready = arr + DWELL;
  }
  return arr;
}

/** 局所探索: 1〜3 駅の連続区間を別の位置へ移す / 区間を逆順にする。改善がなくなるまで */
function improve(order: number[], t0: number): { order: number[]; end: number } {
  let best = order.slice(), bestEnd = evalOrder(best, t0);
  for (let improved = true; improved;) {
    improved = false;
    // 区間の移動（or-opt）
    for (let len = 1; len <= 3 && !improved; len++) {
      for (let i = 0; i + len <= best.length && !improved; i++) {
        const seg = best.slice(i, i + len), rest = [...best.slice(0, i), ...best.slice(i + len)];
        for (let j = 0; j <= rest.length && !improved; j++) {
          if (j === i) continue;
          for (const s of [seg, [...seg].reverse()]) {
            const cand = [...rest.slice(0, j), ...s, ...rest.slice(j)];
            const end = evalOrder(cand, t0, bestEnd);
            if (end < bestEnd) (best = cand, bestEnd = end, improved = true);
            if (improved || len === 1) break;
          }
        }
      }
    }
    // 区間の反転（2-opt）
    for (let i = 0; i < best.length - 1 && !improved; i++) {
      for (let j = i + 2; j <= best.length && !improved; j++) {
        const cand = [...best.slice(0, i), ...best.slice(i, j).reverse(), ...best.slice(j)];
        const end = evalOrder(cand, t0, bestEnd);
        if (end < bestEnd) (best = cand, bestEnd = end, improved = true);
      }
    }
  }
  return { order: best, end: bestEnd };
}

const ALPHAS = cfg.alphas ?? [0.8, 1, 1.2, 1.5, 2];

/** 複数の重みでビームサーチ → それぞれ局所探索 → 最良 */
function solve(t0: number, seeds: number[][] = []): { order: number[]; end: number } | undefined {
  let best: { order: number[]; end: number } | undefined;
  const starts = [...seeds, ...ALPHAS.map((a) => beam(t0, a)).filter((o): o is number[] => !!o)];
  for (const o of starts) {
    const r = improve(o, t0);
    if (!best || r.end < best.end) best = r;
  }
  return best;
}

function describe(order: number[], t0: number) {
  const lines = [`${toHM(t0)} ${name(startSt)} 入場`];
  let rides = 0, legsN = 0, at = startSt, ready = t0;
  const out: { from: string; to: string; dep: number; arr: number; train: string; visit?: number }[] = [];
  order.forEach((v, k) => {
    scan(at, ready);
    const legs = legsTo(v, at);
    legs.forEach((l, i) => {
      const t = byId.get(l.train)!;
      rides += l.arr - l.dep;
      legsN++;
      out.push({
        from: tt.stations[l.from].id, to: tt.stations[l.to].id, dep: l.dep, arr: l.arr, train: l.train,
        ...(i === legs.length - 1 ? { visit: k + 1 } : {}),
      });
      const end = i === legs.length - 1 ? `  → 出場（${k + 1}駅目）` : "  （乗換）";
      lines.push(
        `  ${toHM(l.dep)} ${name(l.from)} → ${toHM(l.arr)} ${name(l.to)}  [${t.direction === "down" ? "下り" : "上り"} ${t.trainType} ${t.number}]${end}`,
      );
    });
    at = v;
    ready = arrival[v] + DWELL;
  });
  return { lines, rides, legsN, legs: out };
}

  return { tt, N, T, name, sid, startSt, excluded, targets, BEAM, ALPHAS, beam, evalOrder, improve, solve, describe };
}

export type Solver = ReturnType<typeof createSolver>;
