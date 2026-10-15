// Suicaのペンギン デジタルスタンプラリー: 全スポットを回る最短の順番を時刻表から求める。
//   deno run --allow-read --allow-write tools/rally_jreast.ts [--data data/jreast/suica_penguin_net_holiday.json]
//     [--start 05:00-09:00/10] [--skip 仙台,新潟] [--json out/rally.json]
// 方針:
//   - 駅間の移動は Connection Scan（特急・ライナーは使わない。新幹線は仙台・新潟へ行き来するときだけ使う）
//   - 回る順番は Held-Karp（タスク数 n ≤ 20 程度なら厳密）。状態 = (回ったタスクの集合, 最後のタスク) → 最も早くホームに戻れる時刻
//   - 各タスク: 駅に着いてから walk 分でタグ、1 分でタッチ、walk 分でホームに戻る。タッチは対応時間内（開く前なら待つ）
import { parseArgs } from "@std/cli/parse-args";

interface Stop { station: string; name: string; arr?: number; dep?: number; pass?: boolean }
interface Col { id: string; page: string; trainType: string; number: string; name?: string; days: string; stops: Stop[] }

const args = parseArgs(Deno.args, {
  string: ["data", "start", "skip", "json", "xfer"],
  boolean: ["start-far"],
  default: { data: "data/jreast/suica_penguin_net_holiday.json", start: "05:00-09:00/10", skip: "" },
});

// ---- タスク（土休日） ----
interface Task { name: string; station: string; walk: number; open: number; close: number; stamps: number; note: string }
const H = (s: string) => { const [h, m] = s.split(":").map(Number); return h * 60 + m; };
const ALL = [H("04:00"), H("25:30")];
const TASKS: Task[] = [
  { name: "東京", station: "東京", walk: 3, open: ALL[0], close: ALL[1], stamps: 1, note: "丸の内南口改札外" },
  { name: "秋葉原", station: "秋葉原", walk: 2, open: ALL[0], close: ALL[1], stamps: 1, note: "中央改札外" },
  { name: "池袋", station: "池袋", walk: 2, open: ALL[0], close: H("24:00"), stamps: 1, note: "南改札外" },
  { name: "高田馬場", station: "高田馬場", walk: 2, open: ALL[0], close: ALL[1], stamps: 1, note: "早稲田口改札外" },
  { name: "新宿＋ペンスタ新宿", station: "新宿", walk: 4, open: ALL[0], close: H("23:50"), stamps: 2, note: "東改札外 地下みどりの窓口（南口みどりの窓口は 6:00-22:00）" },
  { name: "渋谷", station: "渋谷", walk: 3, open: ALL[0], close: ALL[1], stamps: 1, note: "南改札外" },
  { name: "大崎", station: "大崎", walk: 2, open: ALL[0], close: ALL[1], stamps: 1, note: "北改札口外" },
  { name: "新橋", station: "新橋", walk: 2, open: ALL[0], close: ALL[1], stamps: 1, note: "南改札外" },
  { name: "ウォーターズ竹芝", station: "浜松町", walk: 11, open: H("10:00"), close: H("22:00"), stamps: 1, note: "北口から徒歩10分＋改札" },
  { name: "NEWoMan高輪", station: "高輪ゲートウェイ", walk: 3, open: H("10:00"), close: H("19:00"), stamps: 1, note: "NORTH 1F POSTUDIO" },
  { name: "大井町TRACKS", station: "大井町", walk: 5, open: H("05:30"), close: H("24:30"), stamps: 1, note: "1F 北ロータリー（トラックス口から）" },
  { name: "ペンスタ上野", station: "上野", walk: 3, open: ALL[0], close: ALL[1], stamps: 1, note: "6:30-21:00 は改札内3F ペンスタ、それ以外は中央改札外" },
  { name: "ペンスタ大宮", station: "大宮", walk: 3, open: ALL[0], close: ALL[1], stamps: 1, note: "10:00-22:00 は改札内 ペンスタ、それ以外はみどりの窓口前" },
  { name: "ペンスタ桜木町", station: "桜木町", walk: 1, open: ALL[0], close: ALL[1], stamps: 1, note: "南改札外横のスタンプ台" },
  { name: "ホテルメトロポリタン", station: "池袋", walk: 6, open: H("11:00"), close: H("20:00"), stamps: 1, note: "メトロポリタン口から徒歩5分" },
  { name: "アトレ吉祥寺", station: "吉祥寺", walk: 2, open: H("10:00"), close: H("21:00"), stamps: 1, note: "本館1F インフォメーション" },
  { name: "ルミネ町田", station: "町田", walk: 3, open: H("10:30"), close: H("20:30"), stamps: 1, note: "1F ルミネサービスカウンター" },
  { name: "仙台", station: "仙台", walk: 2, open: ALL[0], close: ALL[1], stamps: 1, note: "新幹線中央改札内の駅スタンプ台（改札を出ない）" },
  { name: "新潟", station: "新潟", walk: 3, open: ALL[0], close: ALL[1], stamps: 1, note: "東側みどりの窓口前（新幹線東改札を出てすぐ）" },
];
const skip = new Set(String(args.skip).split(",").filter(Boolean));
const tasks = TASKS.filter((t) => !skip.has(t.name));
const n = tasks.length;
const SK_ST = new Set(["仙台", "新潟"]);

