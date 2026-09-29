// 実行: node tests/chrome-extension/auto-run.test.js
// 2026-09-27 v2.5.35 竹内「ITANDI もおねがい」「開始時間を…ランダムに不規則性をもって毎日変える」:
//   自動便（auto_schedule）はリアプロと ITANDI の両方・ITANDI のタブが無い PC は ITANDI だけ飛ばす・
//   サイトの間／お客様の間は人の動きのようにばらつかせる・午後の便の指定（更新日1日以内・更新順・1ページ）が popup の経路にも届く
const fs = require("fs");
const path = require("path");
const R = require("../../chrome-extension/auto-run.js");
let pass = 0, fail = 0;
function eq(name, a, b) { const ok = JSON.stringify(a) === JSON.stringify(b); ok ? pass++ : fail++; console.log((ok ? "  ✓ " : "  ✗ ") + name + (ok ? "" : `\n      expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`)); }
function ok(name, c) { eq(name, !!c, true); }
const EXT = path.join(__dirname, "../../chrome-extension");
const read = (f) => fs.readFileSync(path.join(EXT, f), "utf8");
function seq(values) { let i = 0; return () => values[i++ % values.length]; }

console.log("\n■ optsFromPayload（自動便の指定）");
{
  const pm = { source: "auto_schedule", mode: "pm", rp_update_days: 1, sort: "updated", max_pages: 1, is_wide: false };
  const am = { source: "auto_schedule", mode: "am", rp_update_days: 3, sort: "ad", max_pages: 3, is_wide: true };
  eq("午後の便: 更新日1・更新順・1ページ", R.optsFromPayload(pm), { mode: "pm", rp_update_days: 1, sort: "updated", max_pages: 1 });
  eq("午前の便: 更新日は上書きしない（popup が手で決めた値→前回出した日から）・AD・3ページ", R.optsFromPayload(am), { mode: "am", rp_update_days: null, sort: "ad", max_pages: 3 });
  eq("web_brain は null（今までどおり）", R.optsFromPayload({ source: "web_brain", rp_update_days: 3 }), null);
  eq("手動（payload なし）は null", R.optsFromPayload(null), null);
  eq("変な値は null に", R.optsFromPayload({ source: "auto_schedule", mode: "pm", rp_update_days: "x", sort: "zzz", max_pages: -1 }), { mode: "pm", rp_update_days: null, sort: null, max_pages: null });
}

console.log("\n■ record / forCustomer（storage の印）");
{
  const o = R.optsFromPayload({ source: "auto_schedule", mode: "pm", rp_update_days: 1, sort: "updated", max_pages: 1 });
  const st = R.record("c1", "itandi", o, 1000);
  eq("同じお客様・同じサイト → 指定", R.forCustomer(st, "c1", "itandi", 2000), { mode: "pm", rp_update_days: 1, sort: "updated", max_pages: 1 });
  eq("別のお客様 → null（前のお客様の指定を使わない）", R.forCustomer(st, "c2", "itandi", 2000), null);
  eq("別のサイト → null", R.forCustomer(st, "c1", "realnetpro", 2000), null);
  eq("古い（20分より前）→ null", R.forCustomer(st, "c1", "itandi", 1000 + R.TTL_MS + 1), null);
  eq("無い → null", R.forCustomer(null, "c1", "itandi", 2000), null);
  eq("数字の id でも同じ", R.forCustomer(R.record(5, "realnetpro", o, 0), "5", "realnetpro", 10).max_pages, 1);
  eq("自動便でなければ印を作らない", R.record("c1", "itandi", null, 0), null);
}

console.log("\n■ pageLimit / allowAdSort");
{
  eq("午後の便は1ページ", R.pageLimit({ max_pages: 1 }, 3), 1);
  eq("指定なし → 既定（リアプロ 3）", R.pageLimit(null, 3), 3);
  eq("指定なし・既定なし → null（ITANDI は今までどおり全ページ）", R.pageLimit(null, null), null);
  eq("午後の便（更新順）は AD へ並べ替えない", R.allowAdSort({ sort: "updated" }), false);
  eq("午前の便は AD 高い順", R.allowAdSort({ sort: "ad" }), true);
  eq("手動は今までどおり AD 高い順", R.allowAdSort(null), true);
}

