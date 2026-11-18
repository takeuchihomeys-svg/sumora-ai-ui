// 実行: node tests/chrome-extension/ward-lane-v2808.test.js
// v2.8.108 竹内さん（2026-11-18・平田さんの自動録画 audit #1498）:
//   「地域選択する際の人間の通常モードと比べて時間がかなり遅い／通常モードの人間の速さのようにする」
//   「今回天王寺区を押して外して一瞬止まってしまった」
//   「家賃や更新日選択する際、画面のスクロールをせず画面外でおこなってしまった。画面内に合わせてから選択する」
//
// DB実測（読むだけ）:
//   区（label.one_city）の押し間隔  通常 p25=730 / p50=836 / p75=1030 / p90=1338 ms
//                                   自動 p50=5735ms（約7倍）← 下限の積み上げ（押す前≥900＋後≥950＋確認400＋迷い）
//   天王寺区: 再選択の直後に 19.2秒の無操作（「人が手を止めた」8〜25秒の範囲）・3回切り替わって未選択へ戻った
//
// 直し: ①区レーン（押す間隔を通常の分布で決める）②区の最中は長い停止を入れない
//       ③押した直後の反映を待ってから次の手（重ね押しで元に戻さない）④選ぶ前に画面内へ入れて止まるのを待つ
const fs = require("fs");
const path = require("path");
const HW = require("../../chrome-extension/human-wait.js");

const ps = fs.readFileSync(path.join(__dirname, "../../chrome-extension/page-script.js"), "utf8").replace(/\r\n/g, "\n");
const mf = JSON.parse(fs.readFileSync(path.join(__dirname, "../../chrome-extension/manifest.json"), "utf8"));
let pass = 0, fail = 0;
function ok(name, cond, detail) { cond ? pass++ : fail++; console.log((cond ? "  ✓ " : "  ✗ ") + name + (cond || detail === undefined ? "" : "\n      " + JSON.stringify(detail).slice(0, 300))); }

console.log("■ ① 区レーン（通常の人の速さ）");
{
  ok("区の要素を見分ける（one_city / city_code[]）", /function _isWardLaneEl\(el\)/.test(ps) && /one_city/.test(ps.split("function _isWardLaneEl")[1].slice(0, 500)));
  ok("enqueueHumanClick が区を lane:ward にする", /var _lane = _isWardLaneEl\(el\) \? "ward" : null;/.test(ps) && /lane: _lane,/.test(ps));
  ok("区の押す前の待ちは小さい（下限900の積み上げをしない）", /gap: _lane === "ward" \? _ln\(110, 0\.45, 50, 260\)/.test(ps));
  ok("通常の迷い（_hesitateMs）は区・selectに足さない（迷いは混合で決める）", /var hesitate = \(_isWardItem \|\| _isSelItem\) \? 0 : _hesitateMs\(item\.el\);/.test(ps));
  ok("押した後の待ちも短い（区・select）", /var settle = _isWardItem \? _ln\(110, 0\.4, 60, 260\) : \(_isSelItem \? _ln\(90, 0\.4, 50, 200\) : _afterClickGapMs\(item\.el\)\);/.test(ps));
  ok("押す時刻の目標（直前の区クリック＋通常の間隔）を _humanPointerClick へ渡す（3か所）",
    (ps.match(/_humanPointerClick\(item\.el, item\.fn, item\.aim \|\| null, _wardTgt\)/g) || []).length === 3);
  ok("_humanPointerClick が tgtAt を受ける", /function _humanPointerClick\(el, fallbackFn, aim, tgtAt\)/.test(ps));
  ok("目標があれば着地後の見る時間を目標時刻で決める（長い待ちは漂ってから押す）", /_dwell = Math\.max\(80, Math\.min\(4200, Math\.round\(Number\(tgtAt\) - Date\.now\(\) - 170\)\)\);/.test(ps) && /!_useTgt && Math\.random\(\) < 0\.28/.test(ps));
  ok("区クリックの時刻を記録する（__axlxWardLastAt）", /if \(_isWardItem\) window\.__axlxWardLastAt = _tn;/.test(ps));
  ok("確認ループの待ちが短い（40ms監視・50〜220ms）", /_verifyThenConfirm\(n \+ 1\); \}, _wardOverSoft \? 3000 : _ln\(90, 0\.4, 50, 220\)\); \}, 40\);/.test(ps));
  ok("whenClickQueueIdle が pollMs を受ける（既定150msは変えない）", /function whenClickQueueIdle\(cb, pollMs\)/.test(ps) && /pollMs > 0 \? pollMs : _pd\(150\)/.test(ps));
}