// ---- 乗換時間（分）。新幹線⇔在来線はさらに +SK_XFER ----
const XFER_DEFAULT = 3;
const XFER: Record<string, number> = { 東京: 5, 新宿: 5, 上野: 4, 大宮: 4, 横浜: 4, 品川: 4, 池袋: 4, 渋谷: 4 };
const SK_XFER = 5;

// ---- 時刻表 → 接続 ----
const data = JSON.parse(await Deno.readTextFile(String(args.data)));
const cols: Col[] = data.trains;
const key = (s: Stop) => s.name; // 駅名で一意（JR の駅のみを扱う）
const names: string[] = [];
const idx = new Map<string, number>();
const sid = (nm: string) => {
  let i = idx.get(nm);
  if (i === undefined) idx.set(nm, i = names.push(nm) - 1);
  return i;
};
interface Conn { from: number; to: number; dep: number; arr: number; trip: number; sk: boolean; col: number }
const conns: Conn[] = [];
const tripOf = new Map<string, number>();
let skipped = 0;
cols.forEach((c, ci) => {
  if (/平日/.test(c.days) || /特急|ライナー/.test(c.trainType + (c.name ?? ""))) { skipped++; return; }
  const sk = c.trainType === "新幹線";
  let trip = tripOf.get(c.page);
  if (trip === undefined) tripOf.set(c.page, trip = tripOf.size);
  const st = c.stops.filter((s) => !s.pass && (s.arr !== undefined || s.dep !== undefined));
  for (let i = 0; i + 1 < st.length; i++) {
    const a = st[i], b = st[i + 1];
    const dep = a.dep ?? a.arr!, arr = b.arr ?? b.dep!;
    if (arr < dep) continue;
    conns.push({ from: sid(key(a)), to: sid(key(b)), dep: dep / 60, arr: arr / 60, trip, sk, col: ci });
  }
});
conns.sort((x, y) => x.dep - y.dep || x.arr - y.arr);
const onTrip = new Int32Array(tripOf.size);
const isSkSt = names.map((nm) => SK_ST.has(nm));
const xferOf = names.map((nm) => XFER[nm] ?? XFER_DEFAULT);
console.error(`接続 ${conns.length}（除外した列車 ${skipped}）、駅 ${names.length}`);
for (const t of tasks) if (!idx.has(t.station)) throw new Error(`時刻表に駅がない: ${t.station}`);