console.log("\n■ planSites（ITANDI のタブが無い PC は ITANDI を飛ばす）");
{
  const both = ["realnetpro", "itandi"];
  eq("タブあり → 両方", R.planSites(both, { isAuto: true, hasItandiTab: true }), { sites: both, skipped: [] });
  eq("タブなし → リアプロだけ・ITANDI は飛ばした印", R.planSites(both, { isAuto: true, hasItandiTab: false }), { sites: ["realnetpro"], skipped: [{ site: "itandi", why: "no_itandi_tab" }] });
  eq("自動便でなければ今までどおり（タブが無ければ開く）", R.planSites(both, { isAuto: false, hasItandiTab: false }).sites, both);
  eq("順番はそのまま（リアプロ → ITANDI）", R.planSites(["realnetpro", "itandi", "reins"], { isAuto: true, hasItandiTab: true }).sites, ["realnetpro", "itandi", "reins"]);
  ok("ITANDI の画面のタブを見つける", R.hasItandiTab([{ url: "https://www.realnetpro.com/main.php" }, { url: "https://itandibb.com/rent_rooms/list" }]));
  ok("リアプロだけなら無い", !R.hasItandiTab([{ url: "https://www.realnetpro.com/main.php" }]));
  ok("似た名前の別のサイトは数えない", !R.hasItandiTab([{ url: "https://evil.example/itandibb.com/" }]));
  eq("飛ばした記録の文", R.skippedNote(["a", "b"]), "ITANDI のタブが開いていない PC のため ITANDI は飛ばした（2件）");
  eq("飛ばしていなければ null", R.skippedNote([]), null);
}

console.log("\n■ siteGapMs / customerGapMs（人の動きのような間）");
{
  eq("サイトの間: ふだんの一番短い", R.siteGapMs(seq([0.5, 0])), 8000);
  eq("サイトの間: ふだんの一番長い", R.siteGapMs(seq([0.5, 0.999999])), 28000);
  eq("サイトの間: 一息の一番短い", R.siteGapMs(seq([0.01, 0])), 40000);
  eq("サイトの間: 一息の一番長い", R.siteGapMs(seq([0.01, 0.999999])), 95000);
  eq("お客様の間: ふだん 15〜60秒", [R.customerGapMs(seq([0.9, 0])), R.customerGapMs(seq([0.9, 0.999999]))], [15000, 60000]);
  eq("お客様の間: 一息 90〜200秒", [R.customerGapMs(seq([0.05, 0])), R.customerGapMs(seq([0.05, 0.999999]))], [90000, 200000]);
  ok("旧の 3〜8秒より長い（人が次のお客様を開いて見る間）", R.customerGapMs(seq([0.9, 0])) > 8000);
}

