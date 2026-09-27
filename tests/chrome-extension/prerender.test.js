// 実行: node tests/chrome-extension/prerender.test.js
// 2026-09-27 v2.5.33 竹内「なぜ送れないのか？画像をそのままの蓮産業の画像で保存していたらそのまま使える。ここちゃんとできるようにする」
//   資料が届いた後と10分おきに、このパソコンの裏の画面（chrome.offscreen）で /pickup-prerender を開き、送る画像を先に作る
const fs = require("fs");
const path = require("path");
const vm = require("vm");
let pass = 0, fail = 0;
function eq(name, a, b) { const ok = JSON.stringify(a) === JSON.stringify(b); ok ? pass++ : fail++; console.log((ok ? "  ✓ " : "  ✗ ") + name + (ok ? "" : `\n      expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`)); }
function ok(name, c) { eq(name, !!c, true); }
const EXT = path.join(__dirname, "../../chrome-extension");
const read = (f) => fs.readFileSync(path.join(EXT, f), "utf8");

console.log("\n■ manifest");
{
  const mf = JSON.parse(read("manifest.json"));
  const v = mf.version.split(".").map(Number);
  ok("版が 2.5.33 以上", v[0] > 2 || (v[0] === 2 && (v[1] > 5 || (v[1] === 5 && v[2] >= 33))));
  ok("offscreen の許可", mf.permissions.includes("offscreen"));
  ok("拡張の中に _ で始まるファイルが無い", fs.readdirSync(EXT).every((f) => !f.startsWith("_")));
  ok("裏の画面のファイルがある", fs.existsSync(path.join(EXT, "prerender-offscreen.html")) && fs.existsSync(path.join(EXT, "prerender-offscreen.js")));
  const html = read("prerender-offscreen.html");
  ok("裏の画面は inline の script を使わない（拡張の CSP）", !/<script>(?!<\/script>)[\s\S]*?\S[\s\S]*?<\/script>/.test(html.replace(/<script src="[^"]+"><\/script>/g, "")));
}

console.log("\n■ background.js（予約・数だけ聞く・閉じる）");
{
  const bg = read("background.js");
  const merge = bg.slice(bg.indexOf("async function callMergeApi"), bg.indexOf("// ── 売上サポ: お客様に送る物件の画像"));
  ok("送信（merge-pdfs）の成功の後に予約する", /if \(!data\.ok\) throw[\s\S]*_schedulePrerender\(PRERENDER_AFTER_MERGE_MS\)/.test(merge));
  ok("先に数だけ聞く（count=1）", /prerender\?count=1/.test(bg));
  ok("0件なら裏の画面を開かない", /if \(count === 0\) return \{ skipped: "none" \}/.test(bg));
  ok("10分おきの見回り", /PRERENDER_SWEEP_ALARM, \{ delayInMinutes: 1, periodInMinutes: 10 \}/.test(bg));
  ok("知らせが来なくても閉じる予約", /PRERENDER_CLOSE_ALARM, \{ when: Date\.now\(\) \+ 4 \* 60 \* 1000 \}/.test(bg));
  ok("終わりの知らせはこの拡張からだけ受ける", /sender\.id !== chrome\.runtime\.id/.test(bg));
  ok("開くのはウェブアプリの /pickup-prerender", /PRERENDER_PAGE_URL = "https:\/\/sumora-ai-ui\.vercel\.app\/pickup-prerender"/.test(bg));
  ok("リアプロ・itandi のサイトを開かない（この節）", !/realnetpro|itandibb/.test(bg.slice(bg.indexOf("// ── 売上サポ: お客様に送る物件の画像"), bg.indexOf("// ── 売上サポ: 10分の自動まとめ"))));
}

console.log("\n■ prerender-offscreen.js（iframe の出所と知らせ）");
{
  const code = read("prerender-offscreen.js");
  function run(src) {
    const sent = [], listeners = [], appended = [];
    const doc = { createElement: () => ({}), body: { appendChild: (x) => appended.push(x) } };
    const ctx = {
      URLSearchParams, location: { search: "?src=" + encodeURIComponent(src) }, document: doc,
      window: { addEventListener: (t, f) => listeners.push(f) },
      chrome: { runtime: { sendMessage: (m) => sent.push(m) } },
    };
    vm.runInNewContext(code, ctx);
    return { sent, listeners, appended };
  }
  const a = run("https://sumora-ai-ui.vercel.app/pickup-prerender?via=ext");
  eq("ウェブアプリの画面なら iframe を置く", a.appended.length, 1);
  eq("iframe の src", a.appended[0].src, "https://sumora-ai-ui.vercel.app/pickup-prerender?via=ext");
  const b = run("https://evil.example/pickup-prerender");
  eq("他の出所は開かない", b.appended.length, 0);
  const c = run("https://sumora-ai-ui.vercel.app.evil.example/x");
  eq("似た名前の出所も開かない", c.appended.length, 0);
  a.listeners[0]({ origin: "https://evil.example", data: { type: "axlx-prerender-done", made: 3 } });
  eq("他の出所の知らせは受けない", a.sent.length, 0);
  a.listeners[0]({ origin: "https://sumora-ai-ui.vercel.app", data: { type: "axlx-prerender-done", ok: true, made: 2, listed: 3, failed: 1 } });
  eq("ウェブアプリの知らせを background に渡す", a.sent[0], { type: "axlx-prerender-done", result: { ok: true, made: 2, listed: 3, failed: 1, fontMissing: false, error: null } });
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
