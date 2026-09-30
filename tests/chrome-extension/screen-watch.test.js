// 実行: node tests/chrome-extension/screen-watch.test.js
// 2026-09-29 見張り（拡張の配線）: 竹内「拡張ツールでひらいているページの画面をみて判断できる事もできるのか？ …画面開いているのも目で見ることができるのが理想」
//   ・C1（fill-done の後）・C2（約4秒後のページの文字）はブレインモードの回（点検の記録がある回）だけ・待たない
//   ・見張りの経路に再読み込み・クリック・タブの移動・スクリプトの差し込みが無い（サイトへのアクセスは増やさない）
//   ・サーバーの stop_site の時だけ、一括の繰り返しは次のお客様の境目でそのサイトを見送る（1人ずつの失敗の知らせは出さない）
//   ・写真は拡張の要素（帯）を塗ってから JPEG にする
const fs = require("fs");
const path = require("path");
let pass = 0, fail = 0;
function ok(name, c, extra) { c ? pass++ : fail++; console.log((c ? "  ✓ " : "  ✗ ") + name + (c || extra === undefined ? "" : "\n      " + JSON.stringify(extra).slice(0, 300))); }
const EXT = path.join(__dirname, "../../chrome-extension");
const read = (f) => fs.readFileSync(path.join(EXT, f), "utf8").replace(/\r\n/g, "\n");
const bg = read("background.js");
const between = (a, b) => { const i = bg.indexOf(a); const j = bg.indexOf(b, i + 1); return i >= 0 && j > i ? bg.slice(i, j) : ""; };

