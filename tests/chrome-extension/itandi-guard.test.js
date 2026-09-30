// 実行: node tests/chrome-extension/itandi-guard.test.js
// 2026-09-30 v2.5.42 竹内「ITANDI も一回での上限を作る。物件数で」「ITANDI で条件指定ちゃんとできていなければ件数多すぎるバグ（3000件以上の表示など）…
//   ITANDI 検索ちゃんとできていなければ、そこ修正するか、修正効かなければ拡張ツールの部分が問題なのか ITANDI への登録がちゃんと入らなかったのか」
//   ITANDI の1回の物件数の上限・条件が効いていない検索の見分け（itandi-guard.js）と配線（itandi-bulk-dl・background）を固定する。サイトには触らない。
//   行の値は本番の property_candidate_pools（2026-09-28 02:37 の 126件の回＝日本橋1.2丁目・1LDK のお客様で 1K が 33/40）の形
const fs = require("fs");
const path = require("path");
const G = require("../../chrome-extension/itandi-guard.js");
let pass = 0, fail = 0;
function eq(name, a, b) { const ok = JSON.stringify(a) === JSON.stringify(b); ok ? pass++ : fail++; console.log((ok ? "  ✓ " : "  ✗ ") + name + (ok ? "" : `\n      expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`)); }
function ok(name, c) { eq(name, !!c, true); }
const EXT = path.join(__dirname, "../../chrome-extension");
const read = (f) => fs.readFileSync(path.join(EXT, f), "utf8").replace(/\r\n/g, "\n");

console.log("\n■ 上限の値（本番の分布: 116回・中央値 2・p95 17・上位 126, 45, 41 → 50 なら普段は切れず 126 だけ切れる）");
{
  eq("MAX_ROWS は 50", G.MAX_ROWS, 50);
  ok("普段の回（45件）は切れない", G.capForPage(0, 45, G.MAX_ROWS) === 45);
  eq("126件の回: 1ページ目 40 → 40・2ページ目 40 → 10・3ページ目 → 0", [G.capForPage(0, 40), G.capForPage(40, 40), G.capForPage(80, 40)], [40, 10, 0]);
  eq("上限は引数でも渡せる", G.capForPage(3, 10, 5), 2);
  eq("COUNT_MAX は見張りの countAbsMax と同じ 3,000", G.COUNT_MAX, 3000);
}

console.log("\n■ 件数の文字（ITANDI の出し方は未確認＝広く読む・拡張の帯は読まない）");
{
  eq("「3,000件以上」→ 3000・over", G.readCount("検索結果\n3,000件以上\n"), { number: 3000, text: "3,000件以上", over: true });
  eq("「検索結果 1,234件」", G.readCount("何か\n検索結果 1,234件\n").number, 1234);
  eq("「1,234件中 1〜20件」", G.readCount("1,234件中 1〜20件を表示").number, 1234);
  eq("拡張の帯「12件を選択中」は読まない", G.readCount("12件を選択中\n全ページ送信"), { number: null, text: null, over: false });
  eq("読めなければ null", G.readCount("ITANDI BB\n物件資料").number, null);
  eq("全角も読む", G.readCount("該当 ３，２００件").number, 3200);
}

console.log("\n■ 間取り・家賃・区の読み");
{
  eq("間取りの札", ["1K", "１ＬＤＫ", "ワンルーム", "2SLDK", "1R", "2D"].map(G.layoutKey), ["1K", "1LDK", "1R", "2LDK", "1R", ""]);
  eq("希望の間取り「1K、1DK、1LDK」", G.wantLayouts("1K、1DK、1LDK"), ["1K", "1DK", "1LDK"]);
  eq("「２K　2DK 2LDK」（全角・空白）", G.wantLayouts("２K　2DK 2LDK"), ["2K", "2DK", "2LDK"]);
  eq("「1LDK以上」は見ない（null）", G.wantLayouts("1LDK以上"), null);
  eq("「1LDK・2D」の打ち間違いは見ない（迷ったら止めない）", G.wantLayouts("1LDK・2D"), null);
  eq("空は null", G.wantLayouts(""), null);
  eq("家賃の上限: 80000 円・8.5 万", [G.rentMaxYen(80000), G.rentMaxYen(8.5), G.rentMaxYen(null)], [80000, 85000, null]);
  eq("区（ward の時だけ）「大阪市北区、大阪市福島区」", G.wantWards("大阪市北区、大阪市福島区", "ward"), ["北区", "阪市福島区"]);
  eq("区: station のお客様は見ない", G.wantWards("浪速区・西区", "station"), null);
  eq("区: 駅だけの希望は null", G.wantWards("淡路駅", "ward"), null);
}

