// 大きな TSV を Claude の内蔵ブラウザで train-diagram.com のフォームへ渡すための一時サーバ。
// 内蔵ブラウザでは外部ページから localhost への fetch / iframe / ポップアップが使えず、貼り付けも届かないため、
// 同じタブで localhost → train-diagram.com と遷移させ、window.name で受け渡す。
//
//   deno task send
//   ブラウザで http://127.0.0.1:8765/send.html?f=<out のファイル名> を開く
//   → train-diagram.com に遷移したら window.name.slice(4) を「時刻データ」欄に入れる

import { fromFileUrl, join } from "@std/path";

const OUT = fromFileUrl(new URL("../out", import.meta.url));

const PAGE = `<!doctype html><meta charset="utf-8"><title>send</title><body>sending...<script>
const f = new URLSearchParams(location.search).get("f");
fetch("/" + f).then(r => r.text()).then(t => { window.name = "TSV:" + t; location.href = "https://www.train-diagram.com/"; });
</script>`;

Deno.serve({ port: 8765, hostname: "127.0.0.1" }, async (req) => {
  const name = new URL(req.url).pathname.slice(1);
  if (name === "send.html") return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
  if (!/^[\w.-]+\.tsv$/.test(name)) return new Response("not found", { status: 404 });
  const body = await Deno.readTextFile(join(OUT, name));
  return new Response(body, { headers: { "content-type": "text/plain; charset=utf-8" } });
});
