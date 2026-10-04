// 全駅訪問の行程（visit_network.ts --json の出力）を路線網のダイヤグラム上に描いた HTML を作る。
//
// deno run --allow-read --allow-write tools/render_itinerary.ts out/keio_network_visit_all_0845.json [out.html]
//
// - 線区ごとのパネルを縦に並べ、横軸は共通の時刻。背景に全列車（種別色）、行程を太線で重ねる
// - 隣り合う停車駅の組は、両駅を含む線区のうち駅の並びで一番近い線区に描く
//   （例: 新宿→笹塚 の直通は京王線、新宿→初台 は京王新線）
// - 横線 = 駅にいる時間（改札の出入り・ホームでの待ち）。番号付きの丸 = 改札を出た駅（訪問順）

import type { Route, Timetable, Train } from "../src/model.ts";
import { toHM } from "../src/time.ts";

// --artifact: claude.ai Artifact 用（doctype/html/head/body なしの本文だけ。公開時に外枠が付く）
const ARTIFACT = Deno.args.includes("--artifact");
const titleArg = Deno.args.find((a) => a.startsWith("--title="))?.slice(8);
const [itPath, outArg] = Deno.args.filter((a) => !a.startsWith("--"));
if (!itPath) throw new Error("usage: render_itinerary.ts <itinerary.json> [out.html]");
const outPath = outArg ?? itPath.replace(/\.json$/, ".html");

interface Leg { from: string; to: string; dep: number; arr: number; train: string; visit?: number }
interface Itinerary {
  data: string; start: string; excluded: string[]; dwellMin: number; xferMin: number; xferAt?: Record<string, number>; platformPenalty?: Record<string, { down?: number; up?: number }>;
  t0: number; end: number; order: string[]; legs: Leg[];
}
const it = JSON.parse(await Deno.readTextFile(itPath)) as Itinerary;
const tt = JSON.parse(await Deno.readTextFile(it.data)) as Timetable;
const routes: Route[] = tt.routes ?? [{ id: "line", name: tt.line.name, stations: tt.stations.map((s) => ({ stationId: s.id, km: s.km })) }];
const stName = new Map(tt.stations.map((s) => [s.id, s.name.replace(/（.*）$/, "")]));
const byId = new Map(tt.trains.map((t) => [t.id, t]));

// ---- レイアウト
const PANEL_ORDER = ["inokashira", "keio_new", "keio", "sagamihara", "takao", "keibajo", "dobutsuen"];
routes.sort((a, b) => (PANEL_ORDER.indexOf(a.id) + 99) % 99 - (PANEL_ORDER.indexOf(b.id) + 99) % 99);
const LABEL_W = 132;
// 図の縦横比（既定は A4 横 = 297:210）。--aspect=1.414 のように変えられる
const ASPECT = Number(Deno.args.find((a) => a.startsWith("--aspect="))?.slice(9) ?? 297 / 210);
const T_START = Math.floor((it.t0 - 15 * 60) / 1800) * 1800;
const T_END = Math.ceil((it.end + 15 * 60) / 1800) * 1800;
const MINUTES = (T_END - T_START) / 60;
let PX_MIN = 3.2;

interface Panel { route: Route; top: number; height: number; y: Map<string, number>; idx: Map<string, number> }

/** 縦方向の間隔を倍率 k で詰めたレイアウト（駅名が重ならないよう駅間は 11px 以上） */
function layout(k: number): { panels: Panel[]; H: number } {
  const pxKm = 15 * k, minGap = Math.max(11, 17 * k), pad = Math.max(16, 26 * k), gap = Math.max(8, 18 * k);
  const out: Panel[] = [];
  let cursor = 0;
  for (const r of routes) {
    const y = new Map<string, number>(), idx = new Map<string, number>();
    let cy = pad;
    r.stations.forEach((s, i) => {
      if (i > 0) cy += Math.max((s.km - r.stations[i - 1].km) * pxKm, minGap);
      y.set(s.stationId, cy);
      idx.set(s.stationId, i);
    });
    const height = cy + pad / 2;
    out.push({ route: r, top: cursor, height, y, idx });
    cursor += height + gap;
  }
  return { panels: out, H: cursor - gap };
}

