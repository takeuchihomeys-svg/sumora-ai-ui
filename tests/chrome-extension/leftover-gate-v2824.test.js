// 実行: node tests/chrome-extension/leftover-gate-v2824.test.js
// v2.8.124 2026-11-19 竹内さん「前のお客さんの条件が残っていると判断できる能力」「入れたのを覚えていたら外し忘れがなくなる」:
//   ① フォームを読んで前客の残りを言葉にする（_planLeftover・純関数）
//   ② 画面に見えなくても台帳（入れた控え）にあれば外し忘れの候補にする
//   ③ 外した後に「きれいか」を確かめ、場所は専用の外し・チェック類は外しをやり直す（_cleanStartGate）
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const root = path.join(__dirname, "../../chrome-extension");
const ps = fs.readFileSync(path.join(root, "page-script.js"), "utf8");

let pass = 0, fail = 0;
function ok(name, c, detail) {
  if (c) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (detail !== undefined ? "  " + JSON.stringify(detail) : "")); }
}

function extractFn(name) {
  const head = "  function " + name + "(";
  const s = ps.indexOf(head);
  if (s < 0) return null;
  let i = ps.indexOf("{", s) + 1, depth = 1, inStr = null, inLine = false, inBlock = false;
  for (; i < ps.length && depth > 0; i++) {
    const c = ps[i], n = ps[i + 1];
    if (inLine) { if (c === "\n") inLine = false; continue; }
    if (inBlock) { if (c === "*" && n === "/") { inBlock = false; i++; } continue; }
    if (inStr) { if (c === "\\") { i++; continue; } if (c === inStr) inStr = null; continue; }
    if (c === "/" && n === "/") { inLine = true; continue; }
    if (c === "/" && n === "*") { inBlock = true; continue; }
    if (c === '"' || c === "'" || c === "`") { inStr = c; continue; }
    if (c === "{") depth++;
    if (c === "}") depth--;
  }
  return ps.slice(s, i);
}

const sandbox0 = { };
vm.createContext(sandbox0);
vm.runInContext(["_axWantPlaceMode", "_planLeftover"].map(extractFn).join("\n"), sandbox0);
const want = sandbox0._axWantPlaceMode;
const plan = sandbox0._planLeftover;

console.log("\n■ ① 今回のお客さんが欲しい場所（_axWantPlaceMode）");
ok("区コードあり→area", want({ city_codes: ["27100"] }) === "area");
ok("駅名あり→station", want({ station_names: ["梅田"] }) === "station");
ok("沿線だけ→route", want({ route_ids: ["1"] }) === "route");
ok("area_mode=station で駅あり→station（区もあっても）", want({ area_mode: "station", station_names: ["梅田"], city_codes: ["1"] }) === "station");
ok("何も無い→none", want({}) === "none");

console.log("\n■ ② 前客の残りを読んで外す所を決める（_planLeftover）");
const empty = { stations: 0, lines: 0, wards: 0, towns: 0, layouts: 0, structured: 0, pet: 0, shikirei: false, selects: [], texts: [] };
let p = plan(Object.assign({}, empty, { stations: 5, lines: 1 }), "area");
ok("駅5・沿線1が残る→地域の客: 駅・沿線を外す", p.clearStations && !p.clearWards && p.transition === "駅→地域" && p.dirty, p);
p = plan(Object.assign({}, empty, { wards: 3, towns: 2 }), "station");
ok("区3・町2が残る→駅の客: 区・町を外す", p.clearWards && !p.clearStations && p.transition === "地域→駅" && p.dirty, p);
p = plan(Object.assign({}, empty, { stations: 3, lines: 1 }), "station");
ok("駅→駅（同種）は個別に外さず入れ直しへ（dirty にしない）", !p.clearStations && p.sameKindPlace && !p.dirty, p);
p = plan(Object.assign({}, empty, { stations: 2, wards: 1 }), "area");
ok("混在: 駅だけ外す", p.prev === "混在" && p.clearStations && !p.clearWards, p);
p = plan(Object.assign({}, empty, { layouts: 2, shikirei: true }), "area");
ok("間取り・敷礼なしの残り→チェック類の残りとして dirty", p.boxes.length === 2 && p.dirty, p);
p = plan(Object.assign({}, empty, { selects: ["rental_cost2"], texts: ["required_time"] }), "area");
ok("セレクト・文字の残りは dirty にしない（新条件で上書きされる）", !p.dirty && p.soft.length === 2, p);
p = plan(empty, "none");
ok("全部きれい→dirty でない・理由に『なし』", !p.dirty && /残\[なし\]/.test(p.summary), p.summary);
p = plan(Object.assign({}, empty, { stations: 5, lines: 1 }), "none");
ok("場所なしの客でも駅・沿線は外す", p.clearStations, p);

