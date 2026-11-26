/**
 * 2.8.292 竹内さん「検索のあとのAD並べ替えや、リセットのあとの物件表示まで処理があるので、
 *   時間も30秒以上あけてやると詰まらずにできていく。並べ替えのところとリセットしてから
 *   拡張ツールから条件を入れる部分は、時間を30秒以上あける形にする」（2026-11-25 17:42）
 *   実測（DB・2026-11-25 通常モード録画）: 検索 17:38:18 → 並べ替え「高→低」17:38:54（36秒）。
 *   リセット 17:36:37 → 次の検索 17:38:18（条件入力を含む）。
 *   ⚠ 30秒未満に戻ると詰まる。このテストで固定する。
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.join(__dirname, "..", "..");
const bd = fs.readFileSync(path.join(root, "chrome-extension/bulk-dl.js"), "utf8").replace(/\r\n/g, "\n");
const bg = fs.readFileSync(path.join(root, "chrome-extension/background.js"), "utf8").replace(/\r\n/g, "\n");
const ps = fs.readFileSync(path.join(root, "chrome-extension/page-script.js"), "utf8").replace(/\r\n/g, "\n");
const man = JSON.parse(fs.readFileSync(path.join(root, "chrome-extension/manifest.json"), "utf8"));
const rules = fs.readFileSync(path.join(root, "app/lib/auto-procedure-rules.ts"), "utf8");

let pass = 0, fail = 0;
function ok(name, c, extra) { if (c) pass++; else { fail++; console.log("NG: " + name + (extra === undefined ? "" : " " + JSON.stringify(extra).slice(0, 220))); } }
/** 関数の本体を、閉じ括弧（インデント2の "  }"）まで切り出す */
function fnSrc(src, header) {
  const i = src.indexOf(header);
  if (i < 0) return "";
  const s = src.slice(i);
  const e = s.indexOf("\n  }\n");
  return e < 0 ? s : s.slice(0, e + 5);
}

console.log("\n■ 版");
const pageVer = (ps.match(/_AXLX_PAGE_VER = "([^"]+)"/) || [])[1];
const rulesVer = (rules.match(/AUTO_RULES_REVIEWED_UP_TO = "([^"]+)"/) || [])[1];
ok("manifest = page = rules", man.version === pageVer && rulesVer === man.version, [man.version, pageVer, rulesVer]);
ok("版は 2.8.292 以上", man.version.split(".").map(Number)[2] >= 292, man.version);

console.log("\n■ 検索のあと → AD並べ替え（30秒以上）");
const constBlock = (bd.match(/  var SORT_AFTER_SEARCH_MIN_MS = \d+;\n  var SORT_AFTER_SEARCH_MAX_MS = \d+;/) || [])[0] || "";
const humanFn = fnSrc(bd, "  function _humanWaitAfterSearchMs() {");
const waitFn = fnSrc(bd, "  function _waitMsFromSearchConfirm() {");
ok("下限・上限の定数がある", !!constBlock, constBlock.slice(0, 80));
ok("検索後の待ちの関数が見つかる", !!humanFn && !!waitFn);

function runSortWait(logNormal, elapsedMs) {
  const ctx = {
    self: { AxlxHumanWait: logNormal ? { logNormalDelay: logNormal } : null },
    window: {},
    Math, Date,
    _msSinceSearchConfirm: function () { return elapsedMs; },
  };
  vm.createContext(ctx);
  vm.runInContext(constBlock + "\n" + humanFn + "\n" + waitFn + "\nthis.__h = _humanWaitAfterSearchMs; this.__w = _waitMsFromSearchConfirm;", ctx);
  return { human: ctx.__h(), wait: ctx.__w() };
}

// 人の間の関数が無い時（フォールバック）でも 30〜36秒
let minH = Infinity, maxH = -Infinity;
for (let i = 0; i < 300; i++) {
  const r = runSortWait(null, 0);
  minH = Math.min(minH, r.human); maxH = Math.max(maxH, r.human);
}
ok("フォールバック: 30秒以上・36秒以下", minH >= 30000 && maxH <= 36000, [minH, maxH]);

