// 2.8.270（2026-11-24 竹内さん「条件入れる際は1つ1つちゃんと拡張ツールにでて判断していると理解できるが
//   外す部分は１つ１つでていないからもしかしたら入れるのと比べて弱くなっている可能性あるのでは？」）
//   ① 選ぶ欄・文字の欄・敷礼なしも「戻す:欄（i/全）」→押す→戻ったか読む→1回押し直し→完了／戻せず（_resetFieldsOneByOne）
//   ② 駅・沿線も「駅外:名前（残n）」を出し、次の番で外れたかを ok／ng で残す
//   ③ 検索前の関所: 新しい客が指定しない欄に前客の値が残っていたら1つずつ戻してから入れる（上書きされない欄）
//   ④ 関所が200秒で打ち切る時は世代を進めて中の外しを止める
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const EXT = path.join(__dirname, "../../chrome-extension");
const ROOT = path.join(__dirname, "../..");
const read = (f) => fs.readFileSync(path.join(EXT, f), "utf8");

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log("✓", name); }
  else { fail++; console.log("✗", name, detail !== undefined ? JSON.stringify(detail).slice(0, 600) : ""); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ps = read("page-script.js");
const A = require(path.join(EXT, "search-audit.js"));

const slice = (from, to) => {
  const a = ps.indexOf(from);
  const b = ps.indexOf(to, a + from.length);
  if (a < 0 || b < 0) throw new Error("見つからない: " + from + " → " + to);
  return ps.slice(a, b);
};
const labelSrc = slice("function _condOneLabel(name)", "/**");
const itemLabelSrc = slice("function _clearItemLabel(cb)", "/**");
const startSrc = slice("var _clearStartGrasped = false;", "var _SOFT_SELECT_NAMES");
const softSrc = slice("var _SOFT_SELECT_NAMES", "function _clearWardsBeforeStationThen(");
const placeSrc = slice("var _placeClearPending", "function _uncheckStationsThenLinesLikeHuman");

function makeSoftSandbox(fields, opt) {
  const o = opt || {};
  const steps = [];
  const grasp = [];
  const presses = [];
  let busy = 0;
  const els = {};
  fields.forEach((f) => {
    if (f.kind === "select") els["select:" + f.name] = { name: f.name, selectedIndex: f.idx, options: [{ value: "" }, { value: "1" }, { value: "2" }, { value: "3" }], isConnected: true, stick: !!f.stick };
    if (f.kind === "text") els["input:" + f.name] = { name: f.name, value: f.value, isConnected: true, stick: !!f.stick };
  });
  const shikirei = o.shikirei ? { checked: true, isConnected: true, stick: !!o.shikireiStick } : null;
  const finishPress = (el, fn) => {
    presses.push({ name: el.name || "shikirei", busy, at: Date.now() });
    busy++;
    return new Promise((r) => setTimeout(() => { if (!el.stick) fn(); busy--; r(); }, 20));
  };
  const sb = {
    console, Math, Date, String, Number, Array, Promise, setTimeout, clearTimeout,
    window: {},
    _audit: {},
    _axHumanTookOver: false,
    _ln: () => 5,
    _auditStepP: (k, d) => steps.push([k, String(d == null ? "" : d)]),
    _publishTaskGrasp: (g) => grasp.push(g),
    whenClickQueueIdle: (cb) => cb(),
    _findShikireiCheckbox: () => shikirei,
    document: {
      querySelector: (sel) => {
        const m = /^(select|input)\[name='([^']+)'\]$/.exec(sel);
        if (m) return els[m[1] + ":" + m[2]] || null;
        return null;
      },
    },
    chooseSelectLikeHuman: (el, v) => finishPress(el, () => { el.selectedIndex = 0; }),
    _operateWithPointer: (el, action) => Promise.resolve(action()),
    typeTextLikeHuman: (el) => finishPress(el, () => { el.value = ""; }),
    enqueueHumanClick: (el) => { finishPress(el, () => { el.checked = false; }); },
    _clickEl: () => {}, _uiGapMin: () => 1, _uiGapMax: () => 2, _uiGapOpts: () => ({}),
  };
  vm.createContext(sb);
  vm.runInContext("var _clearGen = 0;\nfunction _clearGenStale(gen) { return gen != null && gen !== _clearGen; }\n" + labelSrc + "\n" + startSrc + "\n" + softSrc, sb);
  return { sb, steps, grasp, presses, els, shikirei };
}