// 横幅に合わせて縦を詰め、それでも縦長なら時刻軸を伸ばして ASPECT に合わせる
let best = layout(1);
for (let k = 3; k >= 0.2; k -= 0.01) {
  const l = layout(k);
  best = l;
  if (LABEL_W + MINUTES * PX_MIN >= ASPECT * l.H) break;
}
if (LABEL_W + MINUTES * PX_MIN < ASPECT * best.H) PX_MIN = (ASPECT * best.H - LABEL_W) / MINUTES;
else best.H = (LABEL_W + MINUTES * PX_MIN) / ASPECT; // 下に余白を足して比率をそろえる
const panels = best.panels;
const H = best.H;
const W = MINUTES * PX_MIN;
const x = (sec: number) => ((sec - T_START) / 60) * PX_MIN;

/** 停車駅の組 (a, b) を描く線区（両駅を含み、並びの差が最小のもの） */
function panelsFor(a: string, b: string): Panel[] {
  let best = Infinity;
  const hits: [Panel, number][] = [];
  for (const p of panels) {
    const ia = p.idx.get(a), ib = p.idx.get(b);
    if (ia === undefined || ib === undefined) continue;
    const d = Math.abs(ia - ib);
    hits.push([p, d]);
    best = Math.min(best, d);
  }
  return hits.filter(([, d]) => d === best).map(([p]) => p);
}
const panelsWith = (s: string) => panels.filter((p) => p.y.has(s));
const Y = (p: Panel, s: string) => p.top + p.y.get(s)!;
const f1 = (n: number) => n.toFixed(1);
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

// ---- 背景: 全列車
const TYPE_ORDER = ["各駅停車", "区間急行", "快速", "急行", "特急", "京王ライナー", "Mt.TAKAO号"];
const bg: string[] = [];
for (const t of tt.trains) {
  const stops = t.stops.filter((s) => !s.pass);
  const segs = new Map<Panel, string[]>();
  for (let k = 0; k + 1 < stops.length; k++) {
    const a = stops[k], b = stops[k + 1];
    const dep = a.dep ?? a.arr!, arr = b.arr ?? b.dep!;
    if (arr < T_START || dep > T_END) continue;
    for (const p of panelsFor(a.stationId, b.stationId)) {
      const d = `M${f1(x(dep))} ${f1(Y(p, a.stationId))}L${f1(x(arr))} ${f1(Y(p, b.stationId))}`;
      (segs.get(p) ?? segs.set(p, []).get(p)!).push(d);
    }
  }
  if (!segs.size) continue;
  const cls = `t${Math.max(0, TYPE_ORDER.indexOf(t.trainType ?? ""))}${t.reservedSeat ? " rs" : ""}`;
  const d = [...segs.values()].flat().join("");
  bg.push(`<path class="${cls}" d="${d}"><title>${esc(`${t.trainType} ${t.number}`)}</title></path>`);
}

// ---- 行程
/** leg の乗車区間の停車点（乗ったまま続く next もたどる） */
function legPoints(l: Leg): { s: string; t: number }[] {
  const pts: { s: string; t: number }[] = [];
  let tr: Train | undefined = byId.get(l.train);
  let started = false;
  while (tr) {
    for (const st of tr.stops) {
      if (st.pass) continue;
      if (!started && st.stationId === l.from && (st.dep ?? -1) === l.dep) started = true;
      if (!started) continue;
      const tm = pts.length === 0 ? st.dep! : (st.arr ?? st.dep!);
      if (pts.at(-1)?.s !== st.stationId) pts.push({ s: st.stationId, t: tm });
      if (st.stationId === l.to && (st.arr ?? st.dep) === l.arr) return pts;
    }
    tr = tr.next ? byId.get(tr.next) : undefined;
  }
  throw new Error(`leg not found on train: ${JSON.stringify(l)}`);
}