console.log("\n■ 配線（background・popup・underbar・bulk-dl・itandi-bulk-dl・manifest）");
{
  const bg = read("background.js");
  ok("background が auto-run.js を import", /import "\.\/auto-run\.js";/.test(bg));
  ok("自動便は planSites でサイトを決める（お客様ごと）", /_AR\.planSites\(sites, \{ isAuto: true, hasItandiTab: _AR\.hasItandiTab\(await chrome\.tabs\.query\(\{\}\)\) \}\)/.test(bg));
  ok("サイトの間は siteGapMs（2つ目のサイトから・自動便だけ）", /if \(j > 0 && autoSched && _AR\) \{\s*var _siteGap = _AR\.siteGapMs\(\);/.test(bg));
  ok("お客様の間は自動便だけ customerGapMs", /\(autoSched && _AR\) \? _AR\.customerGapMs\(\) : 3000 \+ Math\.floor\(Math\.random\(\) \* 5000\)/.test(bg));
  ok("お客様×サイトごとに storage へ指定を置く", /_arSet\[_AR\.STORAGE_KEY\] = _AR\.record\(effectiveCustomer\.id, batchSite, _autoOpts, Date\.now\(\)\)/.test(bg));
  ok("コマンドの終わりに指定を消す（finally）", /finally \{[\s\S]{0,400}chrome\.storage\.local\.remove\(self\.AxlxAutoRun\.STORAGE_KEY\)/.test(bg));
  ok("全部失敗の判定は実際に回した数で（飛ばした ITANDI を失敗と数えない）", /var totalAttempts = _siteAttempts;/.test(bg));
  ok("switch-customer に autoRun（リアプロ・ITANDI の2か所）", (bg.match(/autoRun:\s+_autoRunMsg/g) || []).length === 2);
  ok("長い一括でロックの15分を超えないよう、お客様ごとに印を新しくする", /batchRunning: \{ running: true, startedAt: Date\.now\(\) \} \}\); \} catch \(_\) \{\}\s*\/\/ 自動便: ITANDI/.test(bg));
  const ub = read("underbar.js");
  ok("underbar が autoRun を popup へ渡す", /autoRun: msg\.autoRun \|\| null/.test(ub));
  const pp = read("popup.js");
  ok("popup: 2つの受け口で押す前に載せ、押した直後に戻す", (pp.match(/_applyAutoRunToForm\(aBtn, /g) || []).length === 2 && (pp.match(/_restoreAutoRun\(_arUndo[PR]\);/g) || []).length === 2);
  ok("popup: 更新日の欄は値を入れるだけ（change を出さない＝DB に書かない）", /undo\.prevDays = el\.value; el\.value = String\(ar\.rp_update_days\);/.test(pp) && !/_applyAutoRunToForm[\s\S]{0,900}dispatchEvent/.test(pp.slice(pp.indexOf("function _applyAutoRunToForm"), pp.indexOf("function _restoreAutoRun"))));
  ok("popup: リアプロの条件に sort_order・max_pages（自動便だけ）", /sort_order: _autoSort,\s*max_pages: _autoMaxPages,/.test(pp));
  ok("popup: ITANDI の条件に sort_order・max_pages", /sort_order: _autoSort_it,\s*max_pages: _autoMaxPages_it,/.test(pp));
  ok("popup: dataset は await より前に読む", /const _autoSort = autofillBtn\.dataset\.auto_sort \|\| null;/.test(pp) && /const _autoSort_it = autofillBtn\.dataset\.auto_sort \|\| null;/.test(pp));
  const bd = read("bulk-dl.js");
  ok("bulk-dl: 午後の便（更新順）は AD 高い順へ並べ替えない", /if \(!isAdDesc && _adSortOk\) \{/.test(bd));
  ok("bulk-dl: ページ上限は conditions → 自動便の指定 → 3", /\(_AR\(\) \? _AR\(\)\.pageLimit\(_arOpts, null\) : null\) \|\| 3;/.test(bd));
  ok("bulk-dl: 指定は realnetpro の物だけ読む", /forCustomer\(_autoRunStored, customerId, "realnetpro", Date\.now\(\)\)/.test(bd));
  const ib = read("itandi-bulk-dl.js");
  ok("itandi-bulk-dl: 自動便のページ上限で次へ（手動は全ページのまま）", /if \(_itLimit && _itAuditRes && _itAuditRes\.pages >= _itLimit && !_manual\) \{/.test(ib));
  ok("itandi-bulk-dl: 上限で止めた時も完了の合図（audit 付き・page_limit）", /_itAuditResult\(\{ page_limit: _itLimit \}\)/.test(ib));
  ok("itandi-bulk-dl: 指定は itandi の物だけ読む", /forCustomer\(_autoRunStored, customerId, "itandi", Date\.now\(\)\)/.test(ib));
  const mf = JSON.parse(read("manifest.json"));
  eq("manifest の版", mf.version, "2.5.37");
  const cs = mf.content_scripts.map((c) => c.js.join(","));
  ok("リアプロの bulk-dl より前に auto-run.js", cs.includes("send-pairing.js,auto-run.js,bulk-dl.js"));
  ok("ITANDI の itandi-bulk-dl より前に auto-run.js", cs.includes("send-pairing.js,auto-run.js,itandi-row-parse.js,itandi-bulk-dl.js"));
  ok("auto-run.js は _ で始まらない", !fs.readdirSync(EXT).some((f) => f.startsWith("_")));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
