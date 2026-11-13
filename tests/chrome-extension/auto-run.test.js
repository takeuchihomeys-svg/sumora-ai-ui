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
const read = (f) => fs.readFileSync(path.join(EXT, f), "utf8").replace(/\r\n/g, "\n");
function seq(values) { let i = 0; return () => values[i++ % values.length]; }
// 決まった乱数（再現できるように）
function seeded(seed) { let s = seed >>> 0; return function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

console.log("\n■ optsFromPayload（自動便の指定）");
{
  const pm = { source: "auto_schedule", mode: "pm", rp_update_days: 1, sort: "updated", max_pages: 1, is_wide: false };
  const am = { source: "auto_schedule", mode: "am", rp_update_days: 3, sort: "ad", max_pages: 3, is_wide: true };
  eq("午後の便: 更新日1・更新順・1ページ", R.optsFromPayload(pm), { mode: "pm", rp_update_days: 1, rp_update_days_none: false, itandi_update_days: null, sort: "updated", max_pages: 1 });
  eq("午前の便: 更新日は上書きしない（popup が手で決めた値→前回出した日から）・AD・3ページ", R.optsFromPayload(am), { mode: "am", rp_update_days: null, rp_update_days_none: false, itandi_update_days: null, sort: "ad", max_pages: 3 });
  eq("web_brain は null（今までどおり）", R.optsFromPayload({ source: "web_brain", rp_update_days: 3 }), null);
  eq("手動（payload なし）は null", R.optsFromPayload(null), null);
  eq("変な値は null に", R.optsFromPayload({ source: "auto_schedule", mode: "pm", rp_update_days: "x", sort: "zzz", max_pages: -1 }), { mode: "pm", rp_update_days: null, rp_update_days_none: false, itandi_update_days: null, sort: null, max_pages: null });
}

console.log("\n■ record / forCustomer（storage の印）");
{
  const o = R.optsFromPayload({ source: "auto_schedule", mode: "pm", rp_update_days: 1, sort: "updated", max_pages: 1 });
  const st = R.record("c1", "itandi", o, 1000);
  eq("同じお客様・同じサイト → 指定（v2.5.43 前回の検索の時刻 last_search_at も・置いていなければ null）", R.forCustomer(st, "c1", "itandi", 2000), { mode: "pm", rp_update_days: 1, itandi_update_days: null, sort: "updated", max_pages: 1, last_search_at: null });
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
  // 2026-11-10 人間的な動き: 一様乱数 → 対数正規（範囲は今までと同じ・中央値寄りに集まる・たまに伸びる）。
  //   端の値は「範囲の中に必ず収まること」で確かめ、分布は中央値とばらつきで見る
  const within = (v, lo, hi) => v >= lo && v <= hi;
  const sampleGap = (fn, n, seed) => { const rng = seeded(seed); const xs = []; for (let i = 0; i < n; i++) xs.push(fn(rng)); return xs; };
  const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

  // humanChance は「揺らし(q=rng())→判定(rng())」の順に2つ使う。seq で一息を引く時は q を小さく（p を下げて起きやすく）する
  ok("サイトの間: 一息は 40〜95秒の中", within(R.siteGapMs(seq([0.5, 0.5])), 8000, 28000), R.siteGapMs(seq([0.5, 0.5])));
  ok("サイトの間: 一息の幅（乱数で必ず起きる時）は 40〜95秒の中", within(R.siteGapMs(seq([0.5, 0.0, 0.5])), 40000, 95000), R.siteGapMs(seq([0.5, 0.0, 0.5])));
  ok("お客様の間: ふだんは 15〜60秒の中", within(R.customerGapMs(seq([0.9, 0.5])), 15000, 60000), R.customerGapMs(seq([0.9, 0.5])));
  ok("お客様の間: 一息の幅（乱数で必ず起きる時）は 90〜200秒の中", within(R.customerGapMs(seq([0.5, 0.0, 0.5])), 90000, 200000), R.customerGapMs(seq([0.5, 0.0, 0.5])));

  // 500回ずつ: 必ず範囲の中・同じ値が続かない・中央値寄り（右に裾）
  for (const [name, fn, lo, hi] of [["サイトの間", R.siteGapMs, 8000, 95000], ["お客様の間", R.customerGapMs, 15000, 200000]]) {
    const xs = sampleGap(fn, 500, lo + hi);
    ok(`${name}: 500回とも範囲の中（${Math.min(...xs)}〜${Math.max(...xs)}）`, xs.every((v) => within(v, lo, hi)));
    ok(`${name}: 同じ値が続かない（12回で12通り以上）`, new Set(xs.slice(0, 12)).size >= 10, new Set(xs.slice(0, 12)).size);
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    ok(`${name}: 平均 > 中央値（たまに長く伸びる形）`, mean > med(xs) * 0.98, { mean: Math.round(mean), med: med(xs) });
  }
  ok("旧の 3〜8秒より長い（人が次のお客様を開いて見る間）", R.customerGapMs(seq([0.9, 0.5])) > 8000);

  // logBetween / humanChance（純関数）
  eq("logBetween: 端は必ず範囲の中", [R.logBetween(1000, 2000, () => 0) >= 1000, R.logBetween(1000, 2000, () => 0.999999) <= 2000], [true, true]);
  eq("logBetween: 同じ幅なら同じ値", R.logBetween(5000, 5000), 5000);
  eq("humanChance: 乱数 0 は必ず起きる", R.humanChance(() => 0, 0.14), true);
  eq("humanChance: 乱数 0.999999 は起きない", R.humanChance(() => 0.999999, 0.14), false);
  {
    const rng = seeded(5); let hits = 0; const N = 20000;
    for (let i = 0; i < N; i++) if (R.humanChance(rng, 0.14)) hits++;
    const rate = hits / N;
    ok(`humanChance: 0.14 の前後で起きる（${(rate * 100).toFixed(1)}%）`, rate > 0.10 && rate < 0.18, rate);
  }
}

console.log("\n■ 配線（background・popup・underbar・bulk-dl・itandi-bulk-dl・manifest）");
{
  const bg = read("background.js");
  ok("background が auto-run.js を import", /import "\.\/auto-run\.js";/.test(bg));
  ok("自動便は planSites でサイトを決める（お客様ごと）", /_AR\.planSites\(sites, \{ isAuto: true, hasItandiTab: _AR\.hasItandiTab\(await chrome\.tabs\.query\(\{\}\)\) \}\)/.test(bg));
  // 2026-09-30 v2.5.42: AIXツールの一括検索（1人にリアプロ＋itandi）も同じ人の間（自動便だけではない）
  ok("サイトの間は siteGapMs（2つ目のサイトから・一括の回すべて・順の回・見張りが止めたサイトの前は置かない）", /if \(j > 0 && _AR && !_stopApplies\) \{\s*var _siteGap = _AR\.siteGapMs\(\);/.test(bg));
  ok("お客様の間は自動便だけ customerGapMs", /\(autoSched && _AR\) \? _AR\.customerGapMs\(\) : 3000 \+ Math\.floor\(Math\.random\(\) \* 5000\)/.test(bg));
  ok("お客様×サイトごとに storage へ指定を置く（v2.5.43 by_site に並べる・前回の検索の時刻も）", /_arMem = _AR\.withSite\(_arMem, _AR\.record\(effectiveCustomer\.id, batchSite, _arOptsNow, Date\.now\(\), \{ last_search_at: _uoLast \}\)\);\s*var _arSet = \{\}; _arSet\[_AR\.STORAGE_KEY\] = _arMem;/.test(bg));
  ok("コマンドの終わりに指定を消す（finally）", /finally \{[\s\S]{0,400}chrome\.storage\.local\.remove\(self\.AxlxAutoRun\.STORAGE_KEY\)/.test(bg));
  ok("全部失敗の判定は実際に回した数で（飛ばした ITANDI を失敗と数えない）", /var totalAttempts = _siteAttempts;/.test(bg));
  ok("switch-customer に autoRun（リアプロ・ITANDI の2か所）", (bg.match(/autoRun:\s+_autoRunMsg/g) || []).length === 2);
  ok("長い一括でロックの15分を超えないよう、お客様ごとに印を新しくする", /batchRunning: \{ running: true, startedAt: Date\.now\(\) \} \}\); \} catch \(_\) \{\}\s*\/\/ 自動便: ITANDI/.test(bg));
  const ub = read("underbar.js");
  ok("underbar が autoRun を popup へ渡す", /autoRun: msg\.autoRun \|\| null/.test(ub));
  const pp = read("popup.js");
  // v2.5.48: 受け口は1本（_openAndClickAutofill）。押す前に載せ、押した直後に戻す
  ok("popup: 押す前に載せ、押した直後に戻す（受け口は1本）", (pp.match(/_applyAutoRunToForm\(aBtn, d\.autoRun\)/g) || []).length === 1 && /aBtn\.click\(\);[\s\S]{0,400}if \(o\.autoRun\) _restoreAutoRun\(arUndo\);/.test(pp) && /function _runSwitchCustomer\(d\) \{[\s\S]{0,500}?return _openAndClickAutofill\(d, \{ via: "switch-customer"[^}]*autoRun: true/.test(pp));
  ok("popup: 更新日の欄は値を入れるだけ（change を出さない＝DB に書かない）", /undo\.prevDays = el\.value; el\.value = ar\.rp_update_days \? String\(ar\.rp_update_days\) : "";/.test(pp) && !/_applyAutoRunToForm[\s\S]{0,900}dispatchEvent/.test(pp.slice(pp.indexOf("function _applyAutoRunToForm"), pp.indexOf("function _restoreAutoRun"))));
  ok("popup: リアプロの条件に sort_order・max_pages（自動便だけ）", /sort_order: _autoSort,\s*max_pages: _autoMaxPages,/.test(pp));
  ok("popup: ITANDI の条件に sort_order・max_pages", /sort_order: _autoSort_it,\s*max_pages: _autoMaxPages_it,/.test(pp));
  ok("popup: dataset は await より前に読む", /const _autoSort = autofillBtn\.dataset\.auto_sort \|\| null;/.test(pp) && /const _autoSort_it = autofillBtn\.dataset\.auto_sort \|\| null;/.test(pp));
  const bd = read("bulk-dl.js");
  // 2026-11-11 竹内さん「AD順などするときにページ更新してしまっている。ページ更新すると拡張ツールの検索のところが
//   閉じてしまうのにそのまま物件取得にうつってしまうので全物件が対象となってしまう」:
//   旧は `location.href = _adLink.href`（条件が消える）だった。今は**条件を残したまま**並び替える。
ok("bulk-dl: 自動の押下の前に AD 高い順へ並べ替える（メニューを人の順に操作）", /function autoPressPdfs\(\)[\s\S]{0,3400}_sortByAdLikeHuman/.test(bd) && /③ 高→低 を押します/.test(bd));
ok("bulk-dl: AD順のためにページを読み込み直さない（全物件にならない）", !/location\.href = _adLink\.href;/.test(bd));
ok("bulk-dl: 並べ替えの後で押し始める（_autoPdfRunPending）", /_autoPdfRunPending = function \(\) \{\s*\n\s*try \{ _rescanRows\(\); \} catch \(_\) \{\}\s*\n\s*_startAutoPressRun\(\);/.test(bd));
  ok("bulk-dl: 午後の便（更新順）は並べ替えない（allowAdSort）", /_AR\(\)\.allowAdSort\(_arOpts\)/.test(bd) && /更新順の指定 → AD へ並べ替えずに押します/.test(bd));
  ok("bulk-dl: 既に AD 高い順なら並べ替えない", /_isAdDesc/.test(bd));
  // 2026-09-30 v2.5.42 竹内「ページの上限は 5 ページまで上げる」: 既定は auto-run.js DEFAULT_MAX_PAGES（5）・読めない時も 5
  ok("bulk-dl: ページ上限は conditions → 自動便の指定 → 既定 5", /\(_AR\(\) \? _AR\(\)\.pageLimit\(_arOpts, null\) : null\) \|\| \(_AR\(\) && _AR\(\)\.DEFAULT_MAX_PAGES\) \|\| 5;/.test(bd));
  ok("bulk-dl: 指定は realnetpro の物だけ読む", /forCustomer\(_autoRunStored, customerId, "realnetpro", Date\.now\(\)\)/.test(bd));
  const ib = read("itandi-bulk-dl.js");
  ok("itandi-bulk-dl: 自動便のページ上限で次へ（手動は全ページのまま）", /if \(_itLimit && _itAuditRes && _itAuditRes\.pages >= _itLimit && !_manual\) \{/.test(ib));
  ok("itandi-bulk-dl: 上限で止めた時も完了の合図（audit 付き・page_limit）", /_itAuditResult\(\{ page_limit: _itLimit \}\)/.test(ib));
  ok("itandi-bulk-dl: 指定は itandi の物だけ読む", /forCustomer\(_autoRunStored, customerId, "itandi", Date\.now\(\)\)/.test(ib));
  const mf = JSON.parse(read("manifest.json"));
  eq("manifest の版", mf.version, "2.7.17");
  const cs = mf.content_scripts.map((c) => c.js.join(","));
  ok("リアプロの bulk-dl より前に auto-run.js（v2.5.41 sent-skip.js も）", cs.includes("bar-dock.js,send-pairing.js,auto-run.js,autorun-note.js,sent-skip.js,update-order-stop.js,bulk-dl.js"));
  ok("ITANDI の itandi-bulk-dl より前に auto-run.js（v2.5.41 sent-skip.js・v2.5.42 itandi-guard.js も）", cs.includes("bar-dock.js,send-pairing.js,auto-run.js,autorun-note.js,sent-skip.js,itandi-row-parse.js,itandi-guard.js,update-order-stop.js,itandi-bulk-dl.js"));
  ok("auto-run.js は _ で始まらない", !fs.readdirSync(EXT).some((f) => f.startsWith("_")));
}

console.log("\n■ 勤務時間のゲート（2026-11-10 自動モード・JST 9〜21時・12〜13時は休憩・土日なし）");
{
  // JST の時刻を作る（UTC+9）。2026-11-10 は火曜
  const J = (y, m, d, hh, mm) => Date.UTC(y, m - 1, d, hh - 9, mm, 0);
  eq("平日 9:00 → 開く", R.workGate(J(2026, 11, 10, 9, 0)).open, true);
  eq("平日 8:59 → まだ（resumeAt は 9:00）", R.workGate(J(2026, 11, 10, 8, 59)), { open: false, reason: "before_open", resumeAt: J(2026, 11, 10, 9, 0) });
  eq("平日 11:59 → 開く", R.workGate(J(2026, 11, 10, 11, 59)).open, true);
  eq("平日 12:00 → 昼の休憩（resumeAt は 13:00）", R.workGate(J(2026, 11, 10, 12, 0)), { open: false, reason: "lunch", resumeAt: J(2026, 11, 10, 13, 0) });
  eq("平日 12:45 → 休憩のまま", R.workGate(J(2026, 11, 10, 12, 45)).reason, "lunch");
  eq("平日 13:00 → 開く", R.workGate(J(2026, 11, 10, 13, 0)).open, true);
  eq("平日 20:59 → 開く", R.workGate(J(2026, 11, 10, 20, 59)).open, true);
  // 2026-11-10 v2.6.33 竹内さん「作業23時でよい」: 終わりは 23時（翌3時まで延ばす案は採らない）
eq("平日 23:00 → 終わり（次の日の 9:00）", R.workGate(J(2026, 11, 10, 23, 0)), { open: false, reason: "after_close", resumeAt: J(2026, 11, 11, 9, 0) });
eq("平日 21:30 → まだ動く（23時に延ばした）", R.workGate(J(2026, 11, 10, 21, 30)), { open: true, reason: null, resumeAt: null });
eq("金曜 23:30 → 月曜の 9:00", R.workGate(J(2026, 11, 13, 23, 30)), { open: false, reason: "after_close", resumeAt: J(2026, 11, 16, 9, 0) });
  eq("土曜 10:00 → 動かない", R.workGate(J(2026, 11, 14, 10, 0)), { open: false, reason: "weekend", resumeAt: null });
  eq("日曜 15:00 → 動かない", R.workGate(J(2026, 11, 15, 15, 0)).reason, "weekend");
  eq("月曜 9:01 → 開く", R.workGate(J(2026, 11, 16, 9, 1)).open, true);
  eq("JST の曜日（火曜=2）", R.jstParts(J(2026, 11, 10, 12, 0)).day, 2);
  eq("90分続いたら小休憩の合図", R.continuousRestDue(Date.now() - 91 * 60 * 1000, Date.now()), true);
  eq("89分では小休憩にしない", R.continuousRestDue(Date.now() - 89 * 60 * 1000, Date.now()), false);
  eq("始めた時刻が無ければ小休憩にしない", R.continuousRestDue(0, Date.now()), false);
}

console.log("\n■ ITANDI の更新日（payload.itandi_update_days → 読む側の rp_update_days の位置へ）");
{
  eq("ITANDI の時は itandi_update_days を rp_update_days に写す", R.optsForSite({ rp_update_days: 7, itandi_update_days: 3 }, "itandi").rp_update_days, 3);
  eq("リアプロの時は写さない", R.optsForSite({ rp_update_days: 7, itandi_update_days: 3 }, "realnetpro").rp_update_days, 7);
  eq("itandi_update_days が無ければリアプロの値に落とす（今まで通り）", R.optsForSite({ rp_update_days: 7 }, "itandi").rp_update_days, 7);
  eq("印を残す（どのサイトの値か）", R.optsForSite({ rp_update_days: 7, itandi_update_days: 3 }, "itandi")._site_update_days, "itandi");
  eq("計画の itandi_days を _update_days_itandi に写す", R.payloadForCustomer({ update_days_plan: { by_customer: { c1: { days: 7, itandi_days: 3, last_search_at: null } } } }, "c1", 1000).itandi_update_days, 3);
  eq("計画の itandi_days が無ければ itandi_update_days を消す（ITANDI だけ狭くならないように）", "itandi_update_days" in R.payloadForCustomer({ itandi_update_days: 9, update_days_plan: { by_customer: { c1: { days: 7 } } } }, "c1", 1000), false);
  eq("自動便の opts に ITANDI の更新日が載る", R.optsFromPayload({ source: "auto_schedule", mode: "am", itandi_update_days: 5 }).itandi_update_days, 5);
  eq("storage の record に持ち回る", R.forCustomer(R.record("c1", "itandi", { mode: "am", rp_update_days: 7, itandi_update_days: 5 }, 1000), "c1", "itandi", 2000).itandi_update_days, 5);
  eq("record の値も ITANDI の時は rp の位置へ", R.optsForSiteRecord({ rp_update_days: 7, itandi_update_days: 5 }, "itandi").rp_update_days, 5);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
