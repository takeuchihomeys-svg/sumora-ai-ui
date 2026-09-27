"use strict";
// prerender-offscreen.js（v2.5.33・2026-09-27）
// 竹内「なぜ送れないのか？画像をそのままの蓮産業の画像で保存していたらそのまま使える。ここちゃんとできるようにする」
// リアプロの資料は MS ゴシックを埋め込んでいないので、元の見た目の画像はこのパソコン（Windows の Chrome）でしか作れない。
// 裏の画面（offscreen）の中で /pickup-prerender を iframe で開く → 画面が PDF の1ページ目をそのまま描いて
// /api/property-pickups/trim に置く（書体が無ければ作らない）→ 終わりを postMessage で受けて background に知らせる。
// ⚠ 拡張の画面は inline の script を使えないので、このファイルに分けている
var PRERENDER_ORIGINS = ["https://sumora-ai-ui.vercel.app", "http://localhost:3000"];

window.addEventListener("message", function (ev) {
  if (PRERENDER_ORIGINS.indexOf(ev.origin) < 0) return;
  var d = ev.data;
  if (!d || d.type !== "axlx-prerender-done") return;
  try {
    chrome.runtime.sendMessage({
      type: "axlx-prerender-done",
      result: { ok: !!d.ok, made: Number(d.made) || 0, listed: Number(d.listed) || 0, failed: Number(d.failed) || 0, fontMissing: !!d.fontMissing, error: d.error ? String(d.error).slice(0, 200) : null }
    });
  } catch (_) { /* background が居ない時は閉じる予約（alarm）が閉じる */ }
});

(function () {
  var src = new URLSearchParams(location.search).get("src") || "";
  var ok = PRERENDER_ORIGINS.some(function (o) { return src.indexOf(o + "/") === 0; });
  if (!ok) return;
  var f = document.createElement("iframe");
  f.src = src;
  f.width = "800"; f.height = "600";
  document.body.appendChild(f);
})();