console.log("\n■ ③ 台帳（入れた控え）と画面の突き合わせ");
const ledger = { n: { stations: 5, lines: 1, wards: 0, towns: 0 }, names: ["駅:梅田", "駅:難波", "線:御堂筋線"] };
p = plan(empty, "area", ledger);
ok("画面に駅が見えなくても台帳に駅5・沿線1→外し忘れ候補（覚えのみ）", p.clearStations && p.memOnlyStations && p.dirty, p);
ok("要約に台帳の名前が出る（点検で読める）", /梅田/.test(p.summary) && /覚えのみ/.test(p.summary), p.summary);
p = plan(Object.assign({}, empty, { stations: 4, lines: 1 }), "area", ledger);
ok("画面に見えている時は覚えのみにしない", p.clearStations && !p.memOnlyStations, p);
p = plan(empty, "station", ledger);
ok("台帳が駅で今回も駅→個別に外さない（入れ直し）", !p.clearStations && p.sameKindPlace, p);
p = plan(empty, "station", { n: { wards: 3, towns: 0 }, names: [] });
ok("台帳が区3で今回は駅→区・町を外す候補", p.clearWards && p.memOnlyWards, p);
p = plan(empty, "area", null);
ok("台帳なし・画面もきれい→何もしない", !p.dirty);

console.log("\n■ ④ 外した後のきれい確認（_cleanStartGate）");
const gateSrc = extractFn("_cleanStartGate");
ok("関数がある（最上位）", !!gateSrc);
function runGate(opts) {
  const log = { steps: [], proceed: 0, redo: 0, stClear: 0, wdClear: 0, ledgerCleared: 0, forceOpenAtStationClear: null };
  let scanN = 0;
  const win = { __axlxPrevLedger: opts.ledger || null, __axlxLedgerForceOpenSt: false };
  const sb = {
    window: win,
    _audit: {},
    _auditStepP: (k, v) => log.steps.push([k, String(v)]),
    setTimeout: () => 1,
    clearTimeout: () => {},
    _axWantPlaceMode: want,
    _planLeftover: plan,
    _scanLeftoverForm: () => {
      const arr = opts.scans;
      const s = arr[Math.min(scanN, arr.length - 1)];
      scanN++;
      return Object.assign({}, empty, s);
    },
    _clearStationsBeforeWardThen: (next) => { log.stClear++; log.forceOpenAtStationClear = win.__axlxLedgerForceOpenSt; if (opts.afterStClear) opts.afterStClear(); next(); },
    _clearWardsBeforeStationThen: (next) => { log.wdClear++; next(); },
    _ledgerClear: () => { log.ledgerCleared++; },
  };
  vm.createContext(sb);
  vm.runInContext(gateSrc, sb);
  sb._cleanStartGate(opts.cond || { city_codes: ["27100"] }, opts.round || 0, () => { log.proceed++; }, () => { log.redo++; });
  log.win = win;
  return log;
}
let r = runGate({ scans: [{ stations: 5, lines: 1 }, { }] });
ok("駅5・沿線1→地域: 駅外し専用が1回→きれい確認OK→進む", r.stClear === 1 && r.wdClear === 0 && r.proceed === 1 && r.redo === 0 && r.steps.some((s) => s[0] === "leftover_clean"), r);
r = runGate({ cond: { station_names: ["梅田"] }, scans: [{ wards: 3 }, {}] });
ok("区3→駅: 区外し専用が1回→進む", r.wdClear === 1 && r.stClear === 0 && r.proceed === 1, r);
r = runGate({ scans: [{}] });
ok("最初からきれい→外しは呼ばず→進む・台帳を消す", r.stClear === 0 && r.wdClear === 0 && r.proceed === 1 && r.ledgerCleared === 1, r);
r = runGate({ scans: [{ layouts: 2 }, { layouts: 2 }] });
ok("間取りが残る→外し全体をやり直す（1回だけ）・まだ進まない", r.redo === 1 && r.proceed === 0 && r.steps.some((s) => s[0] === "leftover_redo"), r);
r = runGate({ round: 1, scans: [{ layouts: 2 }, { layouts: 2 }] });
ok("やり直し後も残る→関所へ進む（無限に繰り返さない）・理由が残る", r.redo === 0 && r.proceed === 1 && r.steps.some((s) => s[0] === "leftover_unclean"), r);
r = runGate({ scans: [{}, {}], ledger: { n: { stations: 5, lines: 1 }, names: ["駅:梅田"] } });
ok("台帳だけに駅がある→沿線・駅を開いて確かめる（強制開き旗が立つ）→外した後きれい→台帳を消す",
  r.stClear === 1 && r.forceOpenAtStationClear === true && r.proceed === 1 && r.ledgerCleared >= 1 && r.steps.some((s) => s[0] === "leftover_ledger_open"), r);