const ride: string[] = [], stay: string[] = [], marks: string[] = [];
let prevArr = it.t0, prevSt = it.start, prevVisit: number | undefined;
const rows: string[] = [];
it.legs.forEach((l, i) => {
  const t = byId.get(l.train)!;
  const label = `${toHM(l.dep)} ${stName.get(l.from)} → ${toHM(l.arr)} ${stName.get(l.to)}　${t.trainType} ${t.number}`;
  // 駅にいた時間（前の到着 → この出発）
  for (const p of panelsWith(prevSt)) {
    stay.push(
      `<path class="${prevVisit ? "dwell" : "wait"}" d="M${f1(x(prevArr))} ${f1(Y(p, prevSt))}H${f1(x(l.dep))}"><title>${esc(`${stName.get(prevSt)} ${toHM(prevArr)}〜${toHM(l.dep)}（${Math.round((l.dep - prevArr) / 60)}分）`)}</title></path>`,
    );
  }
  const pts = legPoints(l);
  const ds: string[] = [];
  for (let k = 0; k + 1 < pts.length; k++) {
    for (const p of panelsFor(pts[k].s, pts[k + 1].s)) {
      ds.push(`M${f1(x(pts[k].t))} ${f1(Y(p, pts[k].s))}L${f1(x(pts[k + 1].t))} ${f1(Y(p, pts[k + 1].s))}`);
    }
  }
  ride.push(`<g class="leg"><path class="halo" d="${ds.join("")}"/><path class="ride" d="${ds.join("")}"><title>${esc(label)}</title></path></g>`);
  for (const p of panelsWith(l.to)) {
    const cx = f1(x(l.arr)), cy = f1(Y(p, l.to));
    if (l.visit) {
      marks.push(
        `<g class="visit"><circle cx="${cx}" cy="${cy}" r="7.5"/><text x="${cx}" y="${cy}">${l.visit}</text><title>${esc(`${l.visit}駅目 ${stName.get(l.to)} 着 ${toHM(l.arr)}`)}</title></g>`,
      );
    } else {
      marks.push(`<circle class="xfer" cx="${cx}" cy="${cy}" r="3.5"><title>${esc(`乗換 ${stName.get(l.to)} ${toHM(l.arr)}`)}</title></circle>`);
    }
  }
  rows.push(
    `<tr${l.visit ? "" : ' class="x"'}><td>${i + 1}</td><td>${toHM(l.dep)}</td><td>${esc(stName.get(l.from)!)}</td><td>${toHM(l.arr)}</td><td>${esc(stName.get(l.to)!)}</td><td><span class="sw t${Math.max(0, TYPE_ORDER.indexOf(t.trainType ?? ""))}"></span>${esc(`${t.trainType} ${t.number}`)}</td><td>${l.visit ? `<b>${l.visit}駅目</b>` : "乗換"}</td></tr>`,
  );
  prevArr = l.arr;
  prevSt = l.to;
  prevVisit = l.visit;
});
// 入場
for (const p of panelsWith(it.start)) {
  marks.push(`<g class="start"><circle cx="${f1(x(it.t0))}" cy="${f1(Y(p, it.start))}" r="6"/><title>${esc(`${toHM(it.t0)} ${stName.get(it.start)} 入場`)}</title></g>`);
}

// ---- グリッド・駅名
const grid: string[] = [], hours: string[] = [], labels: string[] = [];
for (let t = T_START; t <= T_END; t += 600) {
  grid.push(`<path class="${t % 3600 === 0 ? "gh" : t % 1800 === 0 ? "g30" : "g10"}" d="M${f1(x(t))} 0V${H}"/>`);
}
const visited = new Set(it.order), excluded = new Set(it.excluded);
for (const p of panels) {
  grid.push(`<rect class="panel" x="0" y="${p.top}" width="${f1(W)}" height="${p.height}"/>`);
  for (let t = Math.ceil(T_START / 3600) * 3600; t <= T_END; t += 3600) {
    if (t % 3600 === 0) hours.push(`<text class="hr" x="${f1(x(t) + 3)}" y="${p.top + 13}">${Math.floor(t / 3600)}時</text>`);
  }
  labels.push(`<text class="rname" x="6" y="${p.top + 13}">${esc(p.route.name)}</text>`);
  for (const s of p.route.stations) {
    const yy = Y(p, s.stationId);
    grid.push(`<path class="st" d="M0 ${f1(yy)}H${f1(W)}"/>`);
    const cls = s.stationId === it.start ? "start" : excluded.has(s.stationId) ? "ex" : visited.has(s.stationId) ? "" : "ex";
    labels.push(`<text class="sname ${cls}" x="${LABEL_W - 6}" y="${f1(yy)}">${esc(stName.get(s.stationId)!)}</text>`);
  }
}