console.log("\n■ 条件が効いていない形（1ページ目の行で決める・迷ったら止めない）");
{
  const cond = { rent_max: 150000, floor_plan: "1LDK", desired_area: "日本橋1.2丁目", area_mode: "ward" };
  const oneK = (n) => Array.from({ length: n }, (_, i) => ({ rentYen: 70000 + i * 1000, layout: "1K", address: "大阪府大阪市淀川区", name: "W-STYLE新大阪Ⅱ", room: String(1301 + i) }));
  const oneLdk = (n) => Array.from({ length: n }, (_, i) => ({ rentYen: 120000, layout: "1LDK", address: "大阪府大阪市中央区日本橋", name: "エスリード", room: String(501 + i) }));
  const r1 = G.evaluate({ rows: [...oneK(33), ...oneLdk(7)], count: null, cond, isWide: false });
  ok("126件の回（1LDK 希望・1K が 33/40）→ 止める", r1.suspect);
  eq("理由は間取り", r1.reasons, ["layout_outside"]);
  eq("数（読めた 40・外 33）", [r1.judged, r1.outside.layout, r1.outside.any], [40, 33, 33]);
  ok("例は5件まで・部屋と理由", r1.samples.length === 5 && /W-STYLE新大阪Ⅱ 1301（1K）/.test(r1.samples[0]));
  const r2 = G.evaluate({ rows: [...oneK(15), ...oneLdk(25)], count: null, cond, isWide: false });
  ok("外が半分未満（15/40）→ 止めない", !r2.suspect);
  const r3 = G.evaluate({ rows: oneK(5), count: null, cond, isWide: false });
  ok("行が 6 未満 → 止めない", !r3.suspect && r3.judged === 5);
  const r4 = G.evaluate({ rows: oneLdk(10), count: { number: 3200, over: true }, cond, isWide: false });
  ok("件数 3,000 超 → 行が合っていても止める（count_over）", r4.suspect && r4.reasons[0] === "count_over" && r4.count === 3200);
  ok("件数 2,999 → 件数では止めない", !G.evaluate({ rows: oneLdk(10), count: { number: 2999 }, cond, isWide: false }).suspect);
  const r5 = G.evaluate({ rows: oneLdk(10).map((x) => ({ ...x, rentYen: 170000 })), count: null, cond, isWide: false });
  ok("家賃が上限の1割超（15万 → 17万）が全部 → 止める（rent_outside）", r5.suspect && r5.reasons.includes("rent_outside"));
  ok("家賃が上限の1割以内（16.4万）は中", !G.evaluate({ rows: oneLdk(10).map((x) => ({ ...x, rentYen: 164000 })), count: null, cond, isWide: false }).suspect);
  const r6 = G.evaluate({ rows: oneLdk(10).map((x) => ({ ...x, rentYen: 190000, layout: "1K" })), count: null, cond, isWide: true });
  ok("広げての回: 間取りは見ない・家賃は1.5倍まで中 → 止めない", !r6.suspect);
  ok("広げての回でも家賃が 1.5倍超（23万）→ 止める", G.evaluate({ rows: oneLdk(10).map((x) => ({ ...x, rentYen: 230000 })), count: null, cond, isWide: true }).suspect);
  const wardCond = { rent_max: 80000, floor_plan: "1K", desired_area: "大阪市浪速区", area_mode: "ward" };
  const r7 = G.evaluate({ rows: oneK(10).map((x) => ({ ...x, address: "大阪府堺市堺区" })), count: null, cond: wardCond, isWide: false });
  ok("区のモードで所在地が全部 堺市 → 止める（area_outside）", r7.suspect && r7.reasons.includes("area_outside"));
  ok("区のモードで浪速区の行 → 中", !G.evaluate({ rows: oneK(10).map((x) => ({ ...x, address: "大阪府大阪市浪速区難波中" })), count: null, cond: wardCond, isWide: false }).suspect);
  ok("駅のモードは所在地を見ない", !G.evaluate({ rows: oneK(10).map((x) => ({ ...x, address: "大阪府堺市堺区" })), count: null, cond: { ...wardCond, area_mode: "station", desired_area: "難波駅" }, isWide: false }).suspect);
  ok("条件が無い（家賃も間取りも無し）→ 何も決めない", !G.evaluate({ rows: oneK(20), count: null, cond: {}, isWide: false }).suspect);
  ok("家賃が読めない行は数えない", G.evaluate({ rows: oneK(10).map((x) => ({ ...x, rentYen: null, layout: null })), count: null, cond, isWide: false }).judged === 0);
  ok("rows が無くても落ちない", !G.evaluate({ rows: null, count: null, cond, isWide: false }).suspect);
}

