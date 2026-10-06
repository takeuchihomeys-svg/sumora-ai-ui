// 実行: node tests/chrome-extension/perf-v2572.test.js
// 2026-10-06 v2.5.72 竹内「拡張ツールの光ってるモードがなぜかかなり重い」「黄色のひかりまぶしすぎる」「余計なアナウンス…省く」
//   「スタッフが押して検索しているのに、自動検索のときと同じくらい重い…原因見つけて改善する」
//   ① own-mutation.js（拡張が書いた変化だけかの判定）を偽のノードで確かめる
//   ② 見張りどうしの反応し合い（score-overlay の札の付け直し → 自分の見張り → また付け直し）が止まっているか（ファイルの中身）
//   ③ 光が控えめ（黄色の点滅なし）・吹き出しの文なし・枠は1行ずつ
const fs = require("fs");
const path = require("path");
const dir = path.join(__dirname, "..", "..", "chrome-extension");
const read = (f) => fs.readFileSync(path.join(dir, f), "utf8");
const OM = require(path.join(dir, "own-mutation.js"));

let passed = 0, failed = 0;
function ok(name, cond, extra) { if (cond) { passed++; console.log("  ✓ " + name); } else { failed++; console.log("  ✗ " + name + (extra !== undefined ? "\n      " + JSON.stringify(extra).slice(0, 300) : "")); } }

// 偽のノード（nodeType・id・className・parentNode だけ）
const el = (opts = {}) => ({ nodeType: 1, id: opts.id || "", className: opts.cls || "", parentNode: opts.parent || null });
const text = (parent) => ({ nodeType: 3, parentNode: parent });
const body = el({ id: "" });
const row = el({ cls: "list_row", parent: body });
const pdfBtn = el({ cls: "btn print", parent: row });
const scoreBadge = el({ cls: "axlx-score-badge", parent: row });
const brainBadge = el({ cls: "axlx-brain-badge", parent: row });
const layer = el({ id: "axlx-guide-layer", parent: body });
const glow = el({ cls: "axlx-glow", parent: layer });
const panel = el({ id: "axlx-guide-panel", parent: body });
const panelDiv = el({ parent: panel });
const pageRow = el({ cls: "list_row", parent: body });

console.log("── ① 拡張が書いた変化だけか（own-mutation.js）");
ok("点の札の付け直し（足す＋外す）は拡張の物", OM.onlyOwn([{ type: "childList", target: row, addedNodes: [scoreBadge], removedNodes: [scoreBadge] }]));
ok("案内の光の描き直し（layer の中）は拡張の物", OM.onlyOwn([{ type: "childList", target: layer, addedNodes: [glow], removedNodes: [] }]));
ok("案内の枠の innerHTML（中の素の div・文字）も拡張の物", OM.onlyOwn([{ type: "childList", target: panel, addedNodes: [panelDiv, text(panel)], removedNodes: [] }]));
ok("ページの行が足された → 拡張の物ではない（反応する）", !OM.onlyOwn([{ type: "childList", target: body, addedNodes: [pageRow], removedNodes: [] }]));
ok("拡張の物とページの物が混ざった束 → 反応する", !OM.onlyOwn([{ type: "childList", target: row, addedNodes: [scoreBadge], removedNodes: [] }, { type: "childList", target: body, addedNodes: [pageRow], removedNodes: [] }]));
ok("ページの文字のノードが変わった → 反応する", !OM.onlyOwn([{ type: "childList", target: row, addedNodes: [text(row)], removedNodes: [] }]));
ok("keep に当たる拡張の物（ブレインの下見の札）は反応する", !OM.onlyOwn([{ type: "childList", target: row, addedNodes: [brainBadge], removedNodes: [] }], /^axlx-(cb|brain-badge)$/));
ok("keep に当たらない拡張の物は飛ばす", OM.onlyOwn([{ type: "childList", target: row, addedNodes: [scoreBadge], removedNodes: [] }], /^axlx-(cb|brain-badge)$/));
const btnNow = el({ cls: "btn print axlx-pdf-go", parent: row });
ok("印刷用PDF に axlx-pdf-go を付けた class の変化は拡張の物", OM.onlyOwn([{ type: "attributes", attributeName: "class", target: btnNow, oldValue: "btn print" }]));
const btnPage = el({ cls: "btn print active", parent: row });
ok("ページが class を変えた（active）→ 反応する", !OM.onlyOwn([{ type: "attributes", attributeName: "class", target: btnPage, oldValue: "btn print" }]));
ok("ページの style の変化 → 反応する", !OM.onlyOwn([{ type: "attributes", attributeName: "style", target: pdfBtn, oldValue: "" }]));
ok("拡張の要素の style の変化（光の位置）→ 拡張の物", OM.onlyOwn([{ type: "attributes", attributeName: "style", target: glow, oldValue: "" }]));
ok("data-axlx-verdict の付け外し → 拡張の物", OM.onlyOwn([{ type: "attributes", attributeName: "data-axlx-verdict", target: pdfBtn, oldValue: null }]));
ok("sumora- の札（AI 評価）も拡張の物", OM.onlyOwn([{ type: "childList", target: row, addedNodes: [el({ cls: "sumora-score-badge", parent: row })], removedNodes: [] }]));

