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

console.log("■ ① 許可が無い時に目立つ帯が出る");
{
  ok("帯がある（#snap-perm-banner）", /id="snap-perm-banner"/.test(html));
  ok("中身に「画面の録画を許可してください」と書いてある", /画面の録画を許可してください/.test(html));
  ok("何のための許可か書いてある（写真が残る・検索を押せたか確かめられる）", /操作のたびに画面の写真が残り/.test(html) && /検索を押せたか/.test(html));
  ok("PCごとに1回だけと書いてある", /PCごとに1回だけ/.test(html));
  ok("目立つ大きさ（12px・太字・黄色）", /padding:6px 12px;font-size:12px;font-weight:800/.test(html) && /background:#f59e0b/.test(html));
  ok("帯の背景が黄色で目立つ（#fffbeb＋#f59e0b の枠）", /background:#fffbeb;border:2px solid #f59e0b/.test(html));
  ok("初期は隠れている（許可が無い時に出す）", /id="snap-perm-banner" style="display:none/.test(html));
}

console.log("\n■ ② 押すと許可を頼む");
{
  ok("「許可する」ボタンがある", /id="snap-perm-banner-btn"[\s\S]{0,200}許可する/.test(html));
  ok("押すと ask を呼ぶ", /snap-perm-banner-btn[\s\S]{0,200}addEventListener\("click", ask\)/.test(sp));
  ok("ask が chrome.permissions.request を呼ぶ", /function ask\(\)[\s\S]{0,800}chrome\.permissions\.request\(ORIGINS/.test(sp));
  ok("許可されたら帯を消す（render(true)）", /if \(ok\) \{ render\(true\); return; \}/.test(sp));
  ok("許可の状態で帯の出し入れをする", /banner\.style\.display = granted \? "none" : "flex"/.test(sp));
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
