// 2.8.146 録画（2026-11-20 #1558 前客 堺市7区→次客 駅）の再発防止
//   ① 前客の区はまとめて積まず1区ずつ「送る→押す→外れたか確かめる→次」（_clearWardsOneByOne）
//   ② 見えない区は直接押さない（ward_hidden_diag に隠れ元を残す）
//   ③ 所在地の段・開き直しの係の両方が①を使う
//   ④ 上限で次のページへ行かなかった理由（auto_page_limit）を残す
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const EXT = path.join(__dirname, "../../chrome-extension");
const read = (f) => fs.readFileSync(path.join(EXT, f), "utf8");

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log("✓", name); }
  else { fail++; console.log("✗", name, detail !== undefined ? JSON.stringify(detail) : ""); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeSandbox(wards) {
  const steps = [];
  const presses = [];
  const inputs = wards.map((w) => ({ name: "city_code[]", value: w.code, checked: true, isConnected: true, stick: !!w.stick }));
  const labels = inputs.map((cb, i) => ({ textContent: wards[i].name, hidden: !!wards[i].hidden, cb, parentElement: null }));
  let pending = 0;
  const sb = {
    console, Math, Date, String, Number, Array, setTimeout,
    _audit: {},
    _axHumanTookOver: false,
    _lastScrollAt: 0, _lastScrollDir: 0,
    _ln: () => 5,
    _auditStepP: (k, d) => steps.push([k, String(d || "")]),
    _labelForCheckbox: (cb) => labels[inputs.indexOf(cb)],
    isVisible: (el) => !el.hidden,
    _visibleHitPoint: () => ({ x: 1, y: 1 }),
    _graspAreaModalScreen: () => ({ kind: "ward_list", wardVis: 72, townVis: 0 }),
    window: { getComputedStyle: () => ({ display: "block", visibility: "visible", overflowY: "visible" }), innerHeight: 800 },
    document: {
      body: {}, documentElement: {},
      querySelectorAll: () => inputs.filter((c) => c.checked),
    },
    _toggleCheckboxLikeHuman: (cb, wantOn) => {
      presses.push({ code: cb.value, wantOn, busy: pending });
      pending++;
      setTimeout(() => { if (!cb.stick) cb.checked = !!wantOn; pending--; }, 30);
    },
    whenClickQueueIdle: (cb) => cb(),
  };
  labels.forEach((l) => { l.getBoundingClientRect = () => ({ top: 100, bottom: 120, width: 80, height: 20 }); l.scrollIntoView = () => {}; });
  return { sb, steps, presses, inputs };
}

(async () => {
  const ps = read("page-script.js");
  const A = require(path.join(EXT, "search-audit.js"));
  const fnAt = ps.indexOf("function _scrollIntoScrollParent(el)");
  const fnEnd = ps.indexOf("function _clearWardsBeforeStationThen(", fnAt);
  const src = ps.slice(fnAt, fnEnd);

  console.log("■ ① 1区ずつ（送る→押す→確かめる→次）");
  ok("_clearWardsOneByOne がある", fnAt > 0 && /function _clearWardsOneByOne\(done, why\)/.test(src));
  ok("押す相手は選ぶ時と同じ _labelForCheckbox", /_labelForCheckbox\(left\[i\]\)/.test(src));
  ok("小窓の一覧の中で送る（_scrollIntoScrollParent）", /var cont = _scrollIntoScrollParent\(lb\)/.test(src));
  ok("中でスクロールする箱を探して scrollBy", /overflowY[\s\S]{0,120}scrollHeight > p\.clientHeight[\s\S]{0,400}cont\.scrollBy\(/.test(src));
  ok("押した後は外れたか確かめる（ok/ng の印）", /ward_clear_one_ok/.test(src) && /ward_clear_one_ng/.test(src));
  ok("checked を直に書かない", !/\.checked\s*=(?!=)/.test(src));

  {
    const { sb, steps, presses, inputs } = makeSandbox([
      { code: "27141", name: "堺市堺区" }, { code: "27142", name: "堺市中区" }, { code: "27143", name: "堺市東区" },
    ]);
    vm.createContext(sb);
    vm.runInContext(src, sb);
    let doneN = 0;
    sb._clearWardsOneByOne(() => { doneN++; }, "試し");
    await sleep(800);
    ok("3区とも外れた", inputs.every((c) => !c.checked), inputs.map((c) => c.checked));
    ok("画面の並び順に1区ずつ押した", presses.map((p) => p.code).join() === "27141,27142,27143", presses);
    ok("前の押しが反映される前に次を押さない（重ね押し0）", presses.every((p) => p.busy === 0), presses);
    ok("外す押し（wantOn=false）だけ", presses.every((p) => p.wantOn === false));
    ok("終わりの合図は1回", doneN === 1, doneN);
    ok("印: ward_clear_one ×3・ok ×3・done", steps.filter((s) => s[0] === "ward_clear_one").length === 3 && steps.filter((s) => s[0] === "ward_clear_one_ok").length === 3 && steps.some((s) => s[0] === "ward_clear_one_done" && /^完了 外した3/.test(s[1])), steps);
  }

  console.log("■ ② 見えない区は直接押さない・外れない区は2回で諦めて次へ");
  {
    const { sb, steps, presses } = makeSandbox([
      { code: "27141", name: "堺市堺区", hidden: true }, { code: "27142", name: "堺市中区", stick: true }, { code: "27143", name: "堺市東区" },
    ]);
    vm.createContext(sb);
    vm.runInContext(src, sb);
    let doneN = 0;
    sb._clearWardsOneByOne(() => { doneN++; }, "試し");
    await sleep(6500);
    ok("見えない堺区は押していない", !presses.some((p) => p.code === "27141"), presses);
    ok("見えない区の隠れ元を残す（ward_hidden_diag）", steps.some((s) => s[0] === "ward_hidden_diag" && /^27141 label有/.test(s[1])), steps);
    ok("外れない中区は2回まで", presses.filter((p) => p.code === "27142").length === 2, presses);
    ok("東区は外した", presses.some((p) => p.code === "27143"));
    ok("外れず ng の印", steps.filter((s) => s[0] === "ward_clear_one_ng").length === 2);
    ok("終わりの合図は1回・残りを書く", doneN === 1 && steps.some((s) => s[0] === "ward_clear_one_done" && /見えず1/.test(s[1]) && /残2/.test(s[1])), steps.filter((s) => s[0] === "ward_clear_one_done"));
  }

  console.log("■ ③ 所在地の段・開き直しの係が1区ずつを使う");
  const reset = ps.slice(ps.indexOf("var _openThenUncheck = function ()"), ps.indexOf("_openThenUncheck();"));
  ok("所在地の段は _runUncheck で積まず _clearWardsOneByOne", /city_code\[\] を開けて1区ずつ外す[\s\S]{0,600}_clearWardsOneByOne\(/.test(reset) && !/_stage\('input\[name="city_code\[\]"\]/.test(reset));
  ok("外した後は確定（パネル清算）してから次の段", /_clearWardsOneByOne\(function \(\) \{\s*_settlePanelDebtThen\(/.test(reset));
  const before = ps.slice(fnEnd, ps.indexOf("function _stationNamesAbsentStable", fnEnd));
  ok("開き直しの係も1区ずつ（forEach で全部押さない）", /oneBusy = true;\s*_clearWardsOneByOne\(/.test(before) && !/forEach\(function \(cb\) \{[\s\S]{0,160}_toggleCheckboxLikeHuman\(cb, false\)/.test(before));
  ok("1区ずつの最中は次の判断をしない（oneBusy）", /if \(oneBusy\) return false;/.test(before));
  ok("時間切れを延ばした（220回）", /\/\/ 1区ずつ確かめながら外すので[^\n]*\n\s*220,/.test(before));

  console.log("■ 点検記録の上限で落とさない");
  ok("page 側 _PIN に ward_clear_one・ward_hidden_diag", /var _PIN = [^\n]*ward_clear_one\|ward_hidden_diag\)/.test(ps));
  ok("RULE_STEP に ward_clear_one", A.RULE_STEP.test("page:ward_clear_one") && A.RULE_STEP.test("page:ward_clear_one_done"));
  ok("KEEP_STEP に ng・done・diag", A.KEEP_STEP.test("page:ward_clear_one_ng") && A.KEEP_STEP.test("page:ward_hidden_diag") && A.KEEP_STEP.test("page:ward_clear_one_done"));

  console.log("■ ④ 上限で次のページへ行かなかった理由を残す");
  const bd = read("bulk-dl.js");
  const fin = bd.slice(bd.indexOf("function _autoFinish(why)"), bd.indexOf("function _autoNextPageThenRestart("));
  ok("上限なら auto_page_limit（出どころ・次のページの有無）", /_tmark\("auto_page_limit"[\s\S]{0,140}_limSrc[\s\S]{0,80}次のページあり/.test(fin));
  ok("便の指定（max_pages）を出どころとして書く", /_ro\.max_pages[\s\S]{0,80}"便の指定"/.test(fin));
  ok("上限前に止まった時も auto_page_stop", /_tmark\("auto_page_stop"/.test(fin));
  ok("次のページがあるのに上限で止めた時は画面にも出す", /if \(_nextLeft\) _nudge\("📄 上限 "/.test(fin));

  console.log("■ 版");
  const man = JSON.parse(read("manifest.json"));
  ok("manifest 2.8.146", man.version === "2.8.146");
  ok("_AXLX_PAGE_VER 2.8.146", /_AXLX_PAGE_VER = "2\.8\.146"/.test(ps));
  ok("決まり ward_clear_one を済みに", /_AXLX_RULES_DONE[\s\S]{0,4000}"ward_clear_one"/.test(ps));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
