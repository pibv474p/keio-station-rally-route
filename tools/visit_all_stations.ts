// 井の頭線（土休日）で、指定駅すべてで改札を出る最短行程を探索する。
// deno run --allow-read tools/visit_all_stations.ts one <開始秒> <滞在秒> | sweep | baseline | best
// 状態 = (現在駅, 訪問済み集合)、Dijkstra で最早時刻。乗換のみ 1 分、出場駅では滞在時間を加算。
const tt = JSON.parse(Deno.readTextFileSync(new URL("../data/keio_inokashira_holiday.json", import.meta.url)));
const st = tt.stations; const idx = new Map(st.map((s, i) => [s.id, i])); const N = st.length;
const hm = (s) => `${String(Math.floor(s / 3600)).padStart(2, "0")}:${String(Math.floor(s / 60) % 60).padStart(2, "0")}`;
const SKIP = new Set(["shibuya", "shinsen"]);
const targets = st.map((s, i) => SKIP.has(s.id) ? -1 : i).filter((i) => i >= 0);
const bit = new Map(targets.map((i, k) => [i, k])); const FULL = (1 << targets.length) - 1;
// 各駅の発車イベント: [dep, trainIdx, stopIdx] 時刻順
const trains = tt.trains.map((t) => t.stops.map((s) => ({ i: idx.get(s.stationId), arr: s.arr ?? s.dep, dep: s.dep, pass: s.pass })));
const deps = Array.from({ length: N }, () => []);
trains.forEach((stops, ti) => stops.forEach((s, k) => { if (!s.pass && s.dep != null && k < stops.length - 1) deps[s.i].push([s.dep, ti, k]); }));
deps.forEach((d) => d.sort((a, b) => a[0] - b[0]));
const lb = (arr, t) => { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; arr[m][0] < t ? lo = m + 1 : hi = m; } return lo; };
class Heap { a = []; push(x) { const a = this.a; a.push(x); let i = a.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (a[p][0] <= a[i][0]) break; [a[p], a[i]] = [a[i], a[p]]; i = p; } }
  pop() { const a = this.a, top = a[0], last = a.pop(); if (a.length) { a[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < a.length && a[l][0] < a[m][0]) m = l; if (r < a.length && a[r][0] < a[m][0]) m = r; if (m === i) break; [a[m], a[i]] = [a[i], a[m]]; i = m; } } return top; } get size() { return this.a.length; } }
const HORIZON = 25 * 60, XFER = 60;
function solve(start, dwell, startSt = idx.get("meidaimae")) {
  const best = new Map(); const prev = new Map(); const key = (i, m) => m * N + i;
  const m0 = 1 << bit.get(startSt); const h = new Heap(); h.push([start, startSt, m0]); best.set(key(startSt, m0), start);
  while (h.size) {
    const [t, u, m] = h.pop(); if (best.get(key(u, m)) !== t) continue;
    if (m === FULL) { const path = []; let k = key(u, m); while (prev.has(k)) { const p = prev.get(k); path.push(p); k = p.from; } return { end: t - dwell, path: path.reverse() }; }
    const d = deps[u];
    for (let j = lb(d, t); j < d.length && d[j][0] <= t + HORIZON; j++) {
      const [dep, ti, k0] = d[j]; const stops = trains[ti];
      for (let k = k0 + 1; k < stops.length; k++) {
        const s = stops[k]; if (s.pass) continue; const v = s.i;
        const b = bit.get(v); const opts = [];
        if (b !== undefined && !(m & (1 << b))) { const nm = m | (1 << b); opts.push([s.arr + (nm === FULL ? dwell : dwell), nm, true]); }
        opts.push([s.arr + XFER, m, false]);
        for (const [nt, nm, exit] of opts) { const kk = key(v, nm); if (!best.has(kk) || nt < best.get(kk)) { best.set(kk, nt); prev.set(kk, { from: key(u, m), u, v, dep, arr: s.arr, ti, exit }); h.push([nt, v, nm]); } }
      }
    }
  }
}
const name = (i) => st[i].name;
const show = (r, start) => { console.log(`  ${hm(start)} 明大前 入場`); for (const p of r.path) { const t = tt.trains[p.ti]; console.log(`  ${hm(p.dep)} ${name(p.u)}発 → ${hm(p.arr)} ${name(p.v)}着  [${t.direction === "down" ? "吉祥寺方面" : "渋谷方面"} ${t.trainType} ${t.number}]  ${p.exit ? "出場" : "乗換のみ"}`); } };
const mode = Deno.args[0];
if (mode === "sweep") {
  for (const dwell of [5 * 60, 4 * 60, 3 * 60]) { const res = []; for (let s = 10 * 3600; s < 11 * 3600; s += 60) res.push(solve(s, dwell).end - s);
    const avg = res.reduce((a, b) => a + b) / res.length; console.log(`滞在${dwell / 60}分: 平均${(avg / 60).toFixed(1)}分 最短${Math.min(...res) / 60} 最長${Math.max(...res) / 60}`); }
} else if (mode === "one") { const s = Number(Deno.args[1] ?? 36000), dwell = Number(Deno.args[2] ?? 300); const t0 = performance.now(); const r = solve(s, dwell); console.log(`所要 ${(r.end - s) / 60}分 (計算${(performance.now() - t0).toFixed(0)}ms)`); show(r, s); }
if (mode === "baseline") {
  // 順番固定: 明大前→東松原→新代田→下北沢→池ノ上→駒場東大前 → (乗車) → 永福町→…→吉祥寺。各区間は1本の列車で最早到着
  const order = ["meidaimae","higashimatsubara","shindaita","shimokitazawa","ikenoue","komabatodaimae","eifukucho","nishieifuku","hamadayama","takaido","fujimigaoka","kugayama","mitakadai","inokashirakoen","kichijoji"].map((x) => idx.get(x));
  const run = (start) => { let t = start; for (let a = 0; a < order.length - 1; a++) { let bestArr = Infinity; for (const stops of trains) { const p = stops.findIndex((s) => s.i === order[a]), q = stops.findIndex((s) => s.i === order[a + 1]); if (p < 0 || q <= p || stops[p].pass || stops[q].pass || stops[p].dep < t) continue; bestArr = Math.min(bestArr, stops[q].arr); } t = bestArr + (a + 1 < order.length - 1 ? 300 : 0); } return t - start; };
  const res = []; for (let s = 36000; s < 39600; s += 60) res.push(run(s)); console.log(`順番固定(滞在5分): 平均${(res.reduce((a,b)=>a+b)/res.length/60).toFixed(1)}分 最短${Math.min(...res)/60} 最長${Math.max(...res)/60}`);
}
if (mode === "best") { let b = null; for (let s = 36000; s < 39600; s += 60) { const r = solve(s, 300); if (!b || r.end - s < b.d) b = { s, d: r.end - s, r }; } console.log(`最短 ${b.d / 60}分 (入場 ${hm(b.s)})`); show(b.r, b.s); }
