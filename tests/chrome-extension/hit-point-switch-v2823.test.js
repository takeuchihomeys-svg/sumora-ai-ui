// 実行: node tests/chrome-extension/hit-point-switch-v2823.test.js
// v2.8.123 2026-11-19 竹内さん「駅のお客さんから地域のお客さんに移るとき必ず、駅と沿線外す…今回は途中で止まってしまったので原因みつける
//   また徒歩のプルダウンの最初押す部分みぎにずれてる…検索ボタンを画面外から押している部分もある」
//
// DB実測（読むだけ・2.8.121）:
//   #1530 𝑅.: 検索は押せていた（07:56:06 に 14棟26戸）。次客くれあの一括が「前客の入力待ち」の間に回のお客様＝くれあになり、
//            𝑅. あての送付が owner_mismatch で2回断られ、fill-done/結果が来ず 6分で idle_close。
//   #1531 くれあ: 前客の駅は布施1つ・近鉄大阪線1つだけ外して ×とじる → 残り3駅のまま区へ。
//   徒歩: transportation_id を押した記録が b=55x29/input の右端（xy=0.98）＝分数の欄。select の枠は 230×30。
//   検索: 左の帯が中でスクロールし、検索ボタンが上の固定の帯の下（写真 22694 でカーソルは閲覧履歴の上）。
const fs = require("fs");
const path = require("path");

const read = (f) => fs.readFileSync(path.join(__dirname, "../../chrome-extension", f), "utf8").replace(/\r\n/g, "\n");
const ps = read("page-script.js");
const bg = read("background.js");
const mf = JSON.parse(read("manifest.json"));
let pass = 0, fail = 0;
function ok(name, cond, detail) { cond ? pass++ : fail++; console.log((cond ? "  ✓ " : "  ✗ ") + name + (cond || detail === undefined ? "" : "\n      " + JSON.stringify(detail).slice(0, 300))); }

function extractFn(src, name) {
  const i = src.indexOf("function " + name + "(");
  if (i < 0) return null;
  let depth = 0, j = src.indexOf("{", i);
  for (let k = j; k < src.length; k++) {
    if (src[k] === "{") depth++;
    else if (src[k] === "}") { depth--; if (depth === 0) return src.slice(i, k + 1); }
  }
  return null;
}

// 偽の画面: 要素は矩形、elementFromPoint は「上に重なる物」を先に見る
function mkEl(name, rect, tag) {
  const el = {
    name, tagName: tag || "DIV", id: "", labels: null,
    getBoundingClientRect: () => Object.assign({ width: rect.right - rect.left, height: rect.bottom - rect.top }, rect),
    contains: (o) => o === el,
    closest: () => null,
  };
  return el;
}
function makeHit(layers) {
  return (x, y) => {
    for (const el of layers) {
      const r = el.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return el;
    }
    return null;
  };
}

console.log("■ ① 押せる点（elementFromPoint で一番上がその要素）");
const srcHit = extractFn(ps, "_hitOkAt");
const srcVis = extractFn(ps, "_visibleHitPoint");
const srcPlain = extractFn(ps, "_hitPlain");
ok("_hitOkAt / _visibleHitPoint / _hitPlain がある", !!(srcHit && srcVis && srcPlain));
function load(layers) {
  const window = { innerWidth: 1200, innerHeight: 800 };
  const document = { elementFromPoint: makeHit(layers) };
  // eslint-disable-next-line no-new-func
  return new Function("window", "document", srcHit + srcVis + srcPlain + "; return { hit: _hitOkAt, vis: _visibleHitPoint, plain: _hitPlain };")(window, document);
}
{
  // 徒歩: select 230 幅（左 40〜270）、分数の入力 100〜155 が上に重なる、その右 160〜270 も別の物（「分」の文字）
  const sel = mkEl("select", { left: 40, top: 180, right: 270, bottom: 210 }, "SELECT");
  const input = mkEl("input", { left: 100, top: 180, right: 155, bottom: 210 }, "INPUT");
  const unit = mkEl("unit", { left: 156, top: 180, right: 270, bottom: 210 }, "SPAN");
  const f = load([input, unit, sel]);
  ok("枠の真ん中（155,195）は分数側＝押せない点", !f.hit(sel, 155, 195));
  const p = f.vis(sel, { x: 155, y: 195 });
  ok("狙いを見えている左側（select の上）へ直す", !!p && p.x < 100 && f.hit(sel, p.x, p.y), p);
  ok("重なりのある欄は『普通の欄』ではない（学び無しでも見えている所を狙う）", f.plain(sel) === false);
  const btn = mkEl("btn", { left: 400, top: 300, right: 500, bottom: 340 }, "DIV");
  const f2 = load([btn]);
  ok("重なりの無いボタンは普通の欄（今まで通り pointer-ui に任せる）", f2.plain(btn) === true);
  ok("押せる点ならそのまま返す", f2.vis(btn, { x: 450, y: 320 }).x === 450);
}
{
  // 検索: ボタン（top 60〜110）が上の固定の帯（0〜130）の下に隠れている
  const btn = mkEl("search", { left: 40, top: 60, right: 190, bottom: 110 }, "DIV");
  const header = mkEl("header", { left: 30, top: 0, right: 200, bottom: 130 }, "DIV");
  const f = load([header, btn]);
  ok("固定の帯の下の検索は押せる点が無い（null＝隠れている）", f.vis(btn, null) === null);
  ok("画面の外の点は押せない", load([btn]).hit(btn, 50, 900) === false);
}