console.log("\n■ 入れ直しの間・知らせの文");
{
  const seq = (vals) => { let i = 0; return () => vals[i++ % vals.length]; };
  eq("入れ直しの前の間は 9〜22秒", [G.retryGapMs(seq([0])), G.retryGapMs(seq([0.999999]))], [9000, 22000]);
  ok("理由の日本語", G.reasonsJa(["layout_outside", "count_over"]) === "希望に無い間取りが多い・件数が 3,000件を超えている");
  const n = G.skipNotice("YUMA", ["rent_outside"]);
  ok("見送りの1行（名前・理由・資料を取っていない）", /⚠【ITANDI 見送り】YUMAさんのITANDI/.test(n) && /家賃が上限を超える物件が多い/.test(n) && /資料はダウンロードしていません/.test(n));
  ok("名前が無くても文になる", /⚠【ITANDI 見送り】ITANDI の検索/.test(G.skipNotice(null, [])));
}

console.log("\n■ 配線（itandi-bulk-dl・background・manifest）");
{
  const ib = read("itandi-bulk-dl.js");
  ok("itandi-bulk-dl: 1ページ目の資料を開く前に background に見せる（_itPrecheck）", /_itPrecheck\(customerId, _manual, function \(pre\) \{/.test(ib) && ib.indexOf("_itPrecheck(customerId, _manual") < ib.indexOf("_runAllPages(customerName, customerId, customerConditions)"));
  ok("itandi-bulk-dl: 止める答えなら資料を開かず完了の合図（propertyCount null・guard 付き）", /propertyCount: null, audit: _itAuditResult\(\{ guard: pre\.guard \|\| null, guard_stopped: true \}\)/.test(ib));
  ok("itandi-bulk-dl: 手動の送信・答えが無い時は進む", /if \(manual \|\| !G \|\| !tracked\.length\) \{ cb\(\{ action: "proceed" \}\); return; \}/.test(ib) && /cb\(\{ action: "proceed", why: "no_answer" \}\)/.test(ib));
  ok("itandi-bulk-dl: 見せる行は先頭40件（家賃・間取り・所在地・名前・号室）と件数の文字", /tracked\.slice\(0, 40\)\.forEach/.test(ib) && /G\.readCount\(/.test(ib));
  ok("itandi-bulk-dl: 上限を超えた行は選ばない（capForPage・手動は見ない）", /G\.capForPage\(_itPicked, _checkedNow\.length, G\.MAX_ROWS\)/.test(ib) && /if \(G && !_itManualRun\) \{/.test(ib));
  ok("itandi-bulk-dl: 上限で打ち切った時は row_limit を点検に", /_itAuditResult\(\{ row_limit: _rowMax \}\)/.test(ib));
  ok("itandi-bulk-dl: 上限ちょうどで選び終えた時は次のページがある時だけ打ち切りと記録（押さない）", /_itPicked >= _G\(\)\.MAX_ROWS && clickNextPageAvailable\(\)/.test(ib) && /function clickNextPageAvailable\(\)/.test(ib));
  ok("itandi-bulk-dl: ページの上限は自動便の指定 → 既定（DEFAULT_MAX_PAGES）", /pageLimit\(_autoRunFor\(customerId\), _AR\(\)\.DEFAULT_MAX_PAGES \|\| null\)/.test(ib));
  ok("itandi-bulk-dl: 選んだ部屋を点検に残す（picked_rooms・150件まで）", /function _itRememberPicked\(targets\)/.test(ib) && /r\.picked_rooms = base\.picked_rooms\.slice\(0, 150\)/.test(ib));
  const bg = read("background.js");
  ok("background が itandi-guard.js を import", /^import "\.\/itandi-guard\.js";/m.test(bg));
  ok("background: 見分けは一括の回のお客様の条件（_itandiGuardCtx）だけ・別のお客様・手動は進む", /String\(ctx\.customerId\) !== String\(msg\.customerId\)\) \{\s*sendResponse\(\{ action: "proceed"/.test(bg));
  ok("background: ITANDI の回の前に条件を置き、後で消す", /_itandiGuardCtx = \{\s*customerId: String\(effectiveCustomer\.id\), isWide: batchIsWide, attempt: 0/.test(bg) && /_itandiGuardCtx = null;/.test(bg));
  ok("background: 止めたら1回だけ入れ直す（_itandiGuardRetry・見張りの中）", /if \(_scrapeOutcomeFor\("itandi"\)\.guard && _scrapeOutcomeFor\("itandi"\)\.guard\.suspect\) \{\s*_passCount = await _passGuard\.race\(_itandiGuardRetry\(/.test(bg));
  ok("background: 入れ直しの前に人の間（retryGapMs）・1回目の読み戻しを控える", /var gap = G \? G\.retryGapMs\(\)/.test(bg) && /var firstFill = _compactFill\(run && run\.filled\);/.test(bg));
  ok("background: 入れ直しは1回だけ（attempt=1・連続の再試行の loop が無い）", /_itandiGuardCtx\.attempt = 1;/.test(bg) && !/for \([^)]*attempt[^)]*\) \{[\s\S]{0,300}_itandiGuardRetry/.test(bg));
  const retryBody = bg.slice(bg.indexOf("async function _itandiGuardRetry"), bg.indexOf("// ===== END: 自動化バッチ検索 ====="));
  ok("background: 直らなければ ★物件出し★（pickup_group_id）に1行・売上番長（group_id）には送らない", retryBody.includes("G.skipNotice(name,") && retryBody.includes('group_key: "pickup_group_id"') && !retryBody.includes('group_key: "group_id"'));
  ok("background: 結果（guard・first_fill・retry.fixed）を点検に足す", /_auditTracker\.attachResult\(runId, \{ guard: rec, guard_stopped: !fixed \}\)/.test(bg));
  ok("background: 待ち手に guard を渡す（guard_stopped の時だけ）", /guard: \(audit && audit\.guard_stopped && audit\.guard\) \? audit\.guard : null/.test(bg));
  const mf = JSON.parse(read("manifest.json"));
  const cs = mf.content_scripts.map((c) => c.js.join(","));
  ok("manifest: itandi-guard.js は itandi-bulk-dl.js より前", cs.some((c) => /itandi-guard\.js,(?:update-order-stop\.js,)?itandi-bulk-dl\.js/.test(c)));
  ok("manifest の版 2.5.42 以上", mf.version.split(".").map(Number).reduce((a, n) => a * 1000 + n, 0) >= 2005042);
  ok("拡張の中に「_」で始まるファイルを置いていない", !fs.readdirSync(EXT).some((f) => f.startsWith("_")));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
