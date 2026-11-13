// 実行: node tests/chrome-extension/no-realpro-tab-v2704.test.js
// 2026-11-12 竹内さん「今リアプロスタンバイしていない時も勝手に自動検索おこなわれていないか？」
//
//   調べた結果（DB を実際に読んだ）: **動いていた**。
//   automation_commands の直近26時間 = 121件、そのうち **120件が
//   `AXLX_NO_TAB: realnetpro のタブが開いていません` で失敗**し、約60秒おきに拾い続けていた。
//
//   原因:
//     ① 拡張の `realproReady` が「リアプロのタブが1つも無い」時 **null** を返していた。
//        呼ぶ側は `=== false` の時だけ `rp=0` を付けるので、**何も付かずに命令を拾っていた**。
//     ② サーバーの `deferForRealproNotReady` は **web_brain だけ**を見ていて、
//        自動便（auto_schedule）は rp=0 でも渡していた。
//     ③ 拾った後で「タブが無い」と分かって失敗する。サーバーは1件ずつ渡すので、
//        その PC が**自動便の行列を1件ずつ順番に潰していく**（他の PC に回らない）。
const fs = require("fs");
const path = require("path");
const EXT = path.join(__dirname, "..", "..", "chrome-extension");
const read = (f) => fs.readFileSync(path.join(EXT, f), "utf8").replace(/\r\n/g, "\n");

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.log("  ✗ " + name + (extra !== undefined ? "\n      " + JSON.stringify(extra).slice(0, 400) : "")); }
}

const G = require(path.join(EXT, "batch-guard.js"));
const bg = read("background.js");

console.log("■ ① リアプロのタブが無い＝「この PC では使えない」（null を返さない）");
{
  const LIST = "https://itandibb.com/rent_rooms/list";
  const r1 = G.realproReady([{ url: LIST }]);
  ok("タブが1つも無い → false（旧: null）", r1 === false, r1);
  ok("空の配列 → false", G.realproReady([]) === false);
  ok("null → false", G.realproReady(null) === false);
  ok("main.php がある → true", G.realproReady([{ url: "https://www.realnetpro.com/main.php?method=estate" }]) === true);
  ok("ログインの画面だけ → false", G.realproReady([{ url: "https://www.realnetpro.com/index.php" }]) === false);
  ok("ログインと main.php の両方 → true", G.realproReady([{ url: "https://www.realnetpro.com/index.php" }, { url: "https://www.realnetpro.com/main.php" }]) === true);
  ok("**null を返さない**（呼ぶ側が rp=0 を付けられる）", !/return\s+any\s*\?\s*false\s*:\s*null/.test(read("batch-guard.js")));
}

console.log("\n■ ② 拾う前にタブを見る（拡張）");
{
  ok("タブを取る（chrome.tabs.query）", /_tabsNow = await chrome\.tabs\.query\(\{\}\)/.test(bg));
  ok("realproReady を呼ぶ", /_rpReady = self\.AxlxBatchGuard\.realproReady\(_tabsNow\)/.test(bg));
  ok("使えない時は rp=0 を付ける", /if \(_rpReady === false\) \{[\s\S]{0,120}rp=0/.test(bg));
  ok("自動モードでリアプロが無い時は指示を拾わない", /if \(_autoModeOn\) \{[\s\S]{0,700}no_realpro_tab/.test(bg));
  ok("  命令は消さない（pending のまま＝別の PC が拾う）", /pending のまま/.test(bg));
  ok("  理由を残す（no_realpro_tab）", /reason: "no_realpro_tab"/.test(bg));
}

console.log("\n■ ③ サーバーも rp=0 の PC にリアプロの命令を渡さない");
{
  const src = fs.readFileSync(path.join(__dirname, "..", "..", "app", "lib", "automation-sources.ts"), "utf8");
  ok("deferForRealproNotReady がある", /export function deferForRealproNotReady/.test(src));
  ok("  自動便（auto_schedule）も対象（旧: web_brain だけ）", /AUTO_SCHEDULE_RP_DEFER|src === "auto_schedule"/.test(src));
  ok("  リアプロを含む命令だけ", /realnetpro[\s\S]{0,40}realpro/.test(src));
  ok("  止める命令（stop_all）は必ず渡す", /command_type === "stop_all"\) return false/.test(src));
}

console.log("\n■ ④ 写真（画面録画）が実際に撮れているか分かる");
{
  const snap = read("snapshot-popup.js");
  ok("許可済みは録画ボタンの行に**枚数**を出す（許可≠撮れている・2026-11-13）", /snap-rec-slim-note/.test(snap) && /録画中 " \+ nv \+ "枚/.test(snap));
  ok("失敗があれば理由を色で示す", /note\.style\.color = nf \? "#b91c1c"/.test(snap));
  ok("撮る前に窓を前に出す（小窓を開いていると失敗するため）", /chrome\.windows\.update\(tab\.windowId, \{ focused: true \}\)/.test(bg));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
