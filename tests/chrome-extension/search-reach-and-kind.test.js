// 検索まで押せるか・プルダウンと判定できるか・通常とのギャップ（2026-11-14）
//
// 竹内さん「実際テストして全部の動きできるか／検索まで押せるか／
//   途中で本来プルダウンなのにプルダウンと判断できていない部分や押すことができていないボタンはあったりするか／
//   実際の通常モードでの検索のデータと比べてのギャップを強化」
//
// 実測（本番の写真1000枚・ops付き79枚）:
//   - 並びに「検索」があるのは **11/79（14%）だけ**
//   - 未到達の回は **最後が room_layout_id[]（間取りのチェック）で終わっている**
//   - 種類（w）が無い操作: `確定してリストへ｜span`（79回）・`左の検索｜span`（11回）
//     → **押すボタンなのに other**（＝押せたか確認できない）
//   - モード別: (空) 1000行＝旧版。通常と自動を比べられない
//
// 実行: node tests/chrome-extension/search-reach-and-kind.test.js
const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "..", "..", "chrome-extension");
const read = (f) => fs.readFileSync(path.join(SRC, f), "utf8");

let pass = 0, fail = 0;
const t = (name, cond, extra) => {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra !== undefined ? "  → " + JSON.stringify(extra) : "")); }
};

const ps = read("page-script.js");
const hl = read("human-learn.js");

console.log("■ ① 押すボタンを「押せる」と判定する（span/div のボタン）");
{
  t("押せる印を調べる処理がある", hl.includes("_clickable"));
  t("onclick を見る", /if \(el\.onclick\) return true;/.test(hl));
  t('role="button" を見る', /getAttribute\("role"\)/.test(hl) && /=== "button"/.test(hl));
  t("class に search/btn/button を見る", /\(btn\|button\|submit\|go_search\|search\|next\|confirm\|kakutei\)/.test(hl));
  t("cursor: pointer を見る", /String\(st\.cursor \|\| ""\) === "pointer"/.test(hl));
  t("押せるなら button を返す", /if \(_clickable\) return "button";/.test(hl));
  t("other は最後の受け皿", /if \(_clickable\) return "button";\s*return "other";/.test(hl));
}

console.log("■ ② モーダルが無い条件でも検索まで進む（保険）");
{
  t("保険のタイマーがある", /__axSearchFallbackTimer/.test(ps));
  t("一定時間たっても押されていなければ押す", /search_fallback/.test(ps));
  t("検索を押した時刻を残す", /window\._axSearchPressedAt = Date\.now\(\)/.test(ps));
  t("最近押していれば押さない（二重押し防止）", /_axSearchPressedAt && Date\.now\(\) - window\._axSearchPressedAt < 60000/.test(ps));
  t("モーダルが開いている間は押さない", /_axModalOpen\(\)/.test(ps));
  t("モーダル判定の関数がある", /function _axModalOpen\(\)/.test(ps));
  t("クリックキュー消化中は押さない", /if \(isClickQueueBusy\(\)\) \{ return; \}/.test(ps));
  t("条件が1つも入っていなければ押さない（全件検索防止）", /if \(!any\) return;/.test(ps));
}

console.log("■ ③ 地域で止まっても検索へ進む");
{
  t("区が1つでも入れば検索へ", /_areaAtLeastOneThenSearch/.test(ps));
  t("0区なら中止（全件検索はしない）", /地域が1区も入らず中止/.test(ps));
  t("フォールバックから呼ぶ", /_areaAtLeastOneThenSearch\(msg\)/.test(ps));
}

console.log("■ ④ 押す順番が人の手順どおり（所在地→地域→確定→条件→検索）");
{
  const order = [
    ["所在地絞り込みを開く", /_auditStepP\('modal', 'area'\)/],
    ["区を選ぶ", /_auditStepP\('ward'/],
    ["町字を選ぶ", /_auditStepP\('town'/],
    ["確定してリストへ", /_auditStepP\('modal_confirm'/],
    ["条件の入力", /_basicQueue = _orderByLearned/],
    ["検索", /_auditStepP\('search'/],
  ];
  for (const [name, re] of order) t(name + " の段がある", re.test(ps));
  // 順番（modal が ward より前・ward が town より前）
  const iModal = ps.indexOf("_auditStepP('modal', 'area')");
  const iWard = ps.indexOf("_auditStepP('ward'");
  const iTown = ps.indexOf("_auditStepP('town'");
  t("modal → ward → town の順", iModal > 0 && iModal < iWard && iWard < iTown, { iModal, iWard, iTown });
}

console.log("■ ⑤ プルダウンを select と判定する（4つの欄）");
{
  // 実測で「プルダウン」として出ている欄
  const selects = ["rental_cost1", "rental_cost2", "square_meter_l", "square_meter_h", "structured_date", "update_date", "transportation_id"];
  for (const s of selects) {
    t(`${s} を select として扱う`, new RegExp(`queueSelVal\\("${s.replace(/[[\]]/g, "\\$&")}"`).test(ps));
  }
  t("select 要素は kindOfEl が select を返す", /if \(tag === "SELECT"\) return "select";/.test(hl));
}

console.log("■ ⑥ 名前から種類を推せる（実測の名前で）");
{
  // server 側の guessKindFromName は app/lib にあるので、パターンだけ確認
  const shot = fs.readFileSync(path.join(__dirname, "..", "..", "app", "lib", "shot-learn.ts"), "utf8");
  t("guessKindFromName がある", /export function guessKindFromName/.test(shot));
  t("label.one_city をチェックと推す", /label\\\.one_\(city\|town\)/.test(shot));
  t("rental_cost をプルダウンと推す", /rental_cost\|square_meter\|update_date\|structured_date/.test(shot));
  t("確定してリストへ を押すボタンと推す", /確定してリストへ\|検索\|絞り込み/.test(shot));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