console.log("\n■ C1・C2（ブレインモードの時だけ・待たない）");
{
  const onFill = between("async function _auditOnFillDone(msg, sender)", "// bulk-dl.js / itandi-bulk-dl.js の結果を");
  ok("fill-done の受け口が sender を渡す", /if \(msg\.runId\) _auditOnFillDone\(msg, _sender\);/.test(bg));
  ok("見張りは点検の記録に足した後（ブレインでない個別の検索は st.enabled で先に戻る）", onFill.indexOf("if (!st.enabled) return;") > 0 && onFill.indexOf("_watchAfterFill(msg, run, sender);") > onFill.indexOf("_auditTracker.attachFill("));
  ok("_watchAfterFill は await しない", !/await _watchAfterFill/.test(bg));
  const af = between("function _watchAfterFill(msg, run, sender)", "// 1回の検索が失敗した時");
  ok("C1 は待たずに送る・C2 は約4秒後（setTimeout）", /\n\s+_watchCheckpoint\("filled"/.test(af) && /setTimeout\(function \(\) \{ _watchCheckpoint\("results"/.test(af) && /var WATCH_RESULTS_DELAY_MS = 4000;/.test(bg));
  ok("C2 はページの失敗の時は送らない（失敗は一括の catch が聞く）", /if \(tabId != null && !err\)/.test(af));
  const cp = between("async function _watchCheckpoint(checkpoint, ctx)", "// fill-done の後（C1 はすぐ");
  ok("送り先は /api/screen-watch・8秒で切る・失敗は握って null（検索を止めない）", /\/api\/screen-watch"/.test(cp) && /AbortSignal\.timeout\(ctx\.timeoutMs \|\| 8000\)/.test(cp) && /catch \(e\) \{\n\s+console\.warn\("\[watch\] 見張りに送れなかった（検索は続ける）/.test(cp));
  ok("止める印はサーバーの stop_site だけ（watchStopFrom）", /var stop = SC\.watchStopFrom\(json, Date\.now\(\)\);/.test(cp) && (bg.match(/_watchStop = stop;/g) || []).length === 1);
}

console.log("\n■ 見張りは サイトに触らない（再読み込み・クリック・タブの移動が無い）");
{
  const block = between("// ── 見張り（2026-09-29 竹内", "async function _snapDom(tabId)");
  ok("見張りのかたまりがある", block.length > 500);
  ok("reload・click・tabs.update・executeScript・tabs.create が無い", !/reload|\.click\(|tabs\.update|executeScript|tabs\.create|location\.href\s*=/.test(block), block.match(/reload|\.click\(|tabs\.update|executeScript|tabs\.create/g));
  ok("ページの文字は content script の受け口（_snapDom）で読むだけ", /_snapDom\(ctx\.tabId\)/.test(block));
}

console.log("\n■ 次のお客様の境目で見送る（一括・手動の一括）");
{
  const rb = between("async function _runBatchSearch(command)", "function _recordBulkSearch(customer, site, isWide)");
  ok("一括: 回の始めに止める印を消す（前の回を持ち越さない）", /_batchShouldStop = false; \/\/ Fix 2[^\n]*\n[^\n]*batchStopRequested: false \}\);\n[^\n]*\n\s+_watchStop = null;\n\s+_watchSkipped = \[\];/.test(rb));
  const iSkip = rb.indexOf("if (_watchSkipSite(customer, batchSite)) continue;");
  ok("一括: サイトの繰り返しの頭（点検の記録・入力より前）で見送る", iSkip > 0 && iSkip < rb.indexOf("var _batchAudit = await _auditBegin(") && iSkip > rb.indexOf("var batchSite = custSites[j];"));
  ok("一括: 失敗した時は画面を見張りに聞いてから（最長8秒）", /if \(_batchAudit\) await _watchOnPassError\(batchSite, effectiveCustomer\.id, command\.id, _batchAudit\.runId, e\);/.test(rb));
  ok("一括: 見張りが止めたサイトの失敗は1人ずつ知らせない", /if \(!_isMultiPass && self\.AxlxBatchGuard && !_watchStopped\) \{/.test(rb));
  ok("一括: 見送ったお客様は命令の記録に残す（失敗にしない）", /if \(_watchSkipped\.length\) doneUpdates\.error_message = /.test(rb));
  const mb = between('if (msg.type === "axlx-manual-bulk-search")', '[manual-bulk-search] ✔ 完了');
  ok("手動の一括: 始めに消す・境目で見送る・失敗は聞いてから・知らせは見張りの1通", /_watchStop = null;/.test(mb) && /if \(_watchSkipSite\(_bc, _bulkSite\)\) continue;/.test(mb) && /await _watchOnPassError\(_bulkSite/.test(mb) && /watchStopApplies\(_watchStop, _bulkSite, Date\.now\(\)\)\) continue;/.test(mb));
}

console.log("\n■ 写真は帯を塗ってから JPEG");
{
  const sh = between("async function _snapShrink(dataUrl, dom)", "async function _takeSnapshot(trigger, ctx)");
  const iDraw = sh.indexOf("ctx2d.drawImage("), iFill = sh.indexOf("ctx2d.fillRect("), iJpeg = sh.indexOf("convertToBlob(");
  ok("drawImage → fillRect（塗る）→ convertToBlob（JPEG）の順", iDraw > 0 && iFill > iDraw && iJpeg > iFill, { iDraw, iFill, iJpeg });
  ok("塗る位置は snapshot-core.maskRectsScaled", /SC\.maskRectsScaled\(dom && dom\.mask_rects, dom && dom\.viewport, sz\.w, sz\.h\)/.test(sh));
  const ts = between("async function _takeSnapshot(trigger, ctx)", "// 1分ごと: 止まりの見張り");
  ok("撮る時はそのタブの文字（塗る位置）を渡す・塗れたかを残す（mask_applied）", /_snapShrink\(dataUrl, to\.dom\)/.test(ts) && /to\.mask_applied = /.test(ts));
  ok("塗る位置・画面の大きさはサーバーに送らない", /delete tabsOut\[mr\]\.dom\.mask_rects;/.test(ts));
}

console.log("\n■ その他");
{
  ok("search-audit.js: 駅の名前だけ 300 まで", /STATION_NAMES_MAX = 300/.test(read("search-audit.js")));
  const mf = JSON.parse(read("manifest.json"));
  ok("manifest の版は 2.5.41 以上（v2.5.41 で更新日の見張り・送付済みの部屋を選ばない・v2.5.42 で ITANDI の見分け）", mf.version.split(".").map(Number).reduce((a, n) => a * 1000 + n, 0) >= 2005041);
  ok("拡張の中に「_」で始まるファイルを置いていない", !fs.readdirSync(EXT).some((f) => f.startsWith("_")));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