// 人の間の関数が極端な値を返しても 30〜36秒に収まる
const low = runSortWait(() => 1000, 0);
const high = runSortWait(() => 99999, 0);
ok("人の間が1秒を返しても 30秒以上（下限）", low.human >= 30000, low.human);
ok("人の間が99秒を返しても 36秒以下（上限）", high.human <= 36000, high.human);

// 検索確認からの残り待ち: 経過0秒なら約30秒、経過20秒なら約10秒、経過40秒なら即（50ms）
const w0 = runSortWait(() => 32000, 0).wait;
const w20 = runSortWait(() => 32000, 20000).wait;
const w40 = runSortWait(() => 32000, 40000).wait;
ok("検索確認の直後は 30秒以上待つ", w0 >= 30000, w0);
ok("20秒経っていれば残り約10秒（合計30秒以上）", w20 >= 9000 && w20 <= 16000, w20);
ok("40秒経っていれば待たない（50ms・負にならない）", w40 === 50, w40);

ok("旧の 1〜3.5秒の上限は無い", !/if \(base > 3500\) base = 3500;/.test(bd));
ok("検索後の待ちは並べ替えのタイマーに使われる", /var wait = _waitMsFromSearchConfirm\(\);/.test(bd) && /\}, wait\);/.test(bd));

console.log("\n■ リセット → 次のお客さんの条件入力（30秒以上）");
const minMatch = bg.match(/var RESET_SETTLE_MIN_MS = (\d+);/);
const minReset = minMatch ? Number(minMatch[1]) : 0;
ok("押した後の待ちの下限は 30秒以上", minReset >= 30000, minReset);
const jit = Number((bg.match(/var RESET_SETTLE_JITTER_MS = (\d+);/) || [])[1]);
ok("揺れは 0〜6秒（30〜36秒の中）", jit >= 0 && jit <= 6000, jit);
ok("待ちは 3回に分けて合計で settle 分（_settleMs）", /var _settleMs = RESET_SETTLE_MIN_MS \+ Math\.floor\(Math\.random\(\) \* RESET_SETTLE_JITTER_MS\);/.test(bg)
  && /await _sleep\(_w1\);/.test(bg) && /await _sleep\(_w2\);/.test(bg)
  && /await _sleep\(Math\.max\(1000, _settleMs - _w1 - _w2\)\);/.test(bg));
const iSettle = bg.indexOf("var _settleMs = RESET_SETTLE_MIN_MS");
const iVerify = bg.indexOf("__axlxResetVerifyP", iSettle);
const iNext = bg.indexOf("return { ok: true, left: 0, reset: true", iSettle);
ok("待ちは読み戻し（空の確認）より前・次の客への返事より前", iSettle > 0 && iSettle < iVerify && iVerify < iNext, [iSettle, iVerify, iNext]);
ok("post_send_clear の段の上限は 330秒（30秒の待ち＋確認＋従来の外しが入る）", /_bulkPhaseSet\("post_send_clear", 330000/.test(bg));
ok("ページの中の押し（人の動き）・直接の書き換えは増やしていない", !/RESET_SETTLE_MIN_MS\s*=\s*[0-9]{1,4}\s*;/.test(bg));

console.log("\n■ 手順書（決まりの文）");
ok("並べ替えの決まりに 30秒以上 が載る", /確認時刻から30秒以上空けて sort_cursor へ/.test(rules));
ok("リセットの決まりに 30秒以上 が載る", /ラグがあるので30秒以上（2\.8\.292・30〜34秒・3回に分けて）/.test(rules));
ok("手順書に古い 1秒以上 の文が残っていない", !/確認時刻から合計1秒以上空けて/.test(rules));

console.log("\n■ 他の部分への影響（ページ側は変えていない）");
ok("page-script の検索後の待ちは従来どおり（this 変更なし）", !/SORT_AFTER_SEARCH/.test(ps));
ok("沈黙見張りの 135秒 は変えていない（30秒の待ちより長い）", /AXLX_STUCK_IDLE_MS = 135000/.test(bd) && 135000 > 36000);

console.log("\n結果: OK " + pass + " / NG " + fail);
if (fail) process.exitCode = 1;
