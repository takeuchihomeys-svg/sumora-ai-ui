// 実行: node tests/chrome-extension/guide-only-v2577.test.js
// 2026-10-06 v2.5.77 竹内「拡張ツール 光らせてるだけで良い 上の文字いらない。今自動モードでてしまうこともあるから
//   常に自動モードではなくて、光って選択するモードとする」
//   ① 自動の道が開かない（どのモード・ブレインの組み合わせ・古い保存の値でも）
//   ② 画面の上に案内の文字を出さない（光と、画面の外の時の矢印だけ・枠は既定で 🔦 の丸だけ）
const fs = require("fs");
const path = require("path");
const dir = path.join(__dirname, "..", "..", "chrome-extension");
const read = (f) => fs.readFileSync(path.join(dir, f), "utf8");
const M = require(path.join(dir, "mode-core.js"));

let passed = 0, failed = 0;
function ok(name, cond, extra) { if (cond) { passed++; console.log("  ✓ " + name); } else { failed++; console.log("  ✗ " + name + (extra !== undefined ? "\n      " + JSON.stringify(extra).slice(0, 300) : "")); } }

console.log("── ① 自動の道が開かない");
ok("GUIDE_ONLY が立っている", M.GUIDE_ONLY === true);
const AUTO = ["claimCommands", "claimAix", "autoSend", "runAutoSchedule", "claimBrainCommands"];
const combos = M.MODES.flatMap((m) => [false, true].map((b) => [m, b]));
ok("6通りの組み合わせすべてで自動の物が false（受け取り・自動送信・自動便・web_brain）", combos.every(([m, b]) => AUTO.every((k) => M.effectiveBehavior(m, b)[k] === false)), combos.map(([m, b]) => [m, b, AUTO.map((k) => M.effectiveBehavior(m, b)[k])]));
ok("ブレインの判定・記録・まとめは押して送った物に今まで通り効く", M.effectiveBehavior("normal", true).brainJudge && M.effectiveBehavior("normal", true).recordPickup && M.effectiveBehavior("staff", true).completeGroup);
ok("古い版の AIX連動の値が残っていても「通常」で読む", M.effectiveState({ aixMode: true, brainMode: true }, Date.now()).mode === "normal");
ok("スタッフの2時間が切れて AIX の値が残っていても自動にならない", M.effectiveState({ staffMode: true, staffModeAt: Date.now() - 3 * 3600e3, aixMode: true }, Date.now()).mode === "normal" && !M.effectiveBehavior(M.effectiveState({ staffMode: true, staffModeAt: Date.now() - 3 * 3600e3, aixMode: true }, Date.now()).mode, true).claimCommands);
ok("更新・起動の時に書き直す値（AIX連動を切る・案内モード ON）", JSON.stringify(M.guideOnlyMigration()) === JSON.stringify({ aixMode: false, guideMode: true }));
const bg = read("background.js");
ok("background: 一括検索の受け取りは effectiveBehavior（取りに行かない）", /\(_core\.effectiveBehavior \|\| _core\.behavior\)\(_modeSt\.mode, _modeSt\.brain\)/.test(bg) && /\(_core\.effectiveState \|\| _core\.readState\)\(_modeRaw, Date\.now\(\)\)/.test(bg));
ok("background: popup の一括検索（axlx-manual-bulk-search）は始めない", /if \(_guideOnly\(\)\) \{ console\.warn\("\[manual-bulk-search\] 光って選択するモードのため一括検索は始めない"\); sendResponse\(\{ ok: false, error: "guide_only" \}\); return true; \}/.test(bg));
ok("background: 一括検索のコマンドが届いても動かさない（止めるコマンドだけ通す）", /if \(_guideOnly\(\) && command && command\.command_type !== "stop_all"\)/.test(bg));
ok("background: Realtime の検索コマンドも動かさない", /if \(_guideOnly\(\)\) \{ console\.log\("\[SB-RT\] 光って選択するモードのため scrape_command を無視/.test(bg));
ok("background: 更新・起動のたびに古い値を書き直す", /chrome\.runtime\.onInstalled\.addListener\(_migrateGuideOnly\);/.test(bg) && /chrome\.runtime\.onStartup\.addListener\(_migrateGuideOnly\);/.test(bg));
const pp = read("popup.js"), html = read("popup.html");
ok("popup: モードの選択に AIX連動が無い", !/<option value="aix">/.test(html) && /if \(core && core\.GUIDE_ONLY && mode === "aix"\) mode = "normal";/.test(pp));
ok("popup: 一括検索の帯は出さない", /id="bulk-toolbar" class="axlx-guide-only-hidden"/.test(html) && /\.axlx-guide-only-hidden \{ display: none !important; \}/.test(read("styles.css")));
ok("popup: 案内モードは常に ON・再開の印を置かない", /const _guideIt = \(self\.AxlxModeCore && self\.AxlxModeCore\.GUIDE_ONLY\) \? true :/.test(pp) && /\|\| \(self\.AxlxModeCore && self\.AxlxModeCore\.GUIDE_ONLY\)\) \{ try \{ chrome\.storage\.session\.remove\("axlx_pending_auto_send"\)/.test(pp));
for (const f of ["bulk-dl.js", "itandi-bulk-dl.js"]) {
  const s = read(f);
  ok(`${f}: 古い OFF の値でも自動の送信・ページ送りを始めない`, /var _GUIDE_ONLY = true;/.test(s) && /_guideOff = !_GUIDE_ONLY && /.test(s));
}
ok("リアプロ: 全ページ送るのボタンを出さない", /document\.getElementById\("axlx-auto-btn"\)\.parentNode\.style\.display = "none"/.test(read("bulk-dl.js")));
ok("ITANDI: 全ページ送るのボタンを出さない", /document\.getElementById\("axlx-itandi-all-pages-btn"\)\.style\.display = "none"/.test(read("itandi-bulk-dl.js")));
for (const f of ["realpro-guide.js", "itandi-guide.js"]) {
  const s = read(f);
  ok(`${f}: 案内モードは常に ON（OFF に切り替えるボタンなし）`, /guideOn = true;\s*\}?/.test(s) && !/data-a="mode"/.test(s) && !/a === "mode"/.test(s));
}
ok("page-script（リアプロ・ITANDI）は印が \"0\" の時だけ入力する＝常に案内へ渡す", /getAttribute\("data-axlx-guide"\) !== "0"/.test(read("page-script.js")));

console.log("── ② 画面の上に案内の文字を出さない");
for (const f of ["realpro-guide.js", "itandi-guide.js"]) {
  const s = read(f);
  ok(`${f}: 光の横の吹き出しは矢印だけ（文字なし）`, /tip\.textContent = arrow; \/\/ v2\.5\.77/.test(s) && !/上にあります|下にあります|tip\.textContent = label/.test(s.replace(/\/\/.*$|^\s*\*.*$/gm, "")));
  ok(`${f}: 枠は既定で 🔦 の丸だけ（押した時だけ開く・覚える）`, /function _panelOpen\(\) \{ try \{ return localStorage\.getItem\(PANEL_OPEN_KEY\) === "1"; \}/.test(s) && /var PANEL_PILL = '<button data-a="unfold"[^']*>🔦<\/button>';/.test(s));
}
// 光の要素（glow）は文字を持たない
ok("リアプロ: 光の要素は枠だけ（textContent を入れない）", (() => { const s = read("realpro-guide.js"); const m = s.match(/rects\.forEach\(function \(r\) \{[\s\S]*?\}\);/); return !!m && !/textContent|innerHTML/.test(m[0]); })());
ok("ITANDI: 光の要素は枠だけ", (() => { const s = read("itandi-guide.js"); const m = s.match(/rects\.forEach\(function \(r\) \{[\s\S]*?\}\);/); return !!m && !/textContent|innerHTML/.test(m[0]); })());
const mf = JSON.parse(read("manifest.json"));
ok("manifest の版 2.5.78", mf.version === "2.5.78");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