console.log("\n■ ① 区の間隔の分布（実測 p25=730 / p50=836 / p75=1030 / p90=1338 と合うか）");
{
  // _wardPaceMs = _ln(840, 0.32, 650, 2200) を実装どおりに計算
  const m = /function _wardPaceMs\(\) \{ return _ln\((\d+), ([\d.]+), (\d+), (\d+)\); \}/.exec(ps);
  ok("_wardPaceMs の定義が読める", !!m);
  if (m) {
    const med = Number(m[1]), sig = Number(m[2]), lo = Number(m[3]), hi = Number(m[4]);
    const N = 20000, xs = [];
    for (let i = 0; i < N; i++) xs.push(Math.max(lo, Math.min(hi, HW.logNormalDelay(med, sig))));
    xs.sort((a, b) => a - b);
    const q = (p) => xs[Math.floor(p * (N - 1))];
    const p25 = q(0.25), p50 = q(0.5), p75 = q(0.75), p90 = q(0.9);
    console.log(`      計算: p25=${Math.round(p25)} p50=${Math.round(p50)} p75=${Math.round(p75)} p90=${Math.round(p90)} min=${Math.round(xs[0])}`);
    ok("中央値が通常（836）に近い（±80ms）", Math.abs(p50 - 836) <= 80, p50);
    ok("p25 が通常（730）に近い（±120ms）", Math.abs(p25 - 730) <= 120, p25);
    ok("p75 が通常（1030）に近い（±160ms）", Math.abs(p75 - 1030) <= 160, p75);
    ok("p90 が通常（1338）に近い（±250ms）", Math.abs(p90 - 1338) <= 250, p90);
    ok("毎回ちがう（固定値にしない・種類が多い）", new Set(xs.map(Math.round)).size > 500);
    ok("自動の旧 p50（5735ms）の半分以下", p50 < 5735 / 2, p50);
  }
}

console.log("\n■ ② 区の最中は長い停止を入れない（天王寺区の19秒）");
{
  const body = ps.split("function _longPauseDue(item)")[1].slice(0, 900);
  ok("レーン（区・select）のアイテムでは 0 を返す", /item && item\.lane\) return 0/.test(body));
  ok("区クリックの直近20秒以内も 0（確率も進めない）", /_wardRunActive\(\)\) return 0/.test(body) && /Date\.now\(\) - window\.__axlxWardLastAt < 20000/.test(ps));
  ok("確率の式は今まで通り（2〜5%・8〜25秒）", /var p = 0\.02 \+ Math\.min\(0\.03, _opsSincePause \/ 2000\);/.test(ps) && /_ln\(11000, 0\.5, 8000, 25000\)/.test(ps));
  ok("drain が item を渡す", /var pause = _longPauseDue\(item\);/.test(ps));
}

