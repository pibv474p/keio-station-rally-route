# keio-station-rally-route

京王電鉄（京王線・井の頭線ほか）の全駅で改札を出る巡回ルートを、実際の時刻表から探索して
ダイヤグラムに描くツール（Deno 2.x）。

- 時刻表データ → 正規化 JSON → 各種ダイヤグラムツール用ファイル（train-diagram.com 用 TSV など）
- 全駅下車ルートの探索（Connection Scan + ビームサーチ + 局所探索、Web Worker で並列）
- 行程を路線網のダイヤグラムに重ねた HTML / A3 横 PDF

## データについて
- 時刻表は京王電鉄の公式時刻表サイト（transfer-train.navitime.biz）が画面表示に使っている JSON API から取得する。
  公開 API ではないので、利用条件を確認のうえ個人の範囲で使い、リクエスト間隔（既定 300ms）を詰めないこと
- 取得した生データ・生成物（`raw/` `data/` `out/`）はリポジトリに含めない。`deno task fetch` / `build` で作り直す
- `tests/fixtures*` はテスト用に保存した少量の応答

```
[Source adapter]            [正規化モデル]            [Exporter]
navitime  ─┐                                         ┌─ train-diagram-tsv（train-diagram.com 用）
odpt   (未)─┼─→ data/<line>_<service>.json ──────────┼─ oudia (未)
gtfs_jp(未)─┘   schemas/timetable.v1.json で検証     └─ svg   (未)
```

## 使い方
```bash
deno task fetch --line keio_dobutsuen --service holiday   # raw/navitime/... に保存（取得済みの列車は再取得しない）
deno task build --line keio_dobutsuen --service holiday   # data/*.json と out/*.tsv を作成
deno task test
```
`out/*.tsv` を https://www.train-diagram.com/ の「時刻データ」に貼り付けて「作成」。
駅間が 2km しかない路線は「駅間１kmの高さ」を 40 くらいにすると見やすい。
`--color` を付けると種別色（例: 井の頭線の急行は緑）をスジ色にする。

| 路線 | config | 本数（土休日 下り/上り） |
|---|---|---|
| 京王動物園線 | `keio_dobutsuen` | 73 / 74 |
| 京王井の頭線 | `keio_inokashira` | 277 / 271（急行・富士見ヶ丘発着を含む） |

### 路線網（京王線系統: `keio_network`）
京王線・京王新線・相模原線・高尾線・競馬場線・動物園線の 53 駅（KO01〜KO53）。
```bash
deno task fetch --line keio_network --service holiday --date 2026-12-12   # 約 1,400 リクエスト・十数分
deno task build --line keio_network --service holiday --date 2026-12-12 [--route keio|keio_new|sagamihara|takao|keibajo|dobutsuen]
```
- `routes` に線区ごとの駅順・キロ程を持つ。`--route` でその線区だけを切り出して TSV を出す
- 直通列車は途中で列車番号・種別が変わる（特急→各停、京王ライナー 有料列車→ライナー など）。区間ごとの列車に分け `next` / `prev` でつなぐ
- `reservedSeat: true` は座席指定券が必要な区間（京王ライナーの新宿・明大前、上りライナー全区間、Mt.TAKAO号）
- 土休日でも東京競馬の開催日は競馬場線が増発される（例: 2026-10-04 は 80 本、通常は 51 本）。通常ダイヤは `--date` で非開催日を指定する
- キロ程は公表値を手入力した参考値（駅間の並びには影響しない）

### 全駅下車の行程探索と図示
```bash
# 探索（--sweep で入場時刻を振る / --order "駅名,…" で指定順を評価 / --json で行程を保存）
deno run --allow-read --allow-write --allow-env tools/visit_network.ts --start keiotamacenter \
  --exclude shinjuku,keioinadazutsumi,keiotamacenter --dwell 3 --time 08:45 --json out/keio_network_visit_all_0845.json
# 同じ探索を P コア 4 個（各 1 スレッド）+ E コア 12 個に制限して並列実行（16 Worker、他の作業用に P コア 0〜3 を空ける）
deno task visit --start keiotamacenter --exclude shinjuku,keioinadazutsumi,keiotamacenter --dwell 3 --sweep 06:00-11:00/15
# 土休日の推奨オプション（現地で確認した前提）
#   --xfer-reverse 3                              改札を出ない逆方向乗換は +3 分（既定）
#   --platform-pen chitosekarasuyama=down:3,shibasaki=up:2   指定改札とつながっていないホームの追加時間
#   --maybe-stop tobitakyu=1                      飛田給の臨時停車（味スタの催し）に備え、通過列車はその先を 1 分遅れ扱い
#   --walk config/walk_keio.json --walk-exit 1    徒歩も選ぶ（電車を待つより早いときだけ）。改札を出て 1 分で歩き出す
#   --walk-factor 1.03（既定）                     OSM の歩行距離の補正。Google マップで確認した区間は config の minutes を優先
#   --dwell-at 駅=分,...                           駅ごとの滞在時間（最後の駅でも延長分は完了時刻に含める）
#   --data data/keio_all_holiday_YYYY-MM-DD.json   当日の時刻表（東京競馬の開催日は競馬場線が増発）
# 行程を路線網のダイヤグラムに重ねた HTML（線区ごとのパネル・共通の時刻軸）
deno run --allow-read --allow-write tools/render_itinerary.ts out/keio_network_visit_all_0845.json
```

大きな TSV を Claude の内蔵ブラウザで渡すときは `tools/send_server.ts`（`deno task send`）を使う（説明はファイル冒頭）。

## 構成
- `config/lines/<line>.json` — 駅順・キロ程・駅種・ソースごとの駅ID（`refs`）・API パラメータ
- `src/model.ts` — 正規化モデル。時刻は 0 時からの秒（24 時以降は 86400 以上、GTFS と同じ）
- `src/sources/<name>/` — `SourceAdapter`（`fetch`: 生データを raw/ に保存、`load`: raw/ → 正規化モデル。ネットワークに触れない）
- `src/exporters/` — `Exporter`（正規化モデル → ファイル文字列）
- `src/validate.ts` — JSON Schema と整合性（駅ID・時刻が戻らない）の検査

## NAVITIME ソース
京王の公式時刻表サイト（transfer-train.navitime.biz）が画面表示に使っている JSON API を使う。
- `/api/<company>/timetable/<station>/<line>/<direction>` — 駅時刻表（列車番号・番線・種別・改正日）
- `/api/<company>/stops/<station>/<line>?operation_id=&datetime=&direction=` — 列車ごとの停車駅と着発時刻

駅時刻表を順に見て、まだ停車駅一覧で見ていない列車だけ stops を取りに行くので、途中駅始発の列車も拾える。
リクエストの間隔は 300ms。

## ODPT / GTFS-JP を追加するとき
1. `src/sources/odpt/`（または `gtfs_jp/`）に `SourceAdapter` を実装して `src/sources/index.ts` に登録
2. `config/lines/<line>.json` の各駅の `refs` に `odpt`（odpt:Station の ID）/ `gtfs`（stop_id）を追加し、`sources.odpt` などに必要なパラメータを書く
3. API キーは環境変数から読む（config やコードに書かない）
4. 同じ路線の navitime 版と発着時刻が一致するかを比べるテストを追加