(async () => {
  console.log("■ ① 選ぶ欄・文字の欄・敷礼なしも1つずつ見せて確かめる");
  {
    const { sb, steps, grasp, presses, els, shikirei } = makeSoftSandbox([
      { kind: "select", name: "rental_cost1", idx: 3 },
      { kind: "select", name: "update_date", idx: 2 },
      { kind: "select", name: "rental_cost2", idx: 0 },
      { kind: "text", name: "keyword", value: "ペット" },
    ], { shikirei: true });
    let res = null, doneN = 0;
    sb._resetFieldsOneByOne(sb._collectSoftClearTargets(null), "試し", (r) => { res = r; doneN++; });
    await sleep(900);
    ok("4欄とも戻った（敷礼・賃料下限・更新日・キーワード）", !shikirei.checked && els["select:rental_cost1"].selectedIndex === 0 && els["select:update_date"].selectedIndex === 0 && els["input:keyword"].value === "", presses);
    ok("戻っている欄（賃料上限）は押さない", !presses.some((p) => p.name === "rental_cost2"), presses);
    ok("1つずつ（重ね押し0）", presses.length === 4 && presses.every((p) => p.busy === 0), presses);
    ok("順番: 敷礼なし→選ぶ欄→文字", presses.map((p) => p.name).join(",") === "shikirei,rental_cost1,update_date,keyword", presses.map((p) => p.name));
    const nows = grasp.filter((g) => g.now).map((g) => g.now);
    ok("拡張に「戻す:欄（i/全）」を1つずつ出す", nows.join("|") === "戻す:敷金礼金なし（1/4）|戻す:賃料下限（2/4）|戻す:更新日（3/4）|戻す:キーワード（4/4）", nows);
    ok("欄ごとに「戻し完了:欄」を出す", grasp.filter((g) => g.done && /^戻し完了:/.test(g.done)).length === 4, grasp.map((g) => g.done).filter(Boolean));
    ok("最後に「欄の戻し完了×4」", grasp.some((g) => g.done === "欄の戻し完了×4"), grasp.map((g) => g.done).filter(Boolean));
    ok("印: clear_field_plan・clear_field×4・ok×4・done", steps.some((s) => s[0] === "clear_field_plan") && steps.filter((s) => s[0] === "clear_field").length === 4 && steps.filter((s) => s[0] === "clear_field_ok").length === 4 && steps.some((s) => s[0] === "clear_field_done"), steps);
    ok("終わりの合図は1回・ok", doneN === 1 && res && res.ok === true, res);
    ok("戻せなかった欄は無し（__axlxClearFieldNg 空）", Array.isArray(sb.window.__axlxClearFieldNg) && sb.window.__axlxClearFieldNg.length === 0);
  }
  {
    const { sb, steps, grasp, presses } = makeSoftSandbox([
      { kind: "select", name: "square_meter_l", idx: 2, stick: true },
      { kind: "select", name: "structured_date", idx: 1 },
    ]);
    let res = null, doneN = 0;
    sb._resetFieldsOneByOne(sb._collectSoftClearTargets(null), "試し", (r) => { res = r; doneN++; });
    await sleep(4500);
    ok("戻らない欄は1回だけ押し直す（計2回）", presses.filter((p) => p.name === "square_meter_l").length === 2, presses);
    ok("押し直しの印 clear_field_retry", steps.some((s) => s[0] === "clear_field_retry" && /面積下限/.test(s[1])), steps);
    ok("2回でも戻らなければ clear_field_ng で次へ（詰まらない）", steps.some((s) => s[0] === "clear_field_ng" && /面積下限/.test(s[1])) && presses.some((p) => p.name === "structured_date"), steps);
    ok("拡張に「戻せず:面積下限」", grasp.some((g) => g.done === "戻せず:面積下限"), grasp.map((g) => g.done).filter(Boolean));
    ok("終わりの合図は1回・ng を返す", doneN === 1 && res && res.ok === false && res.ng.indexOf("面積下限") >= 0, res);
    ok("__axlxClearFieldNg に残す（関所が見る）", (sb.window.__axlxClearFieldNg || []).indexOf("面積下限") >= 0, sb.window.__axlxClearFieldNg);
  }
  {
    const { sb, presses } = makeSoftSandbox([
      { kind: "select", name: "rental_cost1", idx: 3 },
      { kind: "select", name: "rental_cost2", idx: 3 },
    ]);
    let doneN = 0;
    sb._resetFieldsOneByOne(sb._collectSoftClearTargets(null), "試し", () => { doneN++; });
    await sleep(8);
    vm.runInContext("_clearGen++;", sb);
    await sleep(600);
    ok("引き継いだら残りを押さない", presses.length <= 1, presses);
    ok("止めても終わりの合図は返す", doneN === 1, doneN);
  }
  {
    const { sb, grasp, steps } = makeSoftSandbox([]);
    let doneN = 0, res = null;
    sb._resetFieldsOneByOne(sb._collectSoftClearTargets(null), "試し", (r) => { doneN++; res = r; });
    ok("戻す欄が無ければすぐ合図（拡張に出さない・印も出さない）", doneN === 1 && res.ok && grasp.length === 0 && steps.length === 0, { grasp, steps });
  }
  ok("押す係が返らなくても15秒で読み直しへ", /setTimeout\(go, 15000\)/.test(softSrc));

  console.log("■ ③ 新しい客が指定しない欄の残り（上書きされない欄）");
  {
    const { sb } = makeSoftSandbox([]);
    const s = { selects: ["rental_cost1", "rental_cost2", "update_date", "square_meter_l", "structured_date"], texts: ["keyword"], shikirei: true };
    const stay = sb._softStayNames(s, { rent_max: 70000, building_age: 10 });
    ok("客が指定しない賃料下限・面積下限・キーワードだけ（指定した賃料上限・築年は入れる段が上書き）", JSON.stringify(Array.from(stay).sort()) === JSON.stringify(["keyword", "rental_cost1", "shikirei", "square_meter_l"].sort()), stay);
    ok("更新日は入れる段が未指定でも戻すので入れない", stay.indexOf("update_date") < 0);
    const stay2 = sb._softStayNames({ selects: [], texts: [], shikirei: true }, { shikirei_free: true });
    ok("敷礼なしを望む客なら敷礼は残りにしない", stay2.length === 0, stay2);
  }
  const gate = slice("function _cleanStartGate(cond, round, proceed, redo)", "var _clearGen = 0;");
  ok("関所: 進む前に _softStayNames → 1つずつ戻す → 進む", /_softStayNames\(_scanLeftoverForm\(\), cond\)[\s\S]{0,600}leftover_soft_stay[\s\S]{0,300}_resetFieldsOneByOne\(_collectSoftClearTargets\(stay\)[\s\S]{0,300}goRaw\(\);/.test(gate));
  ok("関所: 戻せなかった欄は leftover_soft_ng を残して進む（止めない）", /leftover_soft_ng/.test(gate));
  ok("関所: 残りの判定は1回だけ（2回目は素通り）", /if \(softChecked\) \{ goRaw\(\); return; \}/.test(gate));

  console.log("■ ④ 関所の200秒打ち切りは中の外しを止める");
  ok("打ち切り時に _clearGen++ してから進む", /leftover_gate_timeout[\s\S]{0,200}_clearGen\+\+;[\s\S]{0,40}goRaw\(\);/.test(gate));

  console.log("■ ② 駅・沿線も1つずつ出して判定");
  {
    const steps = [];
    const grasp = [];
    const mk = (name, value, label, stick) => {
      const cb = { name, value, checked: true, isConnected: true, stick: !!stick, getAttribute: (k) => (k === "name" ? name : null) };
      cb._label = { textContent: label, cb };
      return cb;
    };
    const st = [mk("station_id[]", "s1", "梅田"), mk("station_id[]", "s2", "難波", true), mk("station_id[]", "s3", "天王寺")];
    const ln = [mk("route_id[]", "r1", "御堂筋線")];
    const all = st.concat(ln);
    const sb = {
      console, Math, Date, String, Number, Array, setTimeout,
      _audit: {},
      _auditStepP: (k, d) => steps.push([k, String(d == null ? "" : d)]),
      _publishTaskGrasp: (g) => grasp.push(g),
      _labelForCheckbox: (cb) => cb._label,
      isVisible: () => true,
      _scrollIntoScrollParent: () => null,
      _visStationLabels: () => [],
      _visLineLabels: () => [],
      _toggleCheckboxLikeHuman: (cb, on) => { if (!cb.stick) cb.checked = !!on; },
      document: {
        querySelectorAll: (sel) => {
          if (/station_id/.test(sel)) return all.filter((c) => c.name === "station_id[]" && c.checked);
          if (/route_id/.test(sel)) return all.filter((c) => c.name === "route_id[]" && c.checked);
          return [];
        },
      },
    };
    vm.createContext(sb);
    vm.runInContext(itemLabelSrc + "\n" + placeSrc, sb);
    // 状態機械と同じく1回に1つずつ呼ぶ（難波は外れない）
    for (let i = 0; i < 4; i++) sb._uncheckVisibleStationsLikeHuman();
    const nows = grasp.filter((g) => g.now).map((g) => g.now);
    ok("拡張に「駅外:梅田（残3）」を出してから押す", nows[0] === "駅外:梅田（残3）", nows);
    ok("梅田は外れた → station_clear_one_ok・done に梅田", steps.some((s) => s[0] === "station_clear_one_ok" && /梅田/.test(s[1])) && grasp.some((g) => g.done === "駅外:梅田"), steps);
    ok("外れない難波は station_clear_one_ng（押し直しが見える）", steps.some((s) => s[0] === "station_clear_one_ng" && /難波/.test(s[1])), steps);
    ok("次に外す駅を next に出す", grasp[0] && grasp[0].next === "駅外:難波", grasp[0]);
    st[1].stick = false;
    for (let i = 0; i < 4; i++) sb._uncheckVisibleStationsLikeHuman();
    ok("駅が0になったら最後の1つも判定して終える", st.every((c) => !c.checked) && steps.filter((s) => s[0] === "station_clear_one_ok").length === 3, steps.filter((s) => /station_clear_one/.test(s[0])));
    sb._uncheckVisibleLinesLikeHuman();
    sb._uncheckVisibleLinesLikeHuman();
    ok("沿線も「線外:御堂筋線（残1）」→ line_clear_one_ok", grasp.some((g) => g.now === "線外:御堂筋線（残1）") && steps.some((s) => s[0] === "line_clear_one_ok"), steps.filter((s) => /line_clear/.test(s[0])));
  }
  ok("駅の外しの最初（round 0）で前の判定待ちを捨てる", /if \(_round === 0\) _placeClearPending = \{ station: null, line: null \};/.test(ps));

  console.log("■ 2.8.271 入れる段と同じく、最初の1つの前に把握を待つ");
  {
    const { sb, steps, presses } = makeSoftSandbox([
      { kind: "select", name: "rental_cost1", idx: 3 },
      { kind: "select", name: "square_meter_l", idx: 2 },
    ]);
    const order = [];
    let gDoneAt = 0;
    sb._graspBeforeNextTaskThen = (ph, why, done) => {
      order.push("grasp:" + ph);
      setTimeout(() => { gDoneAt = Date.now(); order.push("grasp_done"); done({ api: { ok: true } }); }, 300);
    };
    let doneN = 0;
    sb._resetFieldsOneByOne(sb._collectSoftClearTargets(null), "試し", () => { doneN++; });
    await sleep(60);
    ok("把握を取り始めるまで押さない（最初の1つは待つ）", presses.length === 0 && order[0] === "grasp:clear_start", { order, presses: presses.length });
    await sleep(1400);
    ok("把握が返ってから押す（待ちの順番・時刻で確かめる）", gDoneAt > 0 && presses.length === 2 && presses[0].at >= gDoneAt, { gDoneAt, first: presses[0] && presses[0].at, order });
    ok("把握は1客1回（2欄目では取り直さない）", order.filter((x) => /^grasp:/.test(x)).length === 1, order);
    ok("欄が戻り終わって合図は1回", doneN === 1, doneN);
    void steps;
  }
  {
    // 同じ客の2回目（_clearStartGrasped が立ったまま）は待たずに押す
    const { sb, presses } = makeSoftSandbox([{ kind: "select", name: "rental_cost1", idx: 3 }]);
    let calls = 0;
    sb._graspBeforeNextTaskThen = (ph, why, done) => { calls++; done({ api: { ok: true } }); };
    sb._clearStartGrasped = true;
    sb._resetFieldsOneByOne(sb._collectSoftClearTargets(null), "試し", () => {});
    await sleep(500);
    ok("すでに把握済みの客は待たずに押す（取り直さない）", calls === 0 && presses.length === 1, { calls, presses: presses.length });
  }
  ok("外しの始めは _clearChecksOneByOne でも把握を待つ（1つ目の前）", /if \(!gated\) \{ gated = true; _clearStartGraspThen\(why \|\| tg, step\); return; \}/.test(ps));
  ok("欄の戻しも最初の欄の前に把握を待つ", /if \(!gated\) \{ gated = true; _clearStartGraspThen\("欄の戻し", step\); return; \}/.test(ps));
  ok("次客の外しの始まり（round 0）で把握を取り直す", /if \(_rr === 0\) \{ try \{ _clearStartGrasped = false; \} catch/.test(ps));
  ok("送付後の外しの始まりでも取り直す", /window\.__axlxPostSendGen = \+\+_clearGen;\s*_clearStartGrasped = false;/.test(ps));
  ok("旧: 外し開始を待たずに流す呼び方は無い", !/_graspBeforeNextTaskThen\("clear", "leftover_dirty外し開始"/.test(ps));
  ok("選ぶ欄だけ残った時も外しの把握（fill 扱いにしない）", /_softDirty0/.test(ps));
  ok("箱の外し: 1つずつの把握印（clear_one_grasp）", /_auditStepP\(tg \+ "_grasp"/.test(ps));
  ok("欄の外し: 1つずつの把握印（clear_field_grasp）", /_auditStepP\("clear_field_grasp"/.test(ps));
  ok("駅・沿線: 1つずつの把握印（station/line_clear_one_grasp）", /tg \+ "_grasp", label/.test(ps));
  ok("次の動きを把握印に残す（next_move_grasp・入れる段と同じ）", (ps.match(/"next_move_grasp", "次の動き=外す:/g) || []).length >= 2 && /"next_move_grasp", "次の動き=戻す:/.test(ps));
  ok("新しい把握の印を残す決まりに入っている", A.KEEP_STEP.test("page:clear_one_grasp") && A.KEEP_STEP.test("page:clear_field_grasp") && A.KEEP_STEP.test("page:station_clear_one_grasp") && A.KEEP_STEP.test("page:line_clear_one_grasp"));

  console.log("■ _resetRest は押しっぱなしをやめた");
  const rr = slice("function _resetRest() {", "} // _resetRest end");
  ok("_resetRest は _resetFieldsOneByOne(_collectSoftClearTargets(null)) で1つずつ", /_resetFieldsOneByOne\(_collectSoftClearTargets\(null\), "前客の選ぶ欄・文字"/.test(rr));
  ok("敷礼なしを確かめずに積む形が無い", !/enqueueHumanClick\(sInp/.test(rr));
  ok("外し後の点検（_guideLikeAfterClearCheck）は残す", /_guideLikeAfterClearCheck\(cond, function \(r\)/.test(rr));

  console.log("■ 点検記録・版");
  ok("RULE_STEP に clear_field・station_clear_one・line_clear_one", A.RULE_STEP.test("page:clear_field_ok") && A.RULE_STEP.test("page:station_clear_one_ok") && A.RULE_STEP.test("page:line_clear_one"));
  ok("KEEP_STEP に clear_field_ng・done・station/line_clear_one_ng・leftover_soft_", A.KEEP_STEP.test("page:clear_field_ng") && A.KEEP_STEP.test("page:clear_field_done") && A.KEEP_STEP.test("page:station_clear_one_ng") && A.KEEP_STEP.test("page:line_clear_one_ng") && A.KEEP_STEP.test("page:leftover_soft_stay"));
  ok("page 側 _PIN にも足した", /var _PIN = [^\n]*\|clear_field\|station_clear_one\|line_clear_one\|leftover_soft_\|/.test(ps));
  const man = JSON.parse(read("manifest.json"));
  const verGe = (v) => { const [a, b, c] = String(v).split(".").map(Number); return a > 2 || (a === 2 && (b > 8 || (b === 8 && c >= 270))); };
  ok("manifest 2.8.270 以上", verGe(man.version), man.version);
  ok("_AXLX_PAGE_VER 2.8.270 以上", verGe((ps.match(/_AXLX_PAGE_VER = "([\d.]+)"/) || [])[1]));
  const rules = fs.readFileSync(path.join(ROOT, "app/lib/auto-procedure-rules.ts"), "utf8");
  ok("決まりの見直し版 2.8.270 以上", verGe((rules.match(/AUTO_RULES_REVIEWED_UP_TO = "([\d.]+)"/) || [])[1]));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
