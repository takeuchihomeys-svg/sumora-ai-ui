// app/lib/__tests__/household-change.test.ts — 世帯の変わり目で検索の条件を連動して直す（実行: npx tsx app/lib/__tests__/household-change.test.ts）
// 2026-10-06 ⑫ 竹内「一人になった場合など連動して物件検索の条件も変更されるようにする」（あかり）
import { householdChangeOf, smallerOkOf } from "../condition-reading";
import { planHouseholdConditions } from "../household-change";
import { detectCoResident } from "../co-resident";
import { detectConditionWants } from "../property-brain";

let pass = 0, fail = 0;
const t = (name: string, ok: boolean, extra = "") => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name} ${extra}`); } };

// あかり（10/02 の実物・登録の条件そのまま）
const AKARI = { preferences: "二人入居可・トイレと風呂別・独立洗面台", other_requests: "白い壁・初期費用は安く抑えたい・築年数は若め(新しめ)希望", floor_area_min: null, floor_plan: null };
t("「別れることになって」→ 一人になる", householdChangeOf("別れることになって")?.kind === "to_single");
t("「私一人になるかもです」→ 一人になる", householdChangeOf("私一人になるかもです")?.kind === "to_single");
t("「ここの部屋に似た感じでちっさくて大丈夫です！」→ 小さくて大丈夫", smallerOkOf("ここの部屋に似た感じでちっさくて大丈夫です！"));
{
  const p = planHouseholdConditions(AKARI, householdChangeOf("私一人になるかもです"), false);
  t("あかり: 二人入居可だけ外し、他の希望は残す", p.updates.preferences === "トイレと風呂別・独立洗面台" && !("other_requests" in p.updates), JSON.stringify(p));
  t("あかり: 帯の文は物件検索ブレインに二人入居と読まれない", !detectConditionWants({ additional_conditions: p.banner } as never).includes("twoPerson"), p.banner ?? "");
  t("あかり: 直した後の条件は二人入居を求めない", !detectConditionWants({ preferences: p.updates.preferences, other_requests: AKARI.other_requests } as never).includes("twoPerson"));
  const q = planHouseholdConditions({ ...AKARI, preferences: p.updates.preferences as string }, null, smallerOkOf("ここの部屋に似た感じでちっさくて大丈夫です！"));
  t("あかり: 小さくて大丈夫（広さの列が空）→ 列は変えず帯だけ", Object.keys(q.updates).length === 0 && !!q.banner, JSON.stringify(q));
}
t("「少し狭くなっても大丈夫なのですが。」→ 広さの下限を外す", (() => { const p = planHouseholdConditions({ floor_area_min: 25, preferences: "広め・南向き" }, null, smallerOkOf("少し狭くなっても大丈夫なのですが。")); return p.updates.floor_area_min === null && p.updates.preferences === "南向き"; })());
t("「別れたので別でお家探したい」→ 一人になる", householdChangeOf("お世話になっております。あの後ご連絡しておらず申し訳ございません💦\n別れたので別でお家探したいのですが可能でしょうか？")?.kind === "to_single");
t("二人になる → 二人入居可を足す", planHouseholdConditions({ preferences: "独立洗面台" }, { kind: "to_two", evidence: "" }, false).updates.preferences === "独立洗面台・二人入居可");
t("ペットを手放す → ペットの節を外す", planHouseholdConditions({ preferences: "ペット可(小型犬)・2階以上" }, householdChangeOf("犬は実家に譲ることになりました"), false).updates.preferences === "2階以上");
t("家族が増える → 列は変えず帯だけ", (() => { const p = planHouseholdConditions({ floor_plan: "1LDK" }, householdChangeOf("10ヶ月後にパートナーのお腹にいる子供が生まれる予定なので、"), false); return Object.keys(p.updates).length === 0 && !!p.banner; })());
// 触らない
t("申込の書類の「入居者は私一人になります」は世帯の変わり目ではない", householdChangeOf("代理契約で、入居者は私一人になります！") === null);
t("「一人で内覧に行きます」は読まない", householdChangeOf("当日は一人で内覧に行きます") === null);
t("物件の URL の問い合わせは読まない", householdChangeOf("https://suumo.jp/chintai/xx この部屋二人入居できますか") === null);
t("世帯の話が無ければ何もしない", planHouseholdConditions(AKARI, null, false).banner === null);
t("一人になっても二人入居の節が無ければ列は変えない", Object.keys(planHouseholdConditions({ preferences: "独立洗面台" }, { kind: "to_single", evidence: "" }, false).updates).length === 0);
// 申込のフォーマットの単独／同居ありも新しい発言に合わせる
t("co-resident: 「私一人になるかもです」が後なら単独", detectCoResident(["二人入居で探しています", "私一人になるかもです"]).value === "single");
// 区切りは元のまま（9e04d916 の実物の その他）
{
  const o = "バストイレ別、洗濯機置場が洗面所にある所、キッチン狭くない、オートロック、2階以上、フローリング、お風呂場のお湯と水が別れてない所、二人入居可、なるべく新しく";
  const p = planHouseholdConditions({ preferences: "", other_requests: o }, householdChangeOf("別れたので別でお家探したいのですが可能でしょうか？"), false);
  t("区切り「、」は元のまま・二人入居可だけ外す", p.updates.other_requests === o.replace("、二人入居可", ""), String(p.updates.other_requests));
  t("先頭の節を外す時も区切りが残らない", planHouseholdConditions({ preferences: "二人入居可・独立洗面台" }, { kind: "to_single", evidence: "" }, false).updates.preferences === "独立洗面台");
}
console.log(`\n合計: ${pass}/${pass + fail}`); if (fail) process.exit(1);