r = runGate({ cond: { station_names: ["梅田"] }, scans: [{ stations: 3 }, { stations: 3 }] });
ok("駅→駅は外し専用を呼ばない（入れ直しの既存手順へ）", r.stClear === 0 && r.wdClear === 0 && r.proceed === 1, r);
r = runGate({ round: 1, scans: [{ stations: 5 }, { stations: 5 }] });
ok("外し切れず駅が残る→leftover_unclean で理由を残して進む", r.proceed === 1 && r.steps.some((s) => s[0] === "leftover_unclean"), r);

console.log("\n■ ⑤ 台帳の保存・読み込み");
const ledSrc = ["_ledgerLoad", "_ledgerClear", "_ledgerReset", "_ledgerSave", "_ledgerNames", "_ledgerSaveSoon"].map(extractFn);
ok("台帳の関数が全部ある（最上位）", ledSrc.every(Boolean), ledSrc.map(Boolean));
function makeLedgerEnv(scanObj, picked) {
  const store = {};
  const sb = {
    window: { sessionStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = v; }, removeItem: (k) => { delete store[k]; } }, _axFillRunningCustomerId: "c1" },
    Date, JSON, Math, Object, Number, String, Array,
    _scanLeftoverForm: () => Object.assign({}, empty, scanObj),
    _pickedCounts: () => picked || { ward: 0, station: 0 },
    _axStationPicked: { a: { text: "梅田" }, b: { text: "難波" } },
    _axWardPicked: {},
    _checkedLabelTexts: () => ["御堂筋線"],
    setTimeout: () => 1,
  };
  vm.createContext(sb);
  vm.runInContext(
    'var _AX_LEDGER_KEY = "axlx_entered_ledger"; var _axLedgerAcc = { stations: 0, lines: 0, wards: 0, towns: 0, layouts: 0, structured: 0, pet: 0, shikirei: 0, names: {} }; var _axLedgerTimer = null;\n' +
      ledSrc.join("\n"),
    sb
  );
  return { sb, store };
}
let env = makeLedgerEnv({ stations: 2, lines: 1 }, { ward: 0, station: 2 });
env.sb._ledgerSave("search");
let L = env.sb._ledgerLoad();
ok("保存→読み込みで駅・沿線の数と名前が戻る", L && L.n.stations === 2 && L.n.lines === 1 && L.names.indexOf("駅:梅田") >= 0 && L.names.indexOf("線:御堂筋線") >= 0, L);
env.sb._ledgerClear();
ok("消すと読めない", env.sb._ledgerLoad() === null);
env = makeLedgerEnv({}, { ward: 0, station: 0 });
env.sb._axStationPicked = {};
env.sb._ledgerSave("pagehide");
ok("何も入れていない時は台帳を作らない（空で上書きしない）", env.sb._ledgerLoad() === null);
env = makeLedgerEnv({ stations: 2 }, { ward: 0, station: 2 });
env.sb._ledgerSave("pick");
env.sb._scanLeftoverForm = () => Object.assign({}, empty, { stations: 0 });
env.sb._ledgerSave("pagehide");
L = env.sb._ledgerLoad();
ok("画面から消えても数は減らさない（入れた最大を覚える）", L && L.n.stations === 2, L);
env.store["axlx_entered_ledger"] = JSON.stringify({ at: Date.now() - 7 * 3600 * 1000, n: { stations: 3 } });
ok("6時間より古い台帳は使わない", env.sb._ledgerLoad() === null);

console.log("\n■ ⑥ 配線（ソース）");
ok("_doReset が点検に leftover_scan を残す", /_auditStepP\("leftover_scan"/.test(ps));
ok("_doReset の完了が _cleanStartGate を通る", /_cleanStartGate\(cond, _rr, _cb0/.test(ps));
ok("探索の起点で台帳を読み込んでから覚えを消す（順序）", ps.indexOf("window.__axlxPrevLedger = _pl;") > 0 && ps.indexOf("window.__axlxPrevLedger = _pl;") < ps.indexOf("_resetPicked();", ps.indexOf("window.__axlxPrevLedger = _pl;")));
ok("検索押下・pagehide・選択のたびに台帳を保存", /_ledgerSave\("search"\)/.test(ps) && /_ledgerSave\("pagehide"\)/.test(ps) && /_ledgerSaveSoon\("station"\)/.test(ps) && /_ledgerSaveSoon\("ward"\)/.test(ps));
ok("監査の間引きから leftover_ を守る", /search_wait_view\|leftover_\)/.test(ps));
const mf = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
ok("版: _AXLX_PAGE_VER が manifest と同じ（2.8.124 以降）", new RegExp('_AXLX_PAGE_VER = "' + mf.version.replace(/\./g, "\\.") + '"').test(ps) && mf.version.localeCompare("2.8.124", undefined, { numeric: true }) >= 0, mf.version);

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