console.log("\n■ ③ 押した直後の反映を待つ（押して外れるのを防ぐ）");
{
  const t = ps.split("function _toggleCheckboxLikeHuman(")[1].slice(0, 7000);
  ok("反映待ち（_settleChk）で判断する", /var _settleChk = function \(ms\)/.test(t));
  ok("1手ずつ: label.click → 待つ → input.click → 待つ → simulateClick → 待つ",
    t.indexOf("hit.click()") < t.indexOf("_settleChk(240)") && t.indexOf("cb.click()") > t.indexOf("_settleChk(240)") && t.indexOf("simulateClick(hit") > t.indexOf("cb.click()"));
  ok("旧の「押してすぐ checked を読む」二重押しが消えている", !/if \(cb\.checked !== !!wantOn\) \{ try \{ cb\.click\(\); \} catch \(_\) \{\} \}\n/.test(t));
  ok("遅れて反映した時は点検に残す（toggle_late_ok）", /toggle_late_ok/.test(t));
  ok("Promise を返す（押し終わるまで次の区へ進まない）", /return _settleChk\(240\)\.then\(function \(ok1\)/.test(t));
  // 模型: 反映が遅れるサイトでも、重ね押しせず1回で済む
  const state = { checked: false, clicks: 0 };
  const label = { click() { state.clicks++; setTimeout(() => { state.checked = !state.checked; }, 120); } };
  const input = { get checked() { return state.checked; }, click() { state.clicks++; state.checked = !state.checked; } };
  function settle(ms) { return new Promise((res) => { const t0 = Date.now(); (function poll() { const okk = input.checked === true; if (okk || Date.now() - t0 >= ms) return res(okk); setTimeout(poll, 40); })(); }); }
  label.click();
  settle(240).then((ok1) => {
    if (!ok1) input.click();
    ok("模型: 反映が120ms遅れても押しは1回・選択状態になる", state.clicks === 1 && state.checked === true, state);
    afterSelect();
  });
}

function afterSelect() {
console.log("\n■ ④ 家賃・更新日は画面内に入ってから選ぶ");
{
  ok("選ぶ前の関所 _settleSelectInView がある", /function _settleSelectInView\(el, label\)/.test(ps));
  ok("chooseSelectLikeHuman が関所を通ってから本体へ", /return _settleSelectInView\(el, _lbl\)\.then\(function \(\) \{\s*return _chooseSelectLikeHumanCore\(el, val, opts\);/.test(ps));
  ok("本体は別名（_chooseSelectLikeHumanCore）", /function _chooseSelectLikeHumanCore\(el, val, opts\)/.test(ps));
  const g = ps.split("function _settleSelectInView(")[1].slice(0, 2600);
  ok("欄と下の一覧が入る余白で判定（上60・下90）", /r\.top >= 60 && r\.bottom <= vh - 90/.test(g));
  ok("入っていなければ中央へスクロール", /block: "center"/.test(g));
  ok("スクロールが止まるまで待つ（位置が安定するまで・最短260ms）", /function waitStable|var waitStable/.test(g) && /same >= 2 && Date\.now\(\) - t0 >= 260/.test(g));
  ok("止まってからもう一度確かめる（最大3回）", /tries >= 3/.test(g));
  ok("直前スクロールの抑制（900ms）には従わず必ず出す", !/_lastScrollAt && now - _lastScrollAt/.test(g));
  ok("点検に select_in_view を残す", /select_in_view/.test(g));
  ok("select_in_view / toggle_late_ok / ward_pace / fill_pause が点検の固定印", /var _PIN = \/\^\(select_in_view\|toggle_late_ok\|ward_pace\|fill_pause\|fill_resume\|/.test(ps));
  // 模型: 画面外の欄 → スクロールして止まるまで待ってから選ぶ
  let top = 1500, vh = 800, scrollCalls = 0;
  const el = { getBoundingClientRect: () => ({ top, bottom: top + 24, height: 24 }), scrollIntoView() { scrollCalls++; setTimeout(() => { top = 300; }, 150); } };
  const inView = () => { const r = el.getBoundingClientRect(); return r.height > 0 && r.top >= 60 && r.bottom <= vh - 90; };
  const waitStable = (cb) => { let last = null, same = 0; const t0 = Date.now(); (function poll() { const y = Math.round(el.getBoundingClientRect().top); if (last !== null && Math.abs(y - last) <= 1) same++; else same = 0; last = y; if ((same >= 2 && Date.now() - t0 >= 260) || Date.now() - t0 > 2400) return cb(); setTimeout(poll, 70); })(); };
  let tries = 0;
  const step = () => { if (inView() || tries >= 3) { ok("模型: 画面外の欄はスクロールして止まってから選ぶ（スクロール1回・最後は画面内）", scrollCalls === 1 && inView(), { scrollCalls, top }); done(); return; } tries++; el.scrollIntoView(); waitStable(step); };
  step();
}
}

function done() {
  console.log("\n■ ⑤ 版");
  ok("manifest が 2.8.114", mf.version === "2.8.114", mf.version);
  ok("_AXLX_PAGE_VER が 2.8.114", /var _AXLX_PAGE_VER = "2\.8\.114";/.test(ps));
  console.log(`\n結果: ${pass} 合格 / ${fail} 不合格`);
  process.exit(fail ? 1 : 0);
}
