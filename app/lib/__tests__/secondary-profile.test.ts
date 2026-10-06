// app/lib/__tests__/secondary-profile.test.ts — 1人のお客様の2つ目の探し物を別の行に分ける（実行: npx tsx app/lib/__tests__/secondary-profile.test.ts）
// 2026-10-06 ⑫ 竹内さん（ゆいと）「ゆいとさん物件 ゆいとさん物置 と2つに分ければ拡張ツールで検索するさいも検索しやすい」
import { secondaryNeedOf, secondaryConditionsOf, readConditionStatements } from "../condition-reading";
import { planSecondaryProfile, secondaryProfileName, mergeSecondaryConditions } from "../secondary-profile";

let pass = 0, fail = 0;
const t = (name: string, ok: boolean, extra = "") => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name} ${extra}`); } };

// ゆいとの実物
const Y1 = "あともう一つ仕事用で家賃安ければ安いほどいい、物件茨木、豊中で探してるのですがありますでしょうか？";
const Y2 = "家賃2万以下とかないでしょうか？\n物置として使いたいくらいです。";
t("9/23「もう一つ仕事用で…茨木、豊中で探してる」→ 2つ目の探し物（仕事用）", secondaryNeedOf(Y1)?.label === "仕事用");
t("9/24「物置として使いたい」→ 2つ目の探し物（物置）", secondaryNeedOf(Y2)?.label === "物置");
t("9/24 の家賃は2つ目の探し物の上限（2万）", secondaryConditionsOf(Y2).rent_max === 20000);
t("9/23 の地名（茨木・豊中）", secondaryConditionsOf(Y1).desired_area === "茨木・豊中", String(secondaryConditionsOf(Y1).desired_area));
t("本番: 倉庫兼ガレージの依頼 → 物置", secondaryNeedOf("倉庫兼ガレージ、での物件探すことはできますでしょうか？")?.label === "物置");
// 読まない（住まいの条件・近くの駐車場・事務所への行き方・書類の画像）
t("「駐車場あれば嬉しい」は住まいの条件", secondaryNeedOf("駐車場あれば嬉しいです") === null);
t("「近隣月極駐車場はありますか」は住まいの物件の近く（AIX 近隣の月極駐車場）", secondaryNeedOf("あと近隣月極駐車場はありますか？？") === null);
t("「事務所から内見する物件までクルマで案内」は読まない", secondaryNeedOf("内見は現地集合ということは、事務所から内見する物件までクルマで案内はないでしょうか？") === null);
t("「今事務所として利用させてもらってる…住所に送って」は読まない", secondaryNeedOf("そう致しましたら今事務所として利用させてもらってる\n大阪府摂津市別府２丁目\nこちらの住所にお送りいただいた方が") === null);
t("画像の書き起こし（保険の入金）は読まない", secondaryNeedOf("[画像] フレックス少額短期保険 / 店舗 / 入金完了") === null);
t("住まいの条件の文は住まいのまま", secondaryNeedOf("天王寺か阿倍野あたりで1LDK、家賃10万までで探せますか？") === null && readConditionStatements("天王寺か阿倍野あたりで1LDK、家賃10万までで探せますか？").length > 0);

// 子を作るか直すか
const now = Date.parse("2026-09-24T09:00:00Z");
t("子が無い → 作る", planSecondaryProfile([], "仕事用", now).action === "create");
{
  const p = planSecondaryProfile([{ id: "k1", profile_label: "仕事用", updated_at: "2026-09-23T06:30:00Z" }], "物置", now);
  t("あいまいな「仕事用」の翌日に「物置」→ 同じ子を物置に直す（ゆいとさん物置）", p.action === "update" && p.id === "k1" && p.label === "物置" && (p as { relabel: boolean }).relabel === true, JSON.stringify(p));
}
t("同じ種類 → その子", planSecondaryProfile([{ id: "k1", profile_label: "物置", updated_at: "2026-09-01T00:00:00Z" }], "物置", now).action === "update");
t("別の具体的な種類（物置の後に店舗）→ 別の子を作る", planSecondaryProfile([{ id: "k1", profile_label: "物置", updated_at: "2026-09-23T00:00:00Z" }], "店舗", now).action === "create");
t("子の名前", secondaryProfileName("ゆいと", "物置") === "ゆいと（物置）" && secondaryProfileName("ゆいと（仕事用）", "物置") === "ゆいと（物置）");
{
  const m = mergeSecondaryConditions({ desired_area: "茨木・豊中", rent_max: null, other_requests: null }, secondaryConditionsOf(Y2));
  t("子の条件: 家賃2万・地名は今のまま・メモを足す", m.rent_max === 20000 && !("desired_area" in m) && String(m.other_requests).includes("物置"), JSON.stringify(m));
}
console.log(`\n合計: ${pass}/${pass + fail}`); if (fail) process.exit(1);
