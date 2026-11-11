// 実行: node tests/chrome-extension/mode-gate-v2663.test.js
// 2026-11-11 竹内さん:
//   「普通モードにしているとき自動検索されないようにする／デフォルトが普通モードにして
//     選択で自動モードやAIXにこちらでしてから自動検索されるように」
//   「今勝手に自動検索が普通モードでもおきてしまったり、リアプロ時ははいったら自動モード設定されていて自動検索されてしまう」
//   「画面検索中なぜかトップページに戻ったりして崩れてしまう」
//   「必要なら人間の動きをちゃんとおしえるので画面録画や監視して動きちゃんと理解できるように（通常モードで）」
const fs = require("fs");
const path = require("path");
const dir = path.join(__dirname, "..", "..", "chrome-extension");
const read = (f) => fs.readFileSync(path.join(dir, f), "utf8").replace(/\r\n/g, "\n");

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.log("  ✗ " + name + (extra !== undefined ? "\n      " + JSON.stringify(extra).slice(0, 400) : "")); }
}

const pp = read("popup.js"), bg = read("background.js"), mc = read("mode-core.js"), ps = read("page-script.js");
const M = require(path.join(dir, "mode-core.js"));

console.log("■ ① 通常モードでは自動の検索をしない（すべての入口に関所）");
{
  const core = M.behavior("normal", false);
  const eff = M.effectiveBehavior("normal", false);
  ok("通常モードは claimCommands が false（指示を拾わない）", eff.claimCommands === false);
  ok("通常モードは autoSend が false", eff.autoSend === false);
  ok("通常モードは runAutoSchedule が false（11時/17時の便を走らせない）", eff.runAutoSchedule === false);
  ok("通常モードは aiCustomerSearch が false", eff.aiCustomerSearch === false);
  ok("自動モード（aix）は開く", M.effectiveBehavior("aix", false).claimCommands === true && M.effectiveBehavior("aix", false).autoSend === true);
  ok("AIXモード（ai）も開く", M.effectiveBehavior("ai", false).claimCommands === true && M.effectiveBehavior("ai", false).aiCustomerSearch === true);
  ok("スタッフモードは全部閉じる", M.effectiveBehavior("staff", true).claimCommands === false && M.effectiveBehavior("staff", true).autoSend === false);

  // popup の受け口（pendingPopupCmd・switch-customer・startGuideFor）がモードを見る
  ok("popup: 自動で押す関所 _isAutoModeAllowed がある", /function _isAutoModeAllowed\(\)/.test(pp));
  ok("pendingPopupCmd は通常モードでは押さない", /function _runPendingPopupCmd\(cmd, via\) \{[\s\S]{0,400}?_isAutoModeAllowed\(\)/.test(pp));
  ok("switch-customer も通常モードでは押さない", /function _runSwitchCustomer\(d\) \{[\s\S]{0,300}?_isAutoModeAllowed\(\)/.test(pp));
  ok("startGuideFor も通常モードでは押さない", /function startGuideFor\(c, site, mode\) \{[\s\S]{0,1400}?_isAutoModeAllowed\(\)/.test(pp));
  // background の入口
  ok("background: webapp-search は通常モードでは受けない", /msg\.type === "axlx-webapp-search"[\s\S]{0,900}_guideOnly\(\)/.test(bg));
  ok("background: scrape-and-compare は通常モードでは動かない", /async function _runScrapeAndCompare\(customerId, conditions\) \{[\s\S]{0,900}_guideOnly\(\)/.test(bg));
}

console.log("\n■ ② デフォルトは通常モード（ブラウザ起動で自動モードを引きずらない）");
{
  ok("mode-core: startupReset が通常の値を返す", JSON.stringify(M.startupReset()) === JSON.stringify({ staffMode: false, staffModeAt: null, aixMode: false, autoModeAt: null, aiMode: false }));
  ok("background: 起動時（onStartup）に通常へ戻す", /chrome\.runtime\.onStartup\.addListener\(_resetModeOnStartup\)/.test(bg) && /function _resetModeOnStartup\(\)/.test(bg));
  ok("拡張の更新（onInstalled）では戻さない（作業中に勝手に戻らない）", !/chrome\.runtime\.onInstalled\.addListener\(_resetModeOnStartup\)/.test(bg));
  ok("storage に何も無ければ通常で読む", M.readState({}, Date.now()).mode === "normal");
  // 選んだ時だけ自動の道が開く
  ok("自動を選んだ時だけ autoModeAt の印が付く", M.storageUpdateForMode("aix", 1).autoModeAt === 1 && M.storageUpdateForMode("normal", 1).autoModeAt === null && M.storageUpdateForMode("staff", 1).autoModeAt === null);
  ok("古い aixMode の書き残しだけでは自動にならない（印が要る）", M.effectiveState({ aixMode: true }, Date.now()).mode === "normal");
  ok("印があれば自動のまま読む", M.effectiveState({ aixMode: true, autoModeAt: 1 }, Date.now()).mode === "aix");
  ok("スタッフの期限切れは通常で読む", M.readState({ staffMode: true, staffModeAt: 1 }, Date.now()).mode === "normal");
}

console.log("\n■ ③ 検索の最中にトップページ（main.php）へ飛ばない");
{
  ok("プルダウンで Enter を送らない（form 送信の原因）", !/key: "Enter", keyCode: 13/.test(ps));
  ok("Enter を送らない理由が残っている", /Enter は送らない/.test(ps));
  ok("背景のフォールバックは「すでに検索の画面」なら main.php へ移らない（webapp-search）", /すでに検索の画面 → main\.php へ移らない/.test(bg));
  ok("同じ判定が scrape-compare にもある", (bg.match(/すでに検索の画面 → main\.php へ移らない/g) || []).length >= 2);
  ok("判定は URL だけで見る（サイトを触らない）", /display=building/.test(bg) && /method=estate/.test(bg));
}

console.log("\n■ ④ 通常モードで人の動きを覚える（人の間を学習する土台）");
{
  const L = require(path.join(dir, "human-learn.js"));
  ok("human-learn.js がある（純関数）", typeof L.create === "function" && typeof L.summarize === "function");
  // 覚える
  let t = 1000;
  const rec = L.create({ now: () => t });
  rec.record("click", { tagName: "BUTTON", textContent: "検索" });
  t += 800; rec.record("change", { tagName: "SELECT", getAttribute: () => "rental_cost2" });
  t += 400; rec.record("keydown", { tagName: "INPUT", getAttribute: () => "required_time" });
  const ops = rec.list();
  ok("操作を順に覚える（3件）", ops.length === 3);
  ok("欄の名前を残す（値は残さない）", ops[1].f === "rental_cost2" && ops[2].f === "required_time");
  ok("中身（値）は持たない", ops.every((o) => !("v" in o) && !("value" in o)));
  // 間引き（同じ種類が250ms以内に続く）
  const r2 = L.create({ now: () => t });
  t = 5000; ok("連続クリックの1件目", r2.record("click", {}) === true);
  t += 100; ok("250ms以内の同じ種類は間引く", r2.record("click", {}) === false);
  t += 300; ok("250msを超えたら覚える", r2.record("click", {}) === true);
  // 集計
  const sum = L.summarize([
    { t: 0, k: "click", f: "検索" },
    { t: 700, k: "change", f: "rental_cost2" },
    { t: 1100, k: "click", f: "検索" },
  ]);
  ok("回数・種類を数える", sum.n === 3 && sum.kinds.click === 2 && sum.kinds.change === 1);
  ok("間の中央値を出す（700・400 → 550）", sum.gap_ms === 550);
  ok("触った欄の順を残す", sum.order.join(",") === "検索,rental_cost2,検索");
  ok("離席（2分超）は間の見本に入れない", L.summarize([{ t: 0, k: "click" }, { t: 200000, k: "click" }]).gaps.length === 0);
  // 足し合わせ
  const a = L.mergeAggregate(null, sum);
  const b = L.mergeAggregate(a, L.summarize([{ t: 0, k: "click", f: "検索" }]));
  ok("前の集計と足せる（回数・回分）", b.n === 4 && b.sessions === 2);
  ok("間の見本は上限まで", b.gaps.length <= L.MAX_GAPS);
  ok("1行の報告", /人の動き: 4回・2回分/.test(L.reportLine(b)));
  ok("何も無い時は案内を出す", /まだ人の動きを覚えていません/.test(L.reportLine(null)));

  const rec2 = read("human-learn-record.js");
  ok("通常・スタッフの時だけ覚える（自動・AIX では覚えない）", /function shouldLearn\(st\)/.test(rec2) && /return !autoOn;/.test(rec2));
  ok("自動モードになったら見張りを外す", /stopWatching\(\)/.test(rec2) && /detach\(\)/.test(rec2));
  ok("人が起こした物だけ数える（isTrusted）", /isTrusted/.test(read("human-learn.js")));
  ok("保存のキーは axlx_human_learn", /var KEY = "axlx_human_learn"/.test(rec2));
  ok("1分ごとに書き出す（操作のたびに書かない）", /SAVE_EVERY_MS = 60000/.test(rec2));
  const mf = JSON.parse(read("manifest.json"));
  const cs = mf.content_scripts.find((c) => (c.js || []).includes("human-learn-record.js"));
  ok("manifest: 3サイトで human-learn.js → human-learn-record.js を読む", !!cs && cs.js.indexOf("human-learn.js") < cs.js.indexOf("human-learn-record.js") && cs.matches.length === 4);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
