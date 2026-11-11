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

console.log("── ① 自動の道が開かない（自動モード以外）");
ok("GUIDE_ONLY が立っている", M.GUIDE_ONLY === true);
const AUTO = ["claimCommands", "claimAix", "autoSend", "runAutoSchedule", "claimBrainCommands"];
// 2026-11-10 竹内「3つのモードを並べる: 通常／スタッフ（今の人が押す案内）／自動（もともとの自動検索）」:
//   自動の道が開くのは自動モード（AUTO_MODE = "aix"）を選んだ時だけ。通常・スタッフは今まで通り全部止まったまま。
// 2026-11-11 竹内さん「4つ目にAIXをつけて、AIXの場合選択したお客さんが自動検索できるようにする」→ AIX（AI_MODE）も自動の道を開く
const AUTO_MODES = [M.AUTO_MODE, M.AI_MODE];
const NO_AUTO = M.MODES.filter((m) => AUTO_MODES.indexOf(m) < 0).flatMap((m) => [false, true].map((b) => [m, b]));
ok("自動・AIXモード以外の組み合わせは自動の物が false（受け取り・自動送信・自動便・web_brain）", NO_AUTO.every(([m, b]) => AUTO.every((k) => M.effectiveBehavior(m, b)[k] === false)), NO_AUTO.map(([m, b]) => [m, b, AUTO.map((k) => M.effectiveBehavior(m, b)[k])]));
ok("AIXモードも自動の道が開く（選んだお客さんを自動で検索）", ["claimCommands", "claimAix", "autoSend", "runAutoSchedule"].every((k) => M.effectiveBehavior(M.AI_MODE, false)[k] === true) && M.effectiveBehavior(M.AI_MODE, false).aiCustomerSearch === true);
ok("自動モードを選んだ時だけ自動の道が開く（受け取り・AIX・自動送信・自動便）", ["claimCommands", "claimAix", "autoSend", "runAutoSchedule"].every((k) => M.effectiveBehavior(M.AUTO_MODE, false)[k] === true));
ok("自動モード×ブレインは web_brain も受け取る", M.effectiveBehavior(M.AUTO_MODE, true).claimBrainCommands === true);
ok("自動モードでもスタッフ扱いにはならない（人が選んだ物を減らさない設定はスタッフだけ）", M.effectiveBehavior(M.AUTO_MODE, false).excludeSent === true);
ok("ブレインの判定・記録・まとめは押して送った物に今まで通り効く", M.effectiveBehavior("normal", true).brainJudge && M.effectiveBehavior("normal", true).recordPickup && M.effectiveBehavior("staff", true).completeGroup);
ok("選んだ印（autoModeAt）が無い古い AIX連動の値は「通常」で読む（勝手に自動にならない）", M.effectiveState({ aixMode: true, brainMode: true }, Date.now()).mode === "normal");
ok("自動モードを選んだ印があれば自動のまま読む", M.effectiveState({ aixMode: true, autoModeAt: Date.now(), brainMode: true }, Date.now()).mode === "aix");
ok("スタッフの2時間が切れて AIX の値が残っていても自動にならない", M.effectiveState({ staffMode: true, staffModeAt: Date.now() - 3 * 3600e3, aixMode: true }, Date.now()).mode === "normal" && !M.effectiveBehavior(M.effectiveState({ staffMode: true, staffModeAt: Date.now() - 3 * 3600e3, aixMode: true }, Date.now()).mode, true).claimCommands);
ok("更新・起動の時に書き直す値（選んだ印が無ければ AIX連動を切る・案内モード ON）", JSON.stringify(M.guideOnlyMigration({ aixMode: true })) === JSON.stringify({ aixMode: false, guideMode: true }));
ok("選んだ自動モードは起動のたびに消さない（案内モード ON だけ書く）", JSON.stringify(M.guideOnlyMigration({ aixMode: true, autoModeAt: 1 })) === JSON.stringify({ guideMode: true }));
const bg = read("background.js");
ok("background: 一括検索の受け取りは effectiveBehavior（取りに行かない）", /\(_core\.effectiveBehavior \|\| _core\.behavior\)\(_modeSt\.mode, _modeSt\.brain\)/.test(bg) && /\(_core\.effectiveState \|\| _core\.readState\)\(_modeRaw, Date\.now\(\)\)/.test(bg));
ok("background: popup の一括検索（axlx-manual-bulk-search）は始めない", /if \(_guideOnly\(\)\) \{ console\.warn\("\[manual-bulk-search\] 光って選択するモードのため一括検索は始めない"\); sendResponse\(\{ ok: false, error: "guide_only" \}\); return true; \}/.test(bg));
ok("background: 一括検索のコマンドが届いても動かさない（止めるコマンドだけ通す）", /if \(_guideOnly\(\) && command && command\.command_type !== "stop_all"\)/.test(bg));
ok("background: Realtime の検索コマンドも動かさない", /if \(_guideOnly\(\)\) \{ console\.log\("\[SB-RT\] 光って選択するモードのため scrape_command を無視/.test(bg));
ok("background: 更新・起動のたびに古い値を書き直す", /chrome\.runtime\.onInstalled\.addListener\(_migrateGuideOnly\);/.test(bg) && /chrome\.runtime\.onStartup\.addListener\(_migrateGuideOnly\);/.test(bg));
const pp = read("popup.js"), html = read("popup.html");
ok("popup: モードの選択に3つ（通常・スタッフ・自動）", /<option value="aix">自動<\/option>/.test(html) && /<option value="staff">スタッフ<\/option>/.test(html) && /<option value="normal">通常<\/option>/.test(html));
ok("popup: 自動モードを通常に落とさない（GUIDE_ONLY でも選べる）", !/if \(core && core\.GUIDE_ONLY && mode === "aix"\) mode = "normal";/.test(pp));
// 2026-11-11 竹内さん「もともとのAIXのようにチェックしたお客さんをリアプロとitandiで一括検索できる機能はあるかな？」→
//   ある（もともとのAIX）。v2.5.77 から隠していたのを、**自動・AIXモードの時だけ出す**に変えた（通常・スタッフでは今まで通り隠す）
ok("popup: 一括検索の帯は自動・AIXモードの時だけ出す", /id="bulk-toolbar" class="axlx-auto-only"/.test(html) && /body:not\(\.mode-aix\):not\(\.mode-ai\) \.axlx-auto-only \{ display: none !important; \}/.test(read("styles.css")) && /_b\.classList\.add\("mode-" \+ s\.mode\)/.test(pp));
ok("popup: 案内モードは既定 ON・自動モードの時だけ OFF・再開の印は自動モードの時だけ置く",
  /const _guideIt = _isAutoModeNow\(\) \? false :/.test(pp)
  && /const _guideIt = _isAutoModeNow\(\) \? false : \(\(self\.AxlxModeCore && self\.AxlxModeCore\.GUIDE_ONLY\) \? true :/.test(pp)
  && /_isAutoModeNow\(\)\) \{ \/\* 自動モードは置く \*\/ \}/.test(pp));
for (const f of ["bulk-dl.js", "itandi-bulk-dl.js"]) {
  const s = read(f);
  ok(`${f}: 古い OFF の値でも自動の送信・ページ送りを始めない`, /var _GUIDE_ONLY = true;/.test(s) && /_guideOff = !_GUIDE_ONLY && |_guideOff = !_GUIDE_ONLY \|\| /.test(s));
}
ok("リアプロ: 旧の「全ページ送る」のボタンを出さない（消した）", !/id="axlx-auto-btn"/.test(read("bulk-dl.js")));
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
ok("manifest の版 2.5.92（自動モード）", mf.version === "2.6.85");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
