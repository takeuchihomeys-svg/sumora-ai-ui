// 2.8.144 録画（2026-11-20 平田さん自動・run mwoqsmy8_ib0b・9区＋上本町）の再発防止
//   ① ensureWardButtonY: 天王寺区を外す→選ぶの「選ぶ押し」が効かず外れたまま → もう1回だけカーソルで押す
//   ② Y にならないまま STEP4 → 15秒待って「所在地モーダル失敗」へ落ちていた → 欲しい区をそろえて確定へ
//   ③ 新しい印（ward_detail_skip・ward_btn_y_*）を点検記録の上限で落とさない
const fs = require("fs");
const path = require("path");
const EXT = path.join(__dirname, "../../chrome-extension");
const read = (f) => fs.readFileSync(path.join(EXT, f), "utf8");

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log("✓", name); }
  else { fail++; console.log("✗", name, detail !== undefined ? JSON.stringify(detail) : ""); }
}

(async () => {
  const ps = read("page-script.js");
  const A = require(path.join(EXT, "search-audit.js"));

  const ensureAt = ps.indexOf("function ensureWardButtonY(callback)");
  const ensure = ps.slice(ensureAt, ps.indexOf("// STEP1: 「所在地絞り込み＋」", ensureAt));
  console.log("■ ① 選び直しが効かない時はもう1回だけ押す");
  ok("ensureWardButtonY がある", ensureAt > 0 && ensure.length > 200);
  ok("選ぶ押しの後に checked を確かめる", /wInp && !wInp\.checked && !rechecked/.test(ensure));
  ok("押し直しは1回だけ（rechecked=true で戻る）", /_afterSelectPressed\(true\)/.test(ensure) && (ensure.match(/_afterSelectPressed\(true\)/g) || []).length === 1);
  ok("押し直しもカーソル（_pressHumanTracked）", /ward_btn_y_recheck[\s\S]{0,200}_pressHumanTracked\(wTarget/.test(ensure));
  ok("印: toggle・ok・timeout・recheck", ["ward_btn_y_toggle", "ward_btn_y_ok", "ward_btn_y_timeout", "ward_btn_y_recheck"].every((k) => ensure.includes("'" + k + "'")));
  ok("checked を直に書かない", !/\.checked\s*=(?!=)/.test(ensure));

  const s4At = ps.indexOf("function _wardOnlyConfirm(why)");
  const s4 = ps.slice(s4At, ps.indexOf("_auditStepP('next_step', null)", s4At));
  console.log("■ ② Y にならない時は区で確定（15秒待って失敗に落ちない）");
  ok("_wardOnlyConfirm がある", s4At > 0);
  ok("STEP4 の入口で Y も町の一覧も無ければ区で確定", /function startSTEP4\(\) \{\s*if \(!isWardButtonY\(\) && document\.querySelectorAll\('label\.one_town'\)\.length === 0\) \{\s*_wardOnlyConfirm\(/.test(s4));
  ok("欲しい区がそろっているか確かめる", /isAllWantedWardsChosen\(want\)/.test(s4));
  ok("足りない区はカーソルで1つずつ（_toggleCheckboxLikeHuman）", /chk\.missing\.forEach[\s\S]{0,240}_toggleCheckboxLikeHuman\(inp, true\)/.test(s4));
  ok("押し終わってから確定（whenClickQueueIdle → closeAreaModal）", /whenClickQueueIdle\(function \(\) \{\s*waitForClick\(closeAreaModal/.test(s4));
  ok("確定の後は全部押したあと次へ", /_afterAreaAllPressedThenNext\('町まで進めず・区で確定'\)/.test(s4));
  ok("確定も押せない時だけ代替の経路", /fallbackSearchWithoutArea\('町まで進めず・確定も押せず'\)/.test(s4));
  ok("印 ward_detail_skip と理由（fallback）を残す", /_auditStepP\('ward_detail_skip'/.test(s4) && /_audit\.fallback = '町（/.test(s4));
  ok("checked を直に書かない", !/\.checked\s*=(?!=)/.test(s4));

  console.log("■ ③ 新しい印を上限で落とさない");
  const pin = (ps.match(/var _PIN = (\/\^\(.*?\)\/);/) || [])[1];
  ok("_PIN は select_in_view から始まる（ward-lane の約束）", !!pin && pin.startsWith("/^(select_in_view"));
  // eslint-disable-next-line no-eval
  const PIN = pin ? eval(pin) : /$^/;
  ok("_PIN: ward_detail_skip・ward_btn_y_timeout", PIN.test("ward_detail_skip") && PIN.test("ward_btn_y_timeout"));
  ok("KEEP_STEP: page:ward_detail_skip・page:ward_btn_y_timeout", A.KEEP_STEP.test("page:ward_detail_skip") && A.KEEP_STEP.test("page:ward_btn_y_timeout"));
  ok("KEEP_STEP: 普通の段は残さない", !A.KEEP_STEP.test("page:ward_btn_y_ok") && !A.KEEP_STEP.test("page:ward_pace"));
  const list = [];
  A.pushStep(list, "page:ward_detail_skip", "Yにならない", 1);
  for (let i = 0; i < 300; i++) A.pushStep(list, "page:ward_pace", "x" + i, 10 + i);
  ok("長い回でも ward_detail_skip が残る", list.some((s) => s.k === "page:ward_detail_skip"));

  console.log("■ 版");
  const man = JSON.parse(read("manifest.json"));
  const ver = (ps.match(/_AXLX_PAGE_VER\s*=\s*"([^"]+)"/) || [])[1];
  ok("manifest と page-script の版が同じ", man.version === ver, { man: man.version, ver });
  ok("版は 2.8.144 以上", (() => { const p = String(man.version).split(".").map(Number); return p[0] > 2 || (p[0] === 2 && (p[1] > 8 || (p[1] === 8 && p[2] >= 144))); })(), man.version);
  ok("_AXLX_RULES_DONE に ward_detail_skip", /_AXLX_RULES_DONE[\s\S]{0,4000}"ward_detail_skip"/.test(ps));

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})();
