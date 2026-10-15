// JR東日本の HTML は再配布できないので、構造だけをまねた最小の HTML で確かめる
import { assertEquals } from "@std/assert";
import { parseStationTimetable, parseTrainPage } from "../src/sources/jreast/parse.ts";

const cell = (t: string, p = "") =>
  `<td class="time">${t ? `<ul><li><span class="time_normal">${t}</span></li></ul>` : ""}</td><td class="platform">${p}</td>`;

Deno.test("jreast: 列車ページの複数列（環状運転）と深夜の時刻", () => {
  const html = `<table>
<tr class="train"><th>列車種別</th><td colspan="2">普通</td><td colspan="2">普通</td></tr>
<tr class="train"><th>列車番号</th><td colspan="2">1G</td><td colspan="2">2G</td></tr>
<tr class="train"><th>運転日</th><td colspan="2"><ul><li>土曜・休日運転</li></ul></td><td colspan="2"></td></tr>
<tr class="time"><th class="time"><a href="../../../timetable/list0319.html">大崎</a></th>${cell("23:50 発", "２")}${cell("")}</tr>
<tr class="time"><th class="time"><a href="../../../timetable/list0788.html">品川</a></th>${cell("レ")}${cell("")}</tr>
<tr class="time"><th class="time"><a href="../../../timetable/list1039.html">東京</a></th>${cell("00:05 着")}${cell("")}</tr>
<tr class="time"><th class="time">&emsp;</th>${cell("")}${cell("00:07 発", "４")}</tr>
</table>`;
  const [a, b] = parseTrainPage(html);
  assertEquals(a.number, "1G");
  assertEquals(a.days, "土曜・休日運転");
  assertEquals(a.stops, [
    { station: "0319", name: "大崎", dep: 23 * 3600 + 50 * 60, track: "2" },
    { station: "0788", name: "品川", pass: true },
    { station: "1039", name: "東京", arr: 86400 + 300 },
  ]);
  assertEquals(b.stops, [{ station: "1039", name: "東京", dep: 86400 + 420, track: "4" }]);
});

Deno.test("jreast: 駅時刻表の 0 時台は翌日扱い・列車リンクの解決", () => {
  const dep = (m: string, href: string) =>
    `<div class="timetable_time" data-train="無印" data-dest="池" data-misc=""><a href="${href}"><span class="minute">${m}</span></a></div>`;
  const html = `<h2>東京駅　山手線</h2><table>
<tr id="time_23"><td>23時</td><td>${dep("59", "../../train/010/1.html")}</td></tr>
<tr id="time_0"><td>0時</td><td>${dep("12", "../../train/080/2.html")}</td></tr></table>`;
  const p = parseStationTimetable(html, "2610/timetable/tt1039/1039121.html");
  assertEquals(p.departures.map((d) => [d.dep, d.train, d.dest]), [
    [23 * 3600 + 59 * 60, "2610/train/010/1.html", "池"],
    [86400 + 720, "2610/train/080/2.html", "池"],
  ]);
});