console.log("\n■ ② 押す前に使う（カーソル移動・プルダウン・検索）");
{
  ok("隠れていれば1回だけ見える所まで送ってから押す（press_hidden_scroll）", /if \(!el\.__axOccScrolled && !_visibleHitPoint\(el, null\)\)[\s\S]{0,300}scrollIntoView\(\{ block: "center"[\s\S]{0,300}"press_hidden_scroll"/.test(ps));
  ok("狙いの点に重なりがあれば直す（aim_hit_fix）", /var _hp = _visibleHitPoint\(el, _aimPt\);[\s\S]{0,200}"aim_hit_fix"/.test(ps));
  ok("学び無しでも重なりのある欄は見えている点を狙う", /\} else if \(!_hitPlain\(el\)\) \{\n\s*var _hp2 = _visibleHitPoint\(el, null\);/.test(ps));
  ok("見えるカーソルの揺らしで重なりへはみ出さない", /if \(!_hitOkAt\(el, _jx, _jy\) && _hitOkAt\(el, _aimPt\.x, _aimPt\.y\)\)/.test(ps));
  ok("プルダウンの学んだ位置も見えている点へ直す", /var _shp = _visibleHitPoint\(el, \{ x: _ax, y: _ay \}\);/.test(ps));
  ok("検索は中央付近が本当に見えている時だけ押す（_inVNow）", /return !!_visibleHitPoint\(btn, null\) && _hitPlain\(btn\);/.test(ps));
}

console.log("\n■ ③ 客が替わる時に駅・沿線／区を外し切る（最大3回）");
{
  // 2.8.125 竹内さん「最大3回って形だと残ってしまう」→ 回数上限（_round < 2）をやめ進捗型（_leftoverProgressStep）に。期待はその形に直した
  ok("区の前の駅外し: 残れば開き直して外す（進捗型・station_clear_retry）", /_leftoverProgressStep\(prog, lx\.st \+ lx\.ln, clk\.tick\(\)\)[\s\S]{0,1200}"station_clear_retry"[\s\S]{0,400}_clearStationsBeforeWardThen\(nextFn, why, _round \+ 1, prog\)/.test(ps) && !/_round < 2\)[\s\S]{0,200}station_clear_retry/.test(ps));
  ok("沿線・駅絞り込みの押し直しは2回まで（open_retry を残す）", /reopenN < 2\)[\s\S]{0,200}"station_clear_open_retry"/.test(ps));
  ok("駅の前の区外し: 開けず・時間切れ・残りがあればやり直す（進捗型・ward_clear_retry）", /_leftoverProgressStep\(prog, _wl, clk\.tick\(\)\)[\s\S]{0,1500}"ward_clear_retry"[\s\S]{0,500}_clearWardsBeforeStationThen\(nextFn, why, _round \+ 1, prog\)/.test(ps) && !/how !== "完了" && _wardLeft\(\) > 0 && _round < 2/.test(ps));
}

console.log("\n■ ④ 連続の客: 前客の送付を断らない・送付が終わるまで待つ");
{
  const bgSrc = read("batch-guard.js");
  const m = { exports: null };
  // batch-guard.js は UMD 風。self に載る形を読む
  const self = {};
  // eslint-disable-next-line no-new-func
  new Function("self", "module", "globalThis", bgSrc)(self, undefined, self);
  const G = self.AxlxBatchGuard || (m.exports);
  ok("AxlxBatchGuard.sendOwner が読める", !!(G && G.sendOwner));
  if (G && G.sendOwner) {
    const watch = { customerId: "kurea", customerName: "くれあ", site: "realnetpro", runId: "r2", prevCustomerId: "R" };
    const a = G.sendOwner(watch, true, "realpro", "R");
    ok("待っている間の前客あての送付は通す（batch:false・prev）", a.ok === true && a.batch === false && a.prev === true, a);
    const b = G.sendOwner(watch, true, "realpro", "other");
    ok("前客でも回のお客様でもない相手は今まで通り断る", b.ok === false && b.reason === "mismatch", b);
    const c = G.sendOwner(Object.assign({}, watch, { prevCustomerId: null }), true, "realpro", "R");
    ok("待ち終わった後（prevCustomerId 無し）は今まで通り断る", c.ok === false, c);
  }
  ok("background: 前客の検索後の送付が終わるまで待つ（wait_prev_send）", /_auditTracker\.findOpen\(_paCid, "realpro"\)[\s\S]{0,400}"wait_prev_send"/.test(bg));
  ok("background: 待っている間は prevCustomerId を見張りに載せ、進む時に外す", /_watchSet\(\{ prevCustomerId: String\(_pv\.fillCustomerId\) \}, "realnetpro"\)/.test(bg) && /wait_prev_customer_done[\s\S]{0,200}_watchSet\(\{ prevCustomerId: null \}, "realnetpro"\)/.test(bg));
  ok("background: 前客のまま送った事を前客の回に残す（owner_prev_ok）", /if \(_own && _own\.prev\) \{[\s\S]{0,200}"owner_prev_ok"/.test(bg));
}

console.log("\n■ ⑤ 新しい記録が間引かれない");
{
  const pin = (ps.match(/var _PIN = \/\^\(([^)]*)\)\//) || [])[1] || "";
  ["station_clear_retry", "station_clear_open_retry", "ward_clear_retry", "press_hidden_scroll", "aim_hit_fix", "search_wait_view"].forEach((k) => {
    ok("_PIN: " + k, pin.split("|").indexOf(k) >= 0);
  });
}

console.log("\n■ ⑥ 版");
ok("manifest が 2.8.123 以降", mf.version.localeCompare("2.8.123", undefined, { numeric: true }) >= 0, mf.version);
ok("_AXLX_PAGE_VER が manifest と同じ", ps.indexOf('var _AXLX_PAGE_VER = "' + mf.version + '";') >= 0);

console.log(`\n結果: ${pass} 合格 / ${fail} 不合格`);
process.exit(fail ? 1 : 0);