console.log("── ② 見張りどうしの反応し合いを止めた");
const so = read("score-overlay.js");
ok("score-overlay: 見張りは拡張の物だけの変化を飛ばす", /if \(OM && OM\.onlyOwn\(muts\)\) return;/.test(so));
ok("score-overlay: 同じ点の札は付け直さない", /if \(olds\.length === 1 && olds\[0\]\.textContent === st\.label \+ " " \+ score \+ "点"\) return;/.test(so));
ok("score-overlay: 送済みの札・AI 評価の札も同じなら付け直さない", /olds\[0\]\.textContent === st\.text \+ lbl\) return;/.test(so) && /existingBadge\.textContent === wantText\) return;/.test(so));
ok("score-overlay: 案内モードでは行ごとの AI 評価（DeepSeek）を呼ばない", /if \(guideModeOn\(\)\) return;/.test(so) && /data-axlx-guide"\) !== "0"/.test(so));
ok("score-overlay: 見えていないタブでは点を付け直さない", /if \(document\.hidden\) \{ _scorePendingHidden = true; return; \}/.test(so));
ok("bulk-dl: 拡張の物だけの変化では印刷用PDF を数え直さない", /if \(_OM && _OM\.onlyOwn\(muts\)\) return;/.test(read("bulk-dl.js")));
const ct = read("content.js");
ok("content.js: 拡張の物だけの変化では左の欄を確かめ直さない（class の前の値も読む）", /if \(_OM && _OM\.onlyOwn\(muts\)\) return;/.test(ct) && /attributeOldValue: true/.test(ct));
const rg = read("realpro-guide.js");
ok("案内: 拡張の物だけの変化を飛ばす（下見の札・一括の印だけは反応）", /_OM\.onlyOwn\(muts, KEEP_OWN\)/.test(rg) && /KEEP_OWN = \/\^axlx-\(cb\|brain-badge\)\$\//.test(rg));
ok("案内: 変化が無ければ 1.5秒に1回・見えていないタブでは止める", /if \(!_dirty && Date\.now\(\) - _lastTickAt < 1500\) return;/.test(rg) && /if \(document\.hidden\) return;/.test(rg));
ok("案内: 1回の見直しで手順ごとに1回だけ読む（evalStepM）・文字の検索も1回", /function evalStepM\(s\)/.test(rg) && /_evalMemo = \{\}; _textMemo = \{\};/.test(rg) && !/var d = evalStep\(s\)\.done;/.test(rg));
ok("案内: 文字の検索は文字のノードから上へ（全部の箱の文字をつなげない）", /createTreeWalker\(document\.body, NodeFilter\.SHOW_TEXT/.test(rg) && /if \(et\.length > maxLen\) break;/.test(rg));
ok("案内: スクロールは光の位置だけ（1コマに1回）", /window\.addEventListener\("scroll", repositionSoon, true\)/.test(rg) && !/window\.addEventListener\("scroll", tick, true\)/.test(rg));
ok("案内: 同じ中身なら枠と光を書き直さない", /if \(html !== _lastPanelHtml\)/.test(rg) && /if \(sig === _lastHiSig && L\.childNodes\.length\) return;/.test(rg));
ok("案内: 重さの数え（axlx_perf=1 の時だけ）", /localStorage\.getItem\("axlx_perf"\) === "1"/.test(rg));
const mf = JSON.parse(read("manifest.json"));
ok("manifest: own-mutation.js は最初の段（全部の見張りより先）・版 2.5.72", mf.content_scripts[0].js.indexOf("own-mutation.js") === 1 && /^2\.5\.(7[2-9]|[89]\d)$/.test(mf.version));

console.log("── ③ 光は控えめ・文は短く");
ok("リアプロ: 黄色の点滅（axlxGlow のアニメ）をやめた", !/@keyframes axlxGlow/.test(rg) && !/animation:axlxGlow/.test(rg) && /border:2px solid rgba\(30,136,229,\.55\)/.test(rg));
ok("リアプロ: 印刷用PDF の光は細い緑の枠・動かない", /\.axlx-pdf-go\{outline:2px solid rgba\(46,125,50,\.5\)/.test(rg));
ok("リアプロ: 光の横の吹き出しに手順の文を出さない（画面の外の時だけ矢印）", /function highlight\(targets\)/.test(rg) && !/上にあります: " \+ label/.test(rg));
ok("リアプロ: 枠の文は1行（省略・全文はマウスを乗せた時）・全手順は畳む", /white-space:nowrap;overflow:hidden;text-overflow:ellipsis;/.test(rg) && /▸ 全手順/.test(rg));
const ig = read("itandi-guide.js");
ok("ITANDI: 黄色の点滅をやめた・吹き出しの文なし", !/@keyframes axlxItGlow/.test(ig) && /function highlight\(targets\)/.test(ig));
ok("ITANDI: 見えていないタブでは見直さない", /if \(document\.hidden\) return;\r?\n    if \(!_dirty && Date\.now\(\) - _lastTickAt < 1500\) return;/.test(ig));
const css = read("styles.css");
// v2.5.75 竹内「拡張ツールのここのアナウンス不要 目に悪いのと、情報量多くて紛らわしいため」: 帯そのものをやめた
{
  const html = read("popup.html"), pj = read("popup.js"), sp = read("snapshot-popup.js");
  ok("popup: モードの帯（mode-banner）を出さない・説明はヘッダーの小さな灰色の印にマウスを乗せた時だけ", !/id="mode-banner"/.test(html) && /id="mode-dot" class="mode-dot"/.test(html) && /dot\.title = bn\.text;/.test(pj) && /dot\.textContent = paused \? "⏸" : "ⓘ";/.test(pj) && /\.mode-dot \{ font-size: 12px; color: #94a3b8;/.test(css));
  ok("popup: 版と画面の写真は小さな灰色の文字（許可済みなら版だけ・未許可の時だけボタン）", /id="snap-perm" style="display:none;align-items:center;gap:6px;padding:1px 10px;font-size:10px;color:#94a3b8;/.test(html) && /el\("snap-ver"\)\.textContent = "v" \+ \(ver \|\| "\?"\);/.test(sp) && /el\("snap-perm-state"\)\.textContent = granted \? "" : "画面の写真: 未許可";/.test(sp));
  ok("popup: 今日対応は押す物だけ・灰色の1行・完了の時は出さない", /今日対応 \$\{count\}名（押すと絞り込み）/.test(pj) && !/今日の対応は完了/.test(pj) && !/#fff3e0;border-bottom:1px solid #ffcc02/.test(html) && !/banner\.style\.background = todayOnly \? "#ff6f00"/.test(pj));
  ok("popup: 広げて検索の帯は灰色の1行（色の地なし）", /\.wide-banner \{[\s\S]*?background: none; border-left: 2px solid #cbd5e1;[\s\S]*?white-space: nowrap;/.test(css) && !/🔎 広げて検索モード/.test(pj));
}

console.log("── ④ v2.5.73 ITANDI も同じ形（竹内「これitandiでもなおしたかな？」）");
{
  const ib = read("itandi-bulk-dl.js");
  ok("ITANDI 一括: 拡張の物だけの変化ではボタンを探し直さない", /var _own = !!\(_itOM && _itOM\.onlyOwn\(muts\)\);/.test(ib) && /if \(_own\) \{ _itPerf\.obsOwn\+\+; return; \}/.test(ib));
  ok("ITANDI 一括: 見えていないタブでは探さない（見えた時に1回）", /if \(document\.hidden\) \{ _itScanPendingHidden = true; return; \}/.test(ib) && /_itScanPendingHidden = false; if \(!injectTimer\)/.test(ib));
  ok("ITANDI 一括: ボタンが前と同じでチェックボックスも残っていれば付け直さない", /tracked\[i\]\.btn === b && tracked\[i\]\.cb && tracked\[i\]\.cb\.isConnected/.test(ib) && /_itPerf\.injectSkip\+\+;\r?\n\s*afterInject\(\);\r?\n\s*return;/.test(ib));
  ok("ITANDI 一括: 自動送信の確かめは付け直しを飛ばした時も通る（afterInject）", /function afterInject\(\)/.test(ib) && (ib.match(/afterInject\(\);/g) || []).length === 2);
  ok("ITANDI 一括: 重さの数え（axlx_perf=1）", /\[AXLX itandi-bulk perf 10s\]/.test(ib));
  const ig2 = read("itandi-guide.js");
  ok("ITANDI 案内: 変化が無ければ 1.5秒に1回・押す・入れる・画面の変化で見直す", /if \(!_dirty && Date\.now\(\) - _lastTickAt < 1500\) return;/.test(ig2) && /\["input", "change", "keyup", "click"\]\.forEach/.test(ig2));
  ok("ITANDI 案内: 見張りは拡張の物だけの変化を飛ばす（全ページ送るの止めは毎回）", /lockAutoPaging\(\);\r?\n\s*perf\.obs\+\+;\r?\n\s*if \(_OM && _OM\.onlyOwn\(muts\)\)/.test(ig2));
  ok("ITANDI 案内: 1回の見直しで手順ごとに1回だけ読む", /function evalStepM\(s\)/.test(ig2) && !/var ev = evalStep\(s\);/.test(ig2) && !/var ev = evalStep\(plan\.steps\[i\]\);/.test(ig2));
  ok("ITANDI 案内: 同じ中身なら枠を書き直さない", /function setPanelHtml\(html\)/.test(ig2) && (ig2.match(/panel\.innerHTML = /g) || []).length === 1);
  ok("ITANDI 案内: 重さの数え（axlx_perf=1）", /\[AXLX itandi-guide perf 10s\]/.test(ig2));
  ok("ITANDI: itandi-content.js に見張り・繰り返しの時計は無い（直す物なし）", !/MutationObserver|setInterval/.test(read("itandi-content.js")));
  const mf2 = JSON.parse(read("manifest.json"));
  ok("ITANDI のページでも own-mutation.js が先に読まれる（最初の段に itandibb）", mf2.content_scripts[0].matches.some((m) => /itandibb/.test(m)) && mf2.content_scripts[0].js.includes("own-mutation.js"));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