// ---- Connection Scan（最早到着）。allowSk: 新幹線を使うか ----
const N = names.length;
const firstDepIdx = (t: number) => { let lo = 0, hi = conns.length; while (lo < hi) { const m = (lo + hi) >> 1; if (conns[m].dep < t) lo = m + 1; else hi = m; } return lo; };
interface Scan { arr: Float64Array; via: Int32Array; mode: Int8Array }
let stamp = 0;
function scan(src: number, t0: number, allowSk: boolean, targets?: number[]): Scan {
  const arr = new Float64Array(N).fill(Infinity);
  const via = new Int32Array(N).fill(-1); // 到着に使った接続
  const mode = new Int8Array(N); // 到着した列車が新幹線か
  stamp++; // onTrip[trip] === stamp ならその列車に乗っている
  arr[src] = t0 - xferOf[src] - SK_XFER; // 最初の乗車は t0 以降ならよい（乗換時間を引いておく）
  for (let k = firstDepIdx(t0); k < conns.length; k++) {
    const c = conns[k];
    if (c.sk && !allowSk) continue;
    if (targets) {
      let best = -Infinity;
      for (const d of targets) best = Math.max(best, arr[d]);
      if (c.dep > best) break; // すべての目的駅に、これより早く着いている
    }
    if (onTrip[c.trip] !== stamp) {
      const a = arr[c.from];
      if (a === Infinity) continue;
      const need = c.from === src && via[src] < 0 ? t0 + (c.sk && !isSkSt[src] ? SK_XFER : 0) // スタンプ後、在来線ホームから新幹線ホームへ
        : a + (via[c.from] >= 0 && conns[via[c.from]].trip === c.trip ? 0 : xferOf[c.from] + (mode[c.from] !== (c.sk ? 1 : 0) ? SK_XFER : 0));
      if (c.dep < need) continue;
      onTrip[c.trip] = stamp;
    }
    if (c.arr < arr[c.to]) { arr[c.to] = c.arr; via[c.to] = k; mode[c.to] = c.sk ? 1 : 0; }
  }
  return { arr, via, mode };
}

// ---- 移動時間表 travel[src][variant](t) → 各タスク駅への到着（分単位の表） ----
const T0 = H("04:00"), T1 = H("26:00");
const taskSt = tasks.map((t) => idx.get(t.station)!);
const stList = [...new Set(taskSt)];
const table = new Map<string, Float32Array>(); // `${src}:${sk}` → [(t-T0)*stList.length + j]
function arrTable(src: number, sk: boolean): Float32Array {
  const k = `${src}:${sk}`;
  let tb = table.get(k);
  if (tb) return tb;
  tb = new Float32Array((T1 - T0 + 1) * stList.length).fill(Infinity);
  for (let t = T0; t <= T1; t++) {
    const r = scan(src, t, sk, stList);
    for (let j = 0; j < stList.length; j++) tb[(t - T0) * stList.length + j] = r.arr[stList[j]];
  }
  table.set(k, tb);
  return tb;
}
const stPos = new Map(stList.map((s, j) => [s, j]));
const S = stList.length;
function travel(a: number, b: number, t: number): number {
  if (a === b) return t;
  const sk = isSkSt[a] || isSkSt[b];
  const tt = Math.ceil(t);
  if (tt > T1) return Infinity;
  return arrTable(a, sk)[(Math.max(tt, T0) - T0) * S + stPos.get(b)!];
}
const tm0 = performance.now();
for (const s of stList) { arrTable(s, false); if (isSkSt[s]) continue; if (stList.some((x) => isSkSt[x])) arrTable(s, true); }
for (const s of stList) if (isSkSt[s]) arrTable(s, true);
console.error(`移動時間表 ${table.size} 本（${((performance.now() - tm0) / 1000).toFixed(1)} 秒）`);

// ---- Held-Karp ----
const FULL = (1 << n) - 1;
function visit(i: number, arrive: number): { touch: number; ready: number } | null {
  const t = tasks[i];
  const touch = Math.max(arrive + t.walk, t.open);
  if (touch > t.close) return null;
  return { touch, ready: touch + 1 + t.walk };
}
function solve(start: number) {
  const best = new Float32Array((FULL + 1) * n).fill(Infinity);
  const par = new Int8Array((FULL + 1) * n).fill(-1);
  for (let i = 0; i < n; i++) {
    if (isSkSt[taskSt[i]] && !args["start-far"]) continue; // 仙台・新潟から始めない（首都圏から出発）
    const v = visit(i, start);
    if (v) best[(1 << i) * n + i] = v.ready;
  }
  for (let m = 1; m <= FULL; m++) {
    for (let i = 0; i < n; i++) {
      if (!(m & (1 << i))) continue;
      const r = best[m * n + i];
      if (r === Infinity) continue;
      for (let j = 0; j < n; j++) {
        if (m & (1 << j)) continue;
        const v = visit(j, travel(taskSt[i], taskSt[j], r));
        if (!v) continue;
        const mm = m | (1 << j);
        if (v.ready < best[mm * n + j]) { best[mm * n + j] = v.ready; par[mm * n + j] = i; }
      }
    }
  }
  // 完了 = 最後のタッチ時刻（ready - 1 - walk）
  let bi = -1, bf = Infinity;
  for (let i = 0; i < n; i++) {
    const f = best[FULL * n + i] - 1 - tasks[i].walk;
    if (f < bf) { bf = f; bi = i; }
  }
  if (bi < 0) return null;
  const order: number[] = [];
  for (let m = FULL, i = bi; i >= 0;) { order.unshift(i); const p = par[m * n + i]; m &= ~(1 << i); i = p; }
  return { finish: bf, order };
}

