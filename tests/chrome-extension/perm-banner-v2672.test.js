// 実行: node tests/chrome-extension/perm-banner-v2672.test.js
// 2026-11-11 竹内さん「録画の許可のボタン表示されていないので表示されるようにする」
//
//   ① 許可が無い時は**目立つ帯**（#snap-perm-banner）を出す（旧は 10px の小さな文字で気づけなかった）
//   ② 押すと許可を頼む（chrome.permissions.request）
//   ③ ダイアログが出ない時（小窓の iframe）は**手順**を出す＋拡張の管理画面を開くボタン
//   ④ 許可すると消える
//   ⑤ どの画面でも出る（一覧の画面の中に入っていない）
const fs = require("fs");
const path = require("path");
const dir = path.join(__dirname, "..", "..", "chrome-extension");
const read = (f) => fs.readFileSync(path.join(dir, f), "utf8").replace(/\r\n/g, "\n");

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.log("  ✗ " + name + (extra !== undefined ? "\n      " + JSON.stringify(extra).slice(0, 400) : "")); }
}

const html = read("popup.html"), sp = read("snapshot-popup.js"), mf = JSON.parse(read("manifest.json"));

console.log("■ ① 許可が無い時に目立つボタンが出る（ブレインの左）");
{
  ok("ボタンがある（#perm-rec-btn）", /id="perm-rec-btn"/.test(html));
  ok("文字が「🎬 許可する」（押せば許可）", /🎬 許可する</.test(html));

  // 2026-11-11 竹内さん「許可の部分出てないからそこも改善する」:
  //   帯は横並びだったので**右の「許可する」が押し出されて切れていた**（「出ない時」だけ見えていた）
  ok("帯は**縦積み**（説明の下にボタン）", /id="snap-perm-banner"[^>]*flex-direction:column/.test(html));
  ok("帯は縮まない（flex:0 0 auto）", /id="snap-perm-banner"[^>]*flex:0 0 auto/.test(html));
  ok("「許可する」は行いっぱいに広がる（flex:1 1 auto・min-width:110px）", /id="snap-perm-banner-btn"[\s\S]{0,200}flex:1 1 auto;min-width:110px/.test(html));
  ok("「許可する」を大きくした（13px・太字800・余白8px 14px）", /padding:8px 14px;font-size:13px;font-weight:800/.test(html));
  ok("「出ない時」は小さく横に並ぶ（flex:0 0 auto）", /id="snap-perm-open-ext"[\s\S]{0,120}flex:0 0 auto/.test(html));
  ok("**ブレインより前**にある（左側）", (() => {
    const iBtn = html.indexOf('id="perm-rec-btn"');
    const iBrain = html.indexOf('id="brain-toggle"');
    return iBtn > 0 && iBrain > 0 && iBtn < iBrain;
  })());
  ok("同じ入れ物（mode-group）の中", (() => {
    const iGroup = html.indexOf('class="mode-group"');
    const iBtn = html.indexOf('id="perm-rec-btn"');
    const iNextDiv = html.indexOf('</div>', iGroup);
    const iGroupEnd = html.indexOf('<button class="icon-btn"', iGroup);
    return iBtn > iGroup && iBtn < iGroupEnd;
  })());
  ok("最初から出ている（display:inline-block・JSを待たない）", /id="perm-rec-btn" style="display:inline-block/.test(html));
  ok("目立つ（オレンジ#f59e0b・太字800・白文字）", /background:#f59e0b;border:none;border-radius:14px;padding:5px 8px;color:#fff;font-size:11px;font-weight:800/.test(html));
  ok("脈打つ（animation:axlxPermPulse）", /animation:axlxPermPulse/.test(html) && /@keyframes axlxPermPulse/.test(read("styles.css")));
  ok("何のための許可かツールチップに書いてある", /title="押すと画面の録画を許可できます/.test(html));
  ok("帯もある（#snap-perm-banner・説明用）", /id="snap-perm-banner"/.test(html));
  ok("中身に「画面の録画を許可してください」と書いてある", /画面の録画を許可してください/.test(html));

  // 2026-11-11 竹内さん「まだでていない」: 狭い小窓で**右に切れていた**のが原因
  const css = read("styles.css");
  ok("ヘッダーは折り返す（切らない）", /\.header \{[\s\S]{0,600}flex-wrap: wrap/.test(css));
  ok("mode-group も折り返す・縮められる", /\.mode-group \{[\s\S]{0,400}flex-shrink: 1/.test(css) && /\.mode-group \{[\s\S]{0,400}flex-wrap: wrap/.test(css));
  ok("狭い小窓（520px以下）では副題を隠して場所を作る", /@media \(max-width: 520px\) \{[\s\S]{0,120}\.header-sub, \.header-sep \{ display: none; \}/.test(css));
  ok("ボタンの文字は短く保つ（6文字以内）", /🎬 許可する</.test(html));
}

console.log("\n■ ② 押すと許可を頼む");
{
  ok("「許可する」ボタンがある", /id="snap-perm-banner-btn"/.test(html) && />許可する</.test(html));
  ok("押すと ask を呼ぶ（帯）", /snap-perm-banner-btn[\s\S]{0,200}addEventListener\("click", ask\)/.test(sp));
  ok("押すと ask を呼ぶ（ヘッダーのボタン）", /perm-rec-btn[\s\S]{0,200}addEventListener\("click", ask\)/.test(sp));
  ok("ask が chrome.permissions.request を呼ぶ（doAsk 経由）", /function doAsk\(\)[\s\S]{0,1100}chrome\.permissions\.request\(ORIGINS/.test(sp) && /doAsk\(\);/.test(sp.slice(sp.indexOf("function ask"), sp.indexOf("function doAsk"))));
  ok("許可されたらボタンと帯を消す（render(true)）", /if \(ok\) \{ render\(true\); return; \}/.test(sp));
  ok("許可の状態でボタンを**いつも出す**（許可済みでも出る＝「でない」が無い）", /if \(recBtn\) \{[\s\S]{0,200}recBtn\.style\.display = "inline-block"/.test(sp));
  ok("許可済みなら緑の「🎬 OK」・脈打たない", /recBtn\.textContent = "🎬 OK"/.test(sp) && /recBtn\.style\.animation = "none"/.test(sp));
  ok("未許可ならオレンジの「🎬 許可する」・脈打つ", /recBtn\.textContent = "🎬 許可する"/.test(sp) && /axlxPermPulse 1\.6s/.test(sp));
  ok("許可済みで押したら「もう許可済み」と出す", /画面の録画は許可済みです/.test(sp));
  ok("最初はボタンを出しておく（確認を待たない）", /var recBtn0 = el\("perm-rec-btn"\);[\s\S]{0,120}style\.display = "inline-block"/.test(sp));
  ok("chrome.permissions が無い時もボタンを出す（render(false)）", /if \(!chrome\.permissions \|\| !chrome\.permissions\.contains\) \{ render\(false\); return; \}/.test(sp));
}

console.log("\n■ ③ ダイアログが出ない時の逃げ道");
{
  ok("手順を出す関数がある（PERM_STEPS）", /function PERM_STEPS\(\)/.test(sp));
  ok("  chrome://extensions の手順を書いてある", /chrome:\/\/extensions/.test(sp));
  ok("  「サイトへのアクセス」を「すべてのサイト」にする手順", /サイトへのアクセス/.test(sp) && /すべてのサイト/.test(sp));
  ok("  拡張IDも出す（どれか分かるように）", /拡張ID: " \+ id|拡張ID: /.test(sp));
  ok("拡張の管理画面を開くボタンがある（#snap-perm-open-ext）", /id="snap-perm-open-ext"/.test(html));
  ok("押すと拡張の管理画面を開く", /function openExtensionsPage\(\)/.test(sp) && /chrome:\/\/extensions\/\?id=/.test(sp));
  ok("  ID を取れない時は一覧を開く", /chrome:\/\/extensions\/" \}\); \} catch/.test(sp));
  ok("ダイアログが出なかった時に手順を出す", /showHint\(PERM_STEPS\(\)\)/.test(sp));
  ok("例外の時も手順を出す", /catch \(e\) \{[\s\S]{0,400}showHint\(PERM_STEPS\(\)\)/.test(sp));
  ok("手順は改行して読める（white-space:pre-line）", /white-space:pre-line/.test(html));
}

console.log("\n■ ④ どの画面でも出る（一覧の中に入っていない）");
{
  const iBanner = html.indexOf('id="snap-perm-banner"');
  const iViewList = html.indexOf('id="view-list"');
  const iViewInstr = html.indexOf('id="view-instructions"');
  ok("一覧の画面（view-list）より前にある", iBanner > 0 && iBanner < iViewList, [iBanner, iViewList]);
  ok("どの画面にも属さない（view-instructions より前）", iBanner < iViewInstr);
  ok("ヘッダーの中（深さ2）", (() => {
    const before = html.slice(0, iBanner);
    return ((before.match(/<div/g) || []).length - (before.match(/<\/div>/g) || []).length) === 2;
  })());
}

console.log("\n■ ⑤ 許可の設定（manifest）");
{
  ok("optional_host_permissions に <all_urls>", JSON.stringify(mf.optional_host_permissions) === '["<all_urls>"]');
  ok("最初からは持たせない（host_permissions に <all_urls> が無い）", !((mf.host_permissions || []).includes("<all_urls>")));
  ok("popup.html が snapshot-popup.js を読む", /<script src="snapshot-popup.js"><\/script>/.test(html));
}

console.log("\n■ ⑥ 版の表示が消えていない（許可済みでも版は見える）");
{
  ok("版は常に出す（v…）", /snap-ver"\)\.textContent = "v" \+ \(ver \|\| "\?"\)/.test(sp));
  ok("許可済みなら「未許可」の文字は消す", /granted \? "" : "画面の写真: 未許可"/.test(sp));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