const dur = it.end - it.t0;
const fmtDur = (sec: number) => `${Math.floor(sec / 3600)}時間${String(Math.round(sec / 60) % 60).padStart(2, "0")}分`;
const rideSec = it.legs.reduce((a, l) => a + l.arr - l.dep, 0);
const nVisit = it.legs.filter((l) => l.visit).length;
const title = titleArg ?? "京王線 全駅下車行程";

const head = `<title>${title}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=BIZ+UDPGothic:wght@400;700&display=swap">
<style>
/* 線区ごとのパネルを縦に積み、横軸は共通の時刻。行程はアクセント色の太線 */
:root {
  --bg: #fbfaf7; --fg: #1d1d1f; --muted: #6b6b70; --panel: #ffffff; --line: #e4e2dc; --grid: #ecebe6; --grid-h: #c9c7bf;
  --accent: #d63a08; --accent-soft: rgba(214, 58, 8, .26); --on-accent: #ffffff; --halo: #ffffff; --wait: #9a9aa2;
  --font: "BIZ UDPGothic", "Hiragino Sans", "Yu Gothic UI", "Meiryo", system-ui, sans-serif;
  --t0: #8a8a8a; --t1: #c2a90f; --t2: #3a68c2; --t3: #13a37c; --t4: #d0257b; --t5: #0a458e; --t6: #0a458e;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #141416; --fg: #ececf0; --muted: #9a9aa3; --panel: #1c1c1f; --line: #2c2c31; --grid: #242428; --grid-h: #3d3d44;
    --accent: #ff6a2b; --accent-soft: rgba(255, 106, 43, .32); --on-accent: #1a0d06; --halo: #1c1c1f; --wait: #77777f; color-scheme: dark;
    --t0: #8d8d95; --t1: #d8c339; --t2: #6f98ea; --t3: #2fcf9f; --t4: #f05aa6; --t5: #6c8fd8; --t6: #6c8fd8;
  }
}
:root[data-theme="dark"] {
  --bg: #141416; --fg: #ececf0; --muted: #9a9aa3; --panel: #1c1c1f; --line: #2c2c31; --grid: #242428; --grid-h: #3d3d44;
  --accent: #ff6a2b; --accent-soft: rgba(255, 106, 43, .32); --on-accent: #1a0d06; --halo: #1c1c1f; --wait: #77777f; color-scheme: dark;
  --t0: #8d8d95; --t1: #d8c339; --t2: #6f98ea; --t3: #2fcf9f; --t4: #f05aa6; --t5: #6c8fd8; --t6: #6c8fd8;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 14px/1.55 var(--font); }
main { max-width: 1600px; margin: 0 auto; padding-inline: 16px; padding-block: 20px 48px; }
h1 { text-wrap: balance; }
.kpi b, table { font-variant-numeric: tabular-nums; }
input:focus-visible, summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
h1 { font-size: 22px; margin: 0 0 4px; letter-spacing: .02em; }
.sub { color: var(--muted); margin: 0 0 16px; }
.kpis { display: flex; flex-wrap: wrap; gap: 10px; margin: 0 0 14px; }
.kpi { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 8px 14px; min-width: 120px; }
.kpi b { display: block; font-size: 20px; font-variant-numeric: tabular-nums; }
.kpi span { color: var(--muted); font-size: 12px; }
.bar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 18px; margin: 0 0 10px; color: var(--muted); font-size: 12.5px; }
.bar label { display: flex; align-items: center; gap: 6px; }
.lg { display: inline-flex; align-items: center; gap: 5px; }
.lg i { display: inline-block; width: 18px; height: 0; border-top: 2px solid; }
.lg i.r { border-top: 4px solid var(--accent); }
.lg i.d { border-top: 6px solid var(--accent-soft); }
.lg i.w { border-top: 2px dashed var(--wait); }
.lg em { font-style: normal; display: inline-grid; place-items: center; width: 16px; height: 16px; border-radius: 50%; background: var(--accent); color: var(--on-accent); font-size: 10px; }
/* 図全体を画面の幅と高さに収める（スクロールなし） */
.wrap { border: 1px solid var(--line); border-radius: 12px; background: var(--panel); overflow: hidden; }
#dia { display: block; width: 100%; height: auto; max-height: calc(100vh - 24px); }
.sep { stroke: var(--line); stroke-width: 1; }
svg { display: block; }
.panel { fill: none; }
.g10 { stroke: var(--grid); stroke-width: .5; }
.g30 { stroke: var(--grid); stroke-width: 1; }
.gh { stroke: var(--grid-h); stroke-width: 1; }
.st { stroke: var(--line); stroke-width: .7; }
.hr { fill: var(--muted); font-size: 11px; }
.rname { fill: var(--fg); font-size: 12px; font-weight: 700; }
.sname { fill: var(--fg); font-size: 11px; text-anchor: end; dominant-baseline: middle; }
.sname.ex { fill: var(--muted); }
.sname.start { fill: var(--accent); font-weight: 700; }
.bgtrains path { fill: none; stroke-width: .9; opacity: .34; }
.bgtrains.dim path { opacity: .12; }
.t0 { stroke: var(--t0); } .t1 { stroke: var(--t1); } .t2 { stroke: var(--t2); } .t3 { stroke: var(--t3); }
.t4 { stroke: var(--t4); } .t5 { stroke: var(--t5); } .t6 { stroke: var(--t6); }
.bgtrains path.rs { stroke-dasharray: 3 2; }
.leg path { fill: none; stroke-linecap: round; stroke-linejoin: round; }
.leg .halo { stroke: var(--halo); stroke-width: 6; }
.leg .ride { stroke: var(--accent); stroke-width: 3; }
.leg:hover .ride { stroke-width: 4.5; }
.dwell { stroke: var(--accent-soft); stroke-width: 6; stroke-linecap: round; }
.wait { stroke: var(--wait); stroke-width: 1.6; stroke-dasharray: 3 2; }
.visit circle { fill: var(--accent); stroke: var(--halo); stroke-width: 1.5; }
.visit text { fill: var(--on-accent); font-size: 8.5px; font-weight: 700; text-anchor: middle; dominant-baseline: central; pointer-events: none; }
.xfer { fill: var(--halo); stroke: var(--accent); stroke-width: 1.6; }
.start circle { fill: var(--halo); stroke: var(--accent); stroke-width: 3; }
details { margin-top: 18px; background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 10px 14px; }
summary { cursor: pointer; font-weight: 700; }
.tbl { overflow-x: auto; }
table { border-collapse: collapse; margin-top: 8px; font-variant-numeric: tabular-nums; font-size: 13px; white-space: nowrap; }
td { padding: 3px 10px 3px 0; border-bottom: 1px solid var(--line); }
tr.x td { color: var(--muted); }
.sw { display: inline-block; width: 10px; height: 0; border-top: 3px solid; margin-right: 6px; vertical-align: middle; }
.note { color: var(--muted); font-size: 12.5px; margin-top: 14px; }
/* 印刷: A3 横 1 ページ。見出し・凡例・図だけ残し、配色は常に明るい版 */
@page { size: A3 landscape; margin: 8mm; }
@media print {
  :root, :root[data-theme] {
    --bg: #ffffff; --fg: #1d1d1f; --muted: #6b6b70; --panel: #ffffff; --line: #d9d7d0; --grid: #e6e4de; --grid-h: #bdbbb3;
    --accent: #d63a08; --accent-soft: rgba(214, 58, 8, .26); --on-accent: #ffffff; --halo: #ffffff; --wait: #9a9aa2;
    --t0: #8a8a8a; --t1: #c2a90f; --t2: #3a68c2; --t3: #13a37c; --t4: #d0257b; --t5: #0a458e; --t6: #0a458e;
    color-scheme: light;
  }
  * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { background: #ffffff; font-size: 9pt; }
  main { max-width: none; padding: 0; }
  h1 { font-size: 14pt; margin: 0; display: inline; }
  .sub { display: inline; margin: 0 0 0 10pt; font-size: 9pt; }
  .kpis, details, .bar label { display: none; }
  .bar { margin: 2mm 0; font-size: 8pt; gap: 2mm 6mm; }
  .wrap { border: 0; border-radius: 0; break-inside: avoid; }
  /* A3 横の印刷範囲 404×281mm から見出しと凡例の分を引いた高さに収める */
  #dia { width: auto; max-width: 100%; height: 252mm; max-height: none; margin: 0 auto; }
  .note { font-size: 7pt; margin: 1mm 0 0; }
}
@media (max-width: 640px) { .labels svg text.sname { font-size: 10px; } h1 { font-size: 19px; } }
</style>`;
const body = `
<main>
<h1>${title}</h1>
<p class="sub">${toHM(it.t0)} ${esc(stName.get(it.start)!)} 入場 → ${toHM(it.end)} ${esc(stName.get(it.order.at(-1)!)!)} 出場　／　${esc(tt.service.id === "holiday" ? "土休日" : tt.service.id)}ダイヤ（${tt.service.sampleDate}）</p>
<div class="kpis">
  <div class="kpi"><b>${fmtDur(dur)}</b><span>所要時間</span></div>
  <div class="kpi"><b>${nVisit}駅</b><span>${it.excluded.length ? `下車（除外: ${esc(it.excluded.map((s) => stName.get(s)).join("・"))}）` : `下車（入場駅の${esc(stName.get(it.start)!)}を含め全${nVisit + 1}駅）`}</span></div>
  <div class="kpi"><b>${fmtDur(rideSec)}</b><span>乗車 ${it.legs.length}回</span></div>
  <div class="kpi"><b>${it.dwellMin}分</b><span>1駅の改札出入り</span></div>
</div>
<div class="bar">
  <span class="lg"><i class="r"></i>乗車した列車</span>
  <span class="lg"><i class="d"></i>改札を出て駅にいる時間</span>
  <span class="lg"><i class="w"></i>乗換の待ち</span>
  <span class="lg"><em>1</em>下車順</span>
  <span class="lg"><i style="border-color:var(--t0)"></i>各停</span>
  <span class="lg"><i style="border-color:var(--t1)"></i>区間急行</span>
  <span class="lg"><i style="border-color:var(--t2)"></i>快速</span>
  <span class="lg"><i style="border-color:var(--t3)"></i>急行</span>
  <span class="lg"><i style="border-color:var(--t4)"></i>特急</span>
  <span class="lg"><i style="border-color:var(--t5);border-top-style:dashed"></i>ライナー等（有料区間は点線）</span>
  <label><input id="dim" type="checkbox"> 背景の列車を薄く</label>
</div>
<div class="wrap">
  <svg id="dia" viewBox="0 0 ${f1(LABEL_W + W)} ${H}" preserveAspectRatio="xMidYMin meet" role="img" aria-label="行程のダイヤグラム">
    <g>${labels.join("")}</g>
    <path class="sep" d="M${LABEL_W} 0V${H}"/>
    <g transform="translate(${LABEL_W} 0)">
    <g>${grid.join("")}</g>
    <g class="bgtrains" id="bg">${bg.join("")}</g>
    <g>${stay.join("")}</g>
    <g>${ride.join("")}</g>
    <g>${marks.join("")}</g>
    <g>${hours.join("")}</g>
    </g>
  </svg>
</div>
<details>
<summary>乗車の一覧（${it.legs.length}回）</summary>
<div class="tbl"><table><tbody>${rows.join("")}</tbody></table></div>
</details>
<p class="note">条件: 改札の出入り ${it.dwellMin} 分、改札を出ない乗換 ${it.xferMin} 分（${Object.entries(it.xferAt ?? { shinjuku: 8 }).map(([s, m]) => `${stName.get(s)} ${m} 分`).join("、")}）${Object.keys(it.platformPenalty ?? {}).length ? `、指定改札とつながっていないホームは追加時間（${Object.entries(it.platformPenalty!).map(([s, v]) => `${stName.get(s)} ${v.down ? `下り +${v.down}` : ""}${v.up ? `上り +${v.up}` : ""} 分`).join("、")}）` : ""}、座席指定が必要な区間は使わない。時刻は NAVITIME（京王電鉄 公式時刻表）の ${tt.service.sampleDate} のダイヤ。探索は近似（ビームサーチ＋局所探索）で、最短の保証はない。</p>
</main>
<script>
document.getElementById("dim").addEventListener("change", (e) => document.getElementById("bg").classList.toggle("dim", e.target.checked));
</script>
`;
const html = ARTIFACT ? `${head}
${body}` : `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${head}
</head>
<body>
${body}</body>
</html>
`;
await Deno.writeTextFile(outPath, html);
console.log(`wrote ${outPath} (${(html.length / 1024).toFixed(0)} KB, ${W.toFixed(0)}x${H} px)`);
