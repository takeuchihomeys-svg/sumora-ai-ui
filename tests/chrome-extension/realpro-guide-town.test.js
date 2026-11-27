// tests/chrome-extension/realpro-guide-town.test.js
// リアプロ人向け案内の「詳細地域（detail_ward / detail_area / town_names）」対応と
// 単発自動の前客リセット（axlx-reset-before-fill）の安全ガードを確かめるテスト。
//
// 実行: node tests/chrome-extension/realpro-guide-town.test.js
const fs = require("fs");
const path = require("path");

const DIR = path.join(__dirname, "..", "..", "chrome-extension");
const read = (f) => fs.readFileSync(path.join(DIR, f), "utf8").replace(/\r\n/g, "\n");

const Plan = require(path.join(DIR, "realpro-guide-plan.js"));
const guideSrc = read("realpro-guide.js");
const bgSrc = read("background.js");
const ppSrc = read("popup.js");

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra !== undefined ? "\n      " + String(extra) : "")); }
}

console.log("■ 1. 詳細地域案内（realpro-guide-plan.js）");
{
  // ① 区のみ指定のときは従来どおり pick_city のみ・hasTowns=false
  const pWardOnly = Plan.buildPlan({ area_mode: "ward", city_codes: ["27126"] });
  const c1 = pWardOnly.steps.find((s) => s.kind === "pick_city");
  ok("区のみ: pick_city があり pick_town は無い", !!c1 && !c1.hasTowns && !pWardOnly.steps.some((s) => s.kind === "pick_town"), JSON.stringify(pWardOnly.steps));

  // ② detail_area 指定（ピンポイント）: pick_city (hasTowns=true) → pick_town の2段
  const pDetail = Plan.buildPlan({
    area_mode: "ward",
    city_codes: ["27126"],
    detail_ward: "大阪市平野区",
    detail_area: "喜連西",
  });
  const kinds2 = pDetail.steps.map((s) => s.kind);
  const c2 = pDetail.steps.find((s) => s.kind === "pick_city");
  const t2 = pDetail.steps.find((s) => s.kind === "pick_town");
  ok("detail_area: pick_city → pick_town の順で生成される",
    kinds2.indexOf("pick_city") >= 0 && kinds2.indexOf("pick_town") === kinds2.indexOf("pick_city") + 1, kinds2);
  ok("detail_area: hasTowns=true・ward_name と towns が入る",
    !!(c2 && c2.hasTowns && c2.ward_name === "大阪市平野区" && t2 && t2.towns.length === 1 && t2.towns[0] === "喜連西"));

  // ③ town_names（複数町字）＋ city_codes 空でも detail_ward があれば案内できる
  const pMultiTown = Plan.buildPlan({
    area_mode: "ward",
    detail_ward: "大阪市城東区",
    town_names: ["今福西", "蒲生", "関目"],
  });
  const c3 = pMultiTown.steps.find((s) => s.kind === "pick_city");
  const t3 = pMultiTown.steps.find((s) => s.kind === "pick_town");
  ok("town_names のみ（city_codes空・detail_wardあり）でも pick_city → pick_town が生成される",
    !!(c3 && c3.hasTowns && c3.ward_name === "大阪市城東区" && t3 && t3.towns.length === 3), JSON.stringify(pMultiTown.steps));

  // ④ 手順IDが衝突しない
  ok("全ステップIDが一意", new Set(pMultiTown.steps.map((s) => s.id)).size === pMultiTown.steps.length);
}

console.log("■ 2. 詳細地域案内（realpro-guide.js）と禁止操作ゼロ");
{
  const gNoComment = guideSrc.replace(/\/\/.*$/gm, "");
  ok("案内モード鉄則: click/dispatchEvent/value代入/checked代入/scroll が一切無い",
    !/\.click\s*\(|dispatchEvent|\.submit\s*\(|\.value\s*=[^=]|\.checked\s*=[^=]|selectedIndex\s*=[^=]|scrollIntoView|scrollTo\s*\(|scrollBy\s*\(|scrollTop\s*=[^=]/.test(gNoComment));
  ok("pick_city が hasTowns 時に div.next_step_button2 / 詳細な地域の設定へ進む を光らせる",
    /if \(s\.hasTowns\)[\s\S]{0,400}next_step_button2[\s\S]{0,120}詳細な地域の設定へ進む/.test(guideSrc));
  ok("pick_city が都道府県画面「大阪府」ボタンも見つけて案内できる",
    /byText\(\["大阪府"\]\)/.test(guideSrc));
  ok("pick_town が label.one_town と town_code[] を読んで町名案内・確定まで光らせる",
    /if \(s\.kind === "pick_town"\)/.test(guideSrc) && /label\.one_town/.test(guideSrc) && /town_code\[\]/.test(guideSrc) && /townLabelMatches/.test(guideSrc));
  ok("onClick の確定ハンドラに pick_town 完了判定がある",
    /cur\.step\.kind === "pick_town"[\s\S]{0,400}townAnyChecked/.test(guideSrc));
}

console.log("■ 3. 単発自動の _resetBeforeFill 連携と案内保護");
{
  ok("background.js に axlx-reset-before-fill 受け口があり、案内モード（normal）を絶対に弾く",
    /if \(msg\.type === "axlx-reset-before-fill"\)[\s\S]{0,700}stMode === "normal"[\s\S]{0,120}skipped:\s*"guide_mode"[\s\S]{0,900}_resetBeforeFill\(/.test(bgSrc));
  // 2.8.328: 一括の最中は受け口から押さない（一括が持つ・#1666/#1671 の重なり）
  ok("一括の最中は受け口から入力前リセットを押さない（bulk_owns_reset）",
    /skipped:\s*"guide_mode"[\s\S]{0,300}if \(_manualBulkAlive \|\| _batchLoopAlive\) \{[\s\S]{0,400}skipped: "bulk_owns_reset"/.test(bgSrc));
  ok("_resetBeforeFill が preferredTabId を受けて対象タブを優先する",
    /async function _resetBeforeFill\(customer,\s*runId,\s*preferredTabId\)/.test(bgSrc));
  ok("popup.js が手動単発自動時 (!isAutomated && _isAutoModeNow()) だけ axlx-reset-before-fill を呼ぶ",
    /if \(!isAutomated && _isAutoModeNow\(\)\)[\s\S]{0,600}type:\s*"axlx-reset-before-fill"/.test(ppSrc));
}

console.log(`\n${pass} OK / ${fail} NG`);
if (fail) process.exit(1);
