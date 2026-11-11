// 実行: node tests/chrome-extension/two-search-buttons-v2671.test.js
// 2026-11-11 竹内さん「検索のボタンはこのように2か所ある。その点をちゃんと理解すればより質上がる」
//
//   リアプロの「検索」は2か所:
//     ① 左のサイドバー（条件を入れた後に押す・メイン）← これを押すのが正しい
//     ② 小窓（市区郡・沿線の設定）の中の検索       ← ここを押すと条件が中途半端
//
//   ① 押すのは**左のサイドバー**（小窓の中の検索は押さない）
//   ② どちらを押したかを点検に残す（which: sidebar / modal / unknown）
//   ③ 学習の記録でも**2つを区別**する（左の検索／小窓の検索）
const fs = require("fs");
const path = require("path");
const dir = path.join(__dirname, "..", "..", "chrome-extension");
const read = (f) => fs.readFileSync(path.join(dir, f), "utf8").replace(/\r\n/g, "\n");

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.log("  ✗ " + name + (extra !== undefined ? "\n      " + JSON.stringify(extra).slice(0, 400) : "")); }
}

const ps = read("page-script.js");
const L = require(path.join(dir, "human-learn.js"));

console.log("■ ① 押すのは「左のサイドバー」の検索（小窓の中は押さない）");
{
  const cs = ps.slice(ps.indexOf("function clickSearch()"), ps.indexOf("function clickSearch()") + 16000);
  ok("小窓の中かどうかを見る（_inModal）", /var _inModal = function \(el\)/.test(cs));
  ok("  小窓の印（.this_window / role=dialog / .modal）を見る", /\.this_window, \[role="dialog"\], \.modal/.test(cs));
  ok("左のサイドバーかどうかを見る（_isSidebar）", /var _isSidebar = function \(el\)/.test(cs));
  ok("  左の印（.one_slide_search_box / #search_area 等）を見る", /one_slide_search_box, #search_area/.test(cs));
  ok("  画面の左半分もサイドバー扱い", /r\.left < vw \* 0\.45/.test(cs));
  ok("小窓の中のボタンは候補から外す", /var _modalBtns = goDivs\.filter\(function \(d\) \{ return _inModal\(d\); \}\)/.test(cs) && /var _outside = goDivs\.filter\(function \(d\) \{ return !_inModal\(d\) && _visible\(d\); \}\)/.test(cs));
  ok("左のサイドバーを先に並べる（goOrder）", /var goOrder = _sidebar\.length \? _sidebar\.concat/.test(cs));
  ok("その順で押す", /for \(var i = 0; i < goOrder\.length; i\+\+\) \{\s*_pressSearchBtn\(goOrder\[i\]\); return;/.test(cs));
  ok("フォールバック（文字一致）でも小窓の中は外す", /var _fbOutside = allBtns\.filter\(function \(b\) \{ return !_inModal\(b\); \}\)/.test(cs));
  ok("フォールバックでも左を優先", /var _fbSide = _fbOutside\.filter\(_isSidebar\)/.test(cs));
  // 別の検索（見積もり用）も小窓の中を押さない
  ok("別の検索の入口も小窓の中を押さない", /_fwCand = Array\.prototype\.slice\.call\(document\.querySelectorAll\("div\.go_search, div\.go_search_submit"\)\)/.test(ps) && /filter\(function \(d\) \{ return !_fwInModal\(d\); \}\)/.test(ps));
}

console.log("\n■ ② どちらを押したかを点検に残す");
{
  ok("search_press に which を入れる", /which: _inModal\(btn\) \? "modal" : \(_isSidebar\(btn\) \? "sidebar" : "unknown"\)/.test(ps));
  ok("押すボタンの class も残す", /cls: String\(btn\.className \|\| ""\)\.slice\(0, 40\)/.test(ps));
  ok("候補の内訳も残す（search_buttons）", /_audit\.search_buttons = \{/.test(ps));
  ok("  全部の数・小窓の中の数・サイドバーの数", /in_modal: _modalBtns\.length/.test(ps) && /sidebar: _sidebar\.length/.test(ps));
  ok("  1つずつの見本（場所・見えているか）", /left: r \? Math\.round\(r\.left\) : null/.test(ps));
  ok("点検の器に search_buttons を用意", /search_buttons: null/.test(read("page-script.js")));
}

console.log("\n■ ③ 学習の記録でも2つを区別する");
{
  // 画面の大きさ（左半分の判定に使う）
  global.window = { innerWidth: 1200, innerHeight: 800 };
  const W = { innerWidth: 1200, innerHeight: 800 };
  const mk = (txt, cls, left, modal) => ({
    tagName: "DIV", textContent: txt, className: cls,
    getAttribute: () => null, id: "",
    getBoundingClientRect: () => ({ left, top: 700, width: 120, height: 30 }),
    closest: (s) => {
      if (modal && /this_window/.test(s)) return {};
      if (!modal && /one_slide_search_box/.test(s)) return {};
      return null;
    },
  });
  const rec = L.create({ now: () => 1000, doc: { addEventListener() {}, removeEventListener() {} }, win: W });
  L.create({ now: () => 1000, doc: { addEventListener() {}, removeEventListener() {} }, win: W });

  const sideName = L.fieldName(mk("検索", "go_search", 40, false));
  const modalName = L.fieldName(mk("検索", "go_search", 700, true));
  ok("左のサイドバーの検索は「左の検索」と付く", /^左の検索/.test(sideName), sideName);
  ok("小窓の中の検索は「小窓の検索」と付く", /^小窓の検索/.test(modalName), modalName);
  ok("2つの名前が違う（取り違えない）", sideName !== modalName, [sideName, modalName]);
  ok("サイト側の目印（div.go_search）も残る", /の検索｜div\.go_search$/.test(sideName) && /の検索｜div\.go_search$/.test(modalName));
  ok("画面の右側なら小窓扱い・左側ならサイドバー扱い", /^左の/.test(sideName) && /^小窓の/.test(modalName));
}

console.log("\n■ ④ 押した場所の集計でも別々に貯まる");
{
  // 2つの名前が別なので、point_fields でも別々のキーになる
  const det = {
    moves: [], scrolls: [],
    points: [
      { f: "左の検索｜div.go_search", x: 0.5, y: 0.5, s: "form" },
      { f: "左の検索｜div.go_search", x: 0.55, y: 0.5, s: "form" },
      { f: "小窓の検索｜div.go_search", x: 0.8, y: 0.9, s: "modal" },
    ],
  };
  const sm = L.summarizeMotion(det);
  ok("左の検索が別に集計される", !!sm.points.fields["左の検索｜div.go_search"], Object.keys(sm.points.fields));
  ok("小窓の検索が別に集計される", !!sm.points.fields["小窓の検索｜div.go_search"]);
  ok("左の検索は 2回・横約53%", sm.points.fields["左の検索｜div.go_search"].n === 2 && Math.round(sm.points.fields["左の検索｜div.go_search"].x * 100) === 53, sm.points.fields["左の検索｜div.go_search"]);
  ok("段階も分かれる（左＝条件の入力・小窓＝小窓）", sm.points.fields["左の検索｜div.go_search"].stage === "form" && sm.points.fields["小窓の検索｜div.go_search"].stage === "modal");
}

console.log("\n■ ⑤ 人が読める報告に出る");
{
  const agg = { points: { n: 3, x: 0.5, y: 0.5, fields: {
    "左の検索｜div.go_search": { n: 2, x: 0.52, y: 0.5, stage: "form" },
    "小窓の検索｜div.go_search": { n: 1, x: 0.8, y: 0.9, stage: "modal" },
  } } };
  const lines = L.buttonReport(agg);
  const text = lines.join("\n");
  ok("報告に「左の検索」が出る", /左の検索｜div\.go_search/.test(text), text);
  ok("報告に「小窓の検索」が出る", /小窓の検索｜div\.go_search/.test(text));
  ok("報告に回数と位置が出る", /2回・横52%・縦50%/.test(text));
  ok("報告に段階（条件の入力／小窓）が出る", /条件の入力/.test(text) && /小窓（選択）/.test(text));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