// ---- 行程 ----
const fmt = (t: number) => `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(Math.round(t % 60)).padStart(2, "0")}`;
function legs(a: number, b: number, t: number) {
  const r = scan(a, t, isSkSt[a] || isSkSt[b], [b]);
  const out: { from: string; to: string; dep: number; arr: number; train: string }[] = [];
  let s = b;
  while (s !== a && r.via[s] >= 0) {
    const c = conns[r.via[s]];
    const col = cols[c.col];
    const label = `${col.name ? col.name + " " : ""}${col.trainType} ${col.number}`.trim();
    const last = out[0];
    if (last && last.train === label && last.from === names[c.to]) { last.from = names[c.from]; last.dep = c.dep; }
    else out.unshift({ from: names[c.from], to: names[c.to], dep: c.dep, arr: c.arr, train: label });
    s = c.from;
  }
  return out;
}
function describe(start: number, order: number[]) {
  const lines: string[] = [];
  let r = start, prev = -1;
  const rows: unknown[] = [];
  for (const i of order) {
    const st = taskSt[i];
    let arrive = r;
    if (prev >= 0 && st !== taskSt[prev]) {
      for (const l of legs(taskSt[prev], st, r)) {
        lines.push(`  ${fmt(l.dep)} ${l.from} → ${fmt(l.arr)} ${l.to}  [${l.train}]`);
        rows.push({ type: "ride", ...l });
      }
      arrive = travel(taskSt[prev], st, r);
    }
    const v = visit(i, arrive)!;
    const wait = v.touch - (arrive + tasks[i].walk);
    lines.push(`★ ${fmt(v.touch)} ${tasks[i].name}（${tasks[i].note}）${wait > 0 ? ` ※開くまで ${Math.round(wait)} 分待ち` : ""}`);
    rows.push({ type: "stamp", task: tasks[i].name, station: tasks[i].station, touch: v.touch, wait });
    r = v.ready; prev = i;
  }
  return { lines, rows };
}

const [s0, rest] = String(args.start).split("-");
const [s1, step] = (rest ?? s0).split("/");
let bestAll: { start: number; finish: number; order: number[] } | null = null;
const t1 = performance.now();
for (let s = H(s0); s <= H(s1); s += Number(step ?? 10)) {
  const r = solve(s);
  console.error(`開始 ${fmt(s)} → ${r ? `完了 ${fmt(r.finish)}（${((r.finish - s) / 60).toFixed(1)} 時間）` : "回れない"}`);
  if (r && (!bestAll || r.finish - s < bestAll.finish - bestAll.start || (r.finish - s === bestAll.finish - bestAll.start && r.finish < bestAll.finish))) bestAll = { start: s, ...r };
}
console.error(`探索 ${((performance.now() - t1) / 1000).toFixed(1)} 秒`);
if (!bestAll) { console.log("この条件では回れません"); Deno.exit(0); }
const d = describe(bestAll.start, bestAll.order);
console.log(`タスク ${n}（スタンプ ${tasks.reduce((a, t) => a + t.stamps, 0)} 個）／ 最初の駅に ${fmt(bestAll.start)} 着 → 完了 ${fmt(bestAll.finish)}（所要 ${((bestAll.finish - bestAll.start) / 60).toFixed(2)} 時間）`);
console.log(d.lines.join("\n"));
if (args.json) await Deno.writeTextFile(String(args.json), JSON.stringify({ start: bestAll.start, finish: bestAll.finish, tasks, order: bestAll.order.map((i) => tasks[i].name), rows: d.rows }, null, 1));
