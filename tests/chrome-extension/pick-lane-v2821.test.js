// 実行: node tests/chrome-extension/pick-lane-v2821.test.js
// v2.8.121 竹内さん（2026-11-19）「束にある人の押す間隔を使って待ちを人に近づける＋1回押したら1件だけ記録」
//
// DB実測（realpro・7日・読むだけ・1押下に畳んだ間隔）:
//   間取り→間取り 自動 p50=6204ms／人 p25=832 p50=912 p75=1194（n=82）
//   駅→駅         自動 p50=6132ms／人 p25=765 p50=1037 p75=1493（n=34）
//   束の人の間隔 axlx_learn_gaps.median_ms=1705（samples=38）・通常全体の p50=1685
//   自動の1押下が2〜4本の記録（`左の布施｜label.one_station`・`布施`・前の要素の名前）
//
// 直し: ①束の間隔を page-script へ届ける ②選ぶレーン（駅・沿線・町字・間取り）
//       ③pointer-ui に押す要素を先に教える（前の要素の名前で記録しない）④自動の1押下を1本に畳む
const fs = require("fs");
const path = require("path");
const HW = require("../../chrome-extension/human-wait.js");

const read = (f) => fs.readFileSync(path.join(__dirname, "../../chrome-extension", f), "utf8").replace(/\r\n/g, "\n");
const ps = read("page-script.js");
const ct = read("content.js");
const pu = read("pointer-ui.js");
const hr = read("human-learn-record.js");
const mf = JSON.parse(read("manifest.json"));
let pass = 0, fail = 0;
function ok(name, cond, detail) { cond ? pass++ : fail++; console.log((cond ? "  ✓ " : "  ✗ ") + name + (cond || detail === undefined ? "" : "\n      " + JSON.stringify(detail).slice(0, 300))); }

console.log("■ ① 束の人の間隔が page-script に届く");
{
  ok("content.js が axlx_learn_gaps を MAIN へ中継する", /"axlx_learn_gaps",\n  \];/.test(ct));
  ok("page-script が axlx_learn_gaps を読む鍵に入れる", /"axlx_learn_gaps",\n  \];\n  var _LEARN_PAGE_CACHE_KEY/.test(ps));
  ok("median_ms・samples≥10 の時だけ使う（800〜3000に丸める）", /window\.__axlxLearnGapMs = \(_gms > 0 && _gn >= 10\) \? Math\.max\(800, Math\.min\(3000, _gms\)\) : null;/.test(ps));
  ok("鍵が来ない呼び出しでは前の値を消さない", /hasOwnProperty\.call\(r, "axlx_learn_gaps"\)/.test(ps));
}

console.log("\n■ ② 選ぶレーン（駅・沿線・町字・間取り）");
{
  ok("種類を見分ける（station/line/town/layout）", /function _pickLaneKind\(el\)/.test(ps) && /return "layout";/.test(ps) && /nm === "room_layout_id\[\]"/.test(ps));
  ok("区は今まで通り区レーン（選ぶレーンにしない）", /var _pickKind = _isWardLaneEl\(el\) \? null : _pickLaneKind\(el\);/.test(ps));
  ok("2つ目からだけ（同じ種類を7秒以内に押した直後）", /window\.__axlxPickLastKind === item\.pickKind && Date\.now\(\) - _pl < 7000/.test(ps));
  ok("押した時刻と種類を残す", /window\.__axlxPickLastAt = _tn; window\.__axlxPickLastKind = item\.pickKind;/.test(ps));
  ok("通常の迷い（_hesitateMs）は足さない", /var hesitate = \(_isWardItem \|\| _isSelItem \|\| _isPickItem\) \? 0 : _hesitateMs\(item\.el\);/.test(ps));
  ok("押す前の待ちは小さく・押す時刻は「前の押下＋人の間隔」", /item\.gap = _ln\(110, 0\.45, 50, 260\);\n        if \(_pPlan\.kind === "fast"\) \{\n          _wardTgt = _pickRef \+ _pPlan\.ms;/.test(ps));
  ok("中央値＝束の人の間隔×欄ごとの比（無ければ1685）", /var base = Number\(window\.__axlxLearnGapMs\) > 0 \? Number\(window\.__axlxLearnGapMs\) : _PICK_HUMAN_GAP_FALLBACK;/.test(ps) && /var _PICK_HUMAN_GAP_FALLBACK = 1685;/.test(ps));
  ok("点検に pick_pace（束の値か既定か）を残す", /"pick_pace"/.test(ps) && /束の人の間隔/.test(ps));
}

console.log("\n■ ② 選ぶレーンの間隔の分布（束 1705ms で人の実測と合うか）");
{
  const ratio = JSON.parse(/var _PICK_RATIO = (\{[^}]+\});/.exec(ps)[1].replace(/(\w+):/g, '"$1":'));
  const pace = /return _ln\(med, ([\d.]+), (\d+), (\d+)\);/.exec(ps);
  const plan = /if \(r < ([\d.]+)\) return \{ kind: "fast", ms: _pickPaceMs\(kind\) \};\n    if \(r < ([\d.]+)\) return \{ kind: "hesitate", ms: _ln\((\d+), ([\d.]+), (\d+), (\d+)\) \};\n    return \{ kind: "pause", ms: _ln\((\d+), ([\d.]+), (\d+), (\d+)\) \};/.exec(ps);
  ok("定義が読める", !!(ratio && pace && plan));
  if (ratio && pace && plan) {
    const ln = (m, s, lo, hi) => Math.max(lo, Math.min(hi, HW.logNormalDelay(m, s)));
    const sim = (kind) => {
      const xs = [];
      for (let i = 0; i < 20000; i++) {
        const r = Math.random();
        if (r < Number(plan[1])) xs.push(ln(1705 * ratio[kind], Number(pace[1]), Number(pace[2]), Number(pace[3])));
        else if (r < Number(plan[2])) xs.push(ln(Number(plan[3]), Number(plan[4]), Number(plan[5]), Number(plan[6])));
        else xs.push(ln(Number(plan[7]), Number(plan[8]), Number(plan[9]), Number(plan[10])));
      }
      xs.sort((a, b) => a - b);
      const q = (p) => Math.round(xs[Math.floor(p * (xs.length - 1))]);
      return { p25: q(0.25), p50: q(0.5), p75: q(0.75) };
    };
    const lay = sim("layout"), st = sim("station");
    console.log(`      間取り 計算 ${lay.p25}/${lay.p50}/${lay.p75}（人 832/912/1194）`);
    console.log(`      駅     計算 ${st.p25}/${st.p50}/${st.p75}（人 765/1037/1493）`);
    ok("間取り p50 が人（912）に近い（±150ms）", Math.abs(lay.p50 - 912) <= 150, lay);
    ok("間取り p75 が人（1194）に近い（±250ms）", Math.abs(lay.p75 - 1194) <= 250, lay);
    ok("駅 p50 が人（1037）に近い（±150ms）", Math.abs(st.p50 - 1037) <= 150, st);
    ok("駅 p75 が人（1493）に近い（±250ms）", Math.abs(st.p75 - 1493) <= 250, st);
    ok("自動の旧 p50（約6.2秒）の1/3以下", lay.p50 < 6204 / 3 && st.p50 < 6132 / 3, { lay, st });
  }
}

