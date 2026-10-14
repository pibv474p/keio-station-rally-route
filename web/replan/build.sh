#!/usr/bin/env bash
# スマホ用の再計算画面（Artifact）を out/replan/ に組み立てる
# 使い方: bash web/replan/build.sh   … その後 out/replan/index.html を Artifact として公開（files: worker.js, data/*.json）
set -eu
cd "$(dirname "$0")/../.."
mkdir -p out/replan/data
deno bundle --platform browser -o out/replan/worker.js web/replan/worker.ts
cp web/replan/index.html out/replan/index.html
cp data/keio_all_holiday.json out/replan/data/regular.json             # 通常の土休日（2026-12-12）
cp data/keio_all_holiday_2026-10-10.json out/replan/data/race.json     # 東京競馬の開催日（2026-10-10）
cp config/walk_keio.json out/replan/data/walk.json
ls -la out/replan out/replan/data
