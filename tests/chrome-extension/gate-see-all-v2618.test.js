// 実行: node tests/chrome-extension/gate-see-all-v2618.test.js
// 2026-11-10 竹内さん「ちゃんと画面見て判断できるようになってるのかな場所など」→「なおす」
//   ① 検索を押す前に、家賃・更新日・築年・徒歩・間取り・場所を画面で確かめる
//   ② 違えば入れ直してから、もう一度確かめる（1回だけ）
//   ③ それでも違えば検索しない（全件検索の防止）
//   ④ 欄が無い・指定なし（-1）の物は比べない（止めない）
const fs = require("fs");
const path = require("path");
const dir = path.join(__dirname, "..", "..", "chrome-extension");
const read = (f) => fs.readFileSync(path.join(dir, f), "utf8").replace(/\r\n/g, "\n");

let passed = 0, failed = 0;
function ok(name, cond, extra) { if (cond) { passed++; console.log("  ✓ " + name); } else { failed++; console.log("  ✗ " + name + (extra !== undefined ? "\n      " + JSON.stringify(extra).slice(0, 300) : "")); } }

const ps = read("page-script.js");
const gate = (() => {
  const i = ps.indexOf("function _axGateCheck()");
  const j = ps.indexOf("  /** 旧: 間取りだけを見る（互換のため残す） */");
  if (i < 0) return "";
  return ps.slice(i, j > i ? j : i + 8000);
})();

console.log("■ ① 家賃・更新日・築年・徒歩・間取り・場所を確かめる");
ok("_axGateCheck がある", gate.length > 0);
ok("家賃の上限（rental_cost2）を比べる", /rental_cost2/.test(gate) && /家賃の上限が画面と違う/.test(gate));
ok("家賃の下限（rental_cost1）を比べる", /rental_cost1/.test(gate) && /家賃の下限が画面と違う/.test(gate));
ok("更新日（update_date）を比べる", /update_date/.test(gate) && /更新日が画面と違う/.test(gate));
ok("築年数（structured_date）を比べる", /structured_date/.test(gate) && /築年数が画面と違う/.test(gate));
ok("徒歩（required_time）を比べる", /required_time/.test(gate) && /駅からの徒歩が画面と違う/.test(gate));
ok("間取り（room_layout_id[]）を数える", /room_layout_id\[\]"\]/.test(gate) && /out\.missingLayout = true/.test(gate) && /間取り（/.test(gate));
  ok("場所（区・駅）が**どちらも0件**なら止める（片方入っていれば通す・覚えている分も数える）", /場所（/.test(gate) && /city_code\[\]"\]/.test(gate) && /station_id\[\]"\]/.test(gate) && /var hasArea = \(wardEff > 0\) \|\| \(stEff > 0\) \|\| \(urlHasArea && _axPlaceReady && \(_picked\.ward \+ _picked\.station\) > 0\)/.test(gate) && /_pickedCounts\(\)/.test(gate));

console.log("\n■ ② 違えば入れ直してから確かめ直す");
ok("関所が _axGateCheck を使う", /var _gate = _axGateCheck\(\);/.test(ps));
// 2.8.313: 入れ直しは「ずれている欄だけ」を queueSelVal で（旧 setSelVal・全欄ではない。2026-11-16）
ok("入れ直す（間取り・家賃・更新日・築年・徒歩）", /setCheckboxes\("room_layout_id\[\]", _axExpect\.layoutVals\)/.test(ps) && /queueSelVal\("rental_cost2", _axExpect\.rentMax\)/.test(ps) && /queueSelVal\("update_date", _axExpect\.updateDays\)/.test(ps) && /queueSelVal\("structured_date", _axExpect\.age\)/.test(ps) && /_selMatchesWant\(_r2g, _axExpect\.rentMax\)/.test(ps));
// 2.8.313: 「1回だけ」→ 回数に上限のある再試行（2026-11-18 平田1484で _AX_GATE_RETRY_MAX=6 の回数制へ）。上限なしの無限再試行ではない事を見る
ok("上限のある再試行（_axGateRetryN < _AX_GATE_RETRY_MAX・旧 _axGateRetried は互換の印）", /var _AX_GATE_RETRY_MAX = \d+;/.test(ps) && /if \(_axGateRetryN < _AX_GATE_RETRY_MAX\) \{\s*\n\s*_axGateRetryN\+\+;\s*\n\s*_axGateRetried = true;/.test(ps));

console.log("\n■ ③ それでも違えば（2026-11-11 竹内さん「ちゃんと検索おすように」）");
// 2026-11-11 竹内さん「自動検索も検索ボタン押す前にとまってしまった。ちゃんと検索おすように」:
//   旧は止めていた。だが「値は入っているのに比べ方が違う」事が多く、**検索されないまま止まる**のが一番困る。
//   → 場所（全件検索になる）だけ止める。それ以外は警告を残して検索する。
// 2.8.313: gate_stop_area → gate_stop_basic（2026-11-16: 場所＋間取り＋敷礼なし＋前客の残りを止める側に広げた。場所は今も止める側）
ok("場所が入っていない時は止める（gate_stop_basic・_hardGate に '場所'）", /_auditStepP\('gate_stop_basic'/.test(ps) && /var _hardGate = _gate\.errors\.some\(function \(m\) \{[\s\S]{0,200}?s\.indexOf\('場所'\) === 0/.test(ps));
ok("場所の判定（'場所' で始まるエラーだけ）", /indexOf\('場所'\) === 0/.test(ps));
ok("それ以外は警告を残して検索する（gate_warn）", /_auditStepP\('gate_warn'/.test(ps));
ok("止めない（gate_stop で止めない）", !/_auditStepP\('gate_stop'/.test(ps));
ok("fill-done に gate:true（場所の時だけ）", /notifyDone\('AXLX_FILL_INCOMPLETE: ' \+ gateMiss, true\)/.test(ps));
ok("検索を押すコードが関所より後ろにある（止めなければ押す）", ps.indexOf("_pressSearchBtn = function") > ps.indexOf("gate_warn"));

console.log("\n■ ④ 比べない物（欄が無い・指定なし）");
ok("「下限なし」（-1）などは比べない", /var isNone = function \(v\) \{ return v == null \|\| v === '' \|\| v === '-1' \|\| v === '0'; \}/.test(gate));
ok("欄が無ければ比べない（sel が null なら何もしない）", /if \(r2 && !same/.test(gate) && /if \(up && !same/.test(gate));
ok("読めない時は止めない", /catch \(e\) \{ \/\* 読めない時は止めない/.test(gate));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