console.log("\n■ ③ 押す要素を先に教える（前の要素の名前で記録しない）");
{
  ok("pointer-ui に setTarget がある・外へ出す", /function setTarget\(el\) \{ _tapEl = el \|\| null; \}/.test(pu) && /setTarget: setTarget,/.test(pu));
  ok("page-script の座標で動く3か所が先に setTarget を呼ぶ", (ps.match(/\.setTarget\(el\)/g) || []).length === 3);
}

console.log("\n■ ④ 自動の1押下を1本に畳む（記録側）");
{
  const src = hr.split("var _PRESS_KIND")[1].split("function _pushOp(")[0];
  const fold = new Function("var _PRESS_KIND" + src + "\nreturn _foldAutoPress;")();
  ok("_pushOp と note-op の両方で畳む", (hr.match(/if \(_foldAutoPress\(last, _op(Obj|M)\)\) return;/g) || []).length === 2);
  // DB の実物（11-18 13:45:25 河内永和）
  const a = { t: 0, k: "click", f: "左の河内永和｜label.one_station", by: "auto", cs: "pointer" };
  ok("模型: `左の河内永和｜label` の 272ms 後の `河内永和` は畳む", fold(a, { t: 272, k: "click", f: "河内永和", by: "auto", was: false, now: true }) === true);
  ok("模型: 後の記録の was/now を前へ移す（捨てない）", a.was === false && a.now === true, a);
  ok("模型: 前の名前（`｜`付き）は残す", a.f === "左の河内永和｜label.one_station", a.f);
  const b = { t: 0, k: "click", f: "布施", by: "auto" };
  fold(b, { t: 130, k: "click", f: "左の布施｜label.one_station", by: "auto" });
  ok("模型: 前が短い名前なら `｜`付きに置き換える", b.f === "左の布施｜label.one_station", b.f);
  ok("模型: 別の駅は畳まない", fold({ t: 0, k: "click", f: "左の布施｜label.one_station", by: "auto" }, { t: 124, k: "click", f: "左の河内永和｜label.one_station", by: "auto" }) === false);
  ok("模型: 400ms を超えたら畳まない（同名駅を沿線ごとに押す）", fold({ t: 0, k: "click", f: "布施", by: "auto" }, { t: 5805, k: "click", f: "布施", by: "auto" }) === false);
  ok("模型: 人の記録は畳まない", fold({ t: 0, k: "click", f: "布施", by: "human" }, { t: 100, k: "click", f: "布施", by: "human" }) === false);
  ok("模型: change は畳まない（プルダウンの値の変化）", fold({ t: 0, k: "click", f: "rental_cost2", by: "auto" }, { t: 100, k: "change", f: "rental_cost2", by: "auto" }) === false);
}

console.log("\n■ ⑤ 版");
ok("manifest が 2.8.121 以降", mf.version.localeCompare("2.8.121", undefined, { numeric: true }) >= 0, mf.version);
ok("_AXLX_PAGE_VER が manifest と同じ", ps.indexOf('var _AXLX_PAGE_VER = "' + mf.version + '";') >= 0);
console.log(`\n結果: ${pass} 合格 / ${fail} 不合格`);
process.exit(fail ? 1 : 0);
