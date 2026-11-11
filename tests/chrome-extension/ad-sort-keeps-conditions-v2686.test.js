// 実行: node tests/chrome-extension/ad-sort-keeps-conditions-v2686.test.js
// 2026-11-11 竹内さん「自動検索でお客さん指定したときページが更新されて条件検索されずにそのまま物件をダウンロードしてしまう
//   バグが起きるときある。おそらくAD順などするときにページ更新してしまっている。ページ更新すると飛んでしまうので
//   拡張ツールの検索のところが閉じてしまうのにそのまま物件取得にうつってしまうので全物件が対象となってしまう」
//
//   原因: `location.href = _adLink.href` でページ全体を読み込み直していた。
//         AD順のリンクは検索条件をURLに載せていない → 飛んだ先は**全物件**。しかも読み込み直すと
//         拡張の検索の状態が消え、`_maybeAutoPressOnLoad` が全物件を押し始める。
const fs = require("fs");
const path = require("path");
const EXT = path.join(__dirname, "..", "..", "chrome-extension");
const read = (f) => fs.readFileSync(path.join(EXT, f), "utf8").replace(/\r\n/g, "\n");

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.log("  ✗ " + name + (extra !== undefined ? "\n      " + JSON.stringify(extra).slice(0, 400) : "")); }
}

const bd = read("bulk-dl.js");

console.log("■ ① 並び替えで検索条件を捨てない（全物件にしない）");
{
  ok("AD順へ移る時に**条件を残して**URLを組み立てる", /var _u = new URL\(_adLink\.href, location\.href\)/.test(bd));
  ok("いまのクエリを写す", /_cur\.forEach\(function \(v, k\)/.test(bd));
  ok("key/odr だけ上書き（二重に足さない）", /if \(k === "key" \|\| k === "odr"\) return;/.test(bd));
  ok("key=ad・odr=desc をセット", /_u\.searchParams\.set\("key", "ad"\)/.test(bd) && /_u\.searchParams\.set\("odr", "desc"\)/.test(bd));
  ok("**元の href にそのまま飛ばない**（条件が消える）", !/location\.href = _adLink\.href;/.test(bd));
  ok("条件を保った事を点検に残す（kept）", /sorting: true, kept: true/.test(bd));
}

console.log("\n■ ② 読み込み直しても「誰の検索だったか」が分かる");
{
  ok("移る前に印を残す（axlx_ad_sort_pending）", /axlx_ad_sort_pending/.test(bd));
  ok("  いつ・誰・どこから", /at: Date\.now\(\)[\s\S]{0,120}customerId:/.test(bd));
  ok("起動時にその印を読む", /chrome\.storage\.session\.get\(\["axlx_ad_sort_pending"\]/.test(bd));
}

console.log("\n■ ③ 条件が効いていない一覧では押さない（全物件を送らない）");
{
  ok("並び替え直後かを見る（_adSortJustHappened）", /function _adSortJustHappened\(\)/.test(bd));
  ok("検索の条件が効いているかを見る（_looksLikeSearchResult）", /function _looksLikeSearchResult\(\)/.test(bd));
  ok("  URL の条件（city_code・station_id・賃料など）を見る", /"city_code", "station_id", "route_id", "rental_cost1"/.test(bd));
  ok("  フォームの条件も見る（区・駅のチェック・賃料）", /checkedWard \|\| checkedSt/.test(bd) && /rental_cost2/.test(bd));
  ok("確かめられなければ**押さない**", /確かめられない → \*\*押さない\*\*/.test(bd));
  ok("押さない時は理由を出す（blocked_after_sort）", /blocked_after_sort/.test(bd));
  ok("押さない時は枠に警告を出す", /並べ替えの後に条件が消えている可能性/.test(bd));
  ok("条件が効いていれば押す（正常な流れは止めない）", /条件が効いている一覧 → 押します/.test(bd));
  ok("この判定は1回だけ（毎回ブロックしない）", /if \(_adSortChecked\) return false;/.test(bd));
}

console.log("\n■ ④ 既存の安全弁は残っている");
{
  ok("自動モードでない時は押さない", /if \(_autoPdfRun \|\| !_autoModeOn \|\| _staffModeOn\) return;/.test(bd));
  ok("スタッフモードでは押さない", /_staffModeOn/.test(bd));
  ok("同じ一覧で二度始めない（_autoPdfSig）", /sig === _autoPdfSig/.test(bd));
  ok("まだ押していない行がある時だけ", /var fresh = tracked\.some/.test(bd));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
