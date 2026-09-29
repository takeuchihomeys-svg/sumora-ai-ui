// app/lib/__tests__/condition-change-scope.test.ts
// 2026-09-27 竹内「一時調整か、そもそもの条件の切り替えかの判断をブレインが行う」。文は本番のお客様の実物（scripts/tmp の監査で読んだ物）。
// 実行: npx tsx app/lib/__tests__/condition-change-scope.test.ts（全 PASS で exit 0）
import { resolveConditionChangeScope, temporaryScopeCue, permanentScopeCue, normalizeBrainScope, preBrainMayWriteRegistered, planScopeRevert } from "../condition-change-scope";
import { buildTemporaryOverride, looksLikePropertyShare } from "../condition-scope-override";

let pass = 0, fail = 0;
function t(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log(`  OK  ${name}`); }
  else { fail++; console.log(`  NG  ${name}${extra ? ` -- ${extra}` : ""}`); }
}
const eq = (name: string, a: unknown, b: unknown) => t(name, JSON.stringify(a) === JSON.stringify(b), `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);
const sc = (text: string, brain: unknown = null) => { const d = resolveConditionChangeScope({ text, brainScope: brain }); return `${d.scope}/${d.by}`; };

console.log("■ 文の「今回だけ」の語（ブレインより強い）");
eq("みなみ 69d56ee7「15万円までにした場合の物件も」", sc("家賃を15万円までにした場合の物件も\nあれば教えていただけませんか？🥺", "permanent"), "temporary/text_temporary");
eq("今回だけ", sc("今回だけ難波周辺でも見てもらえますか？", "permanent"), "temporary/text_temporary");
eq("ついでに", sc("今の条件のままで大丈夫なんですけど、ついでに難波の方にもいいのあったら見てみたいです"), "temporary/text_temporary");
eq("参考に見たい", sc("参考に1LDKも見てみたいです"), "temporary/text_temporary");
t("Gen b5c7f58c「参考に致します」は今回だけの語でない（お礼）", temporaryScopeCue("ありがとうございます\n参考に致します\n\n他にこんな感じの物件は、城東区、鶴見区には無さそうですか？") === null);
t("「今回は見送ります」は条件の話でない", temporaryScopeCue("今回は見送ります") === null);
t("「内覧の場合どうなりますか」は仮の条件でない", temporaryScopeCue("内覧の場合どうなりますか") === null);

console.log("■ 文の「切り替え」の語");
eq("2a86fda2 条件変更したくて", sc("お疲れ様です！\n物件の条件変更したくて\n家賃の上限を11万まで上げても大丈夫なのでミナミから徒歩40分圏内の場所にして欲しいです。", "temporary"), "permanent/text_permanent");
eq("やっぱり", sc("もう少し安いとこがやっぱり良いです", "temporary"), "permanent/text_permanent");
eq("未桜 22b2511e「〜で探してます」", sc("何回も送ってきてもらってるのにすみません🥲\n大国町エリアで1Kでできたら7畳以上の部屋で探してます🙇🏻‍♀️🙇🏻‍♀️\nよろしくお願いします"), "permanent/text_permanent");
eq("〜じゃなくて", sc("ちなみに1LDKじゃなくて\n2LDKとかないでしょうか？"), "permanent/text_permanent");
t("「これから」だけでは切り替えにしない", permanentScopeCue("これから仕事なのでまた連絡します") === null);

console.log("■ 語が無ければブレイン（YUMA で本物のブレインが 野口さんの文を temporary と判断・2026-09-27）");
eq("野口 95019eb8 ブレイン temporary", sc("もう少し家賃あげて、他の部屋もいただけたら、ありがたいです!", "temporary"), "temporary/brain");
eq("天王寺付近で同じような条件で ブレイン permanent", sc("天王寺付近で同じような条件で部屋ありますか？", "permanent"), "permanent/brain");
eq("物件の質問 ブレイン none", sc("ここ内見可能でしょうか？", "none"), "none/brain");
eq("ブレインが出さない → 既定 permanent（竹内: 言い直しは登録の条件を直す）", sc("家賃10前後\n1ldk〜\n築年浅", null), "permanent/default");
eq("ブレインの形が違う → 既定", sc("南向きで5階以上希望です", "maybe"), "permanent/default");
eq("normalize", [normalizeBrainScope(" Temporary "), normalizeBrainScope("none"), normalizeBrainScope(1)], ["temporary", "none", null]);

console.log("■ ブレインより先の経路（P4・フォームの読み取り）");
eq("今回だけの語 → 書かない", preBrainMayWriteRegistered("家賃を15万円までにした場合の物件も\nあれば教えていただけませんか？").ok, false);
eq("未桜 → 書く", preBrainMayWriteRegistered("大国町エリアで1Kでできたら7畳以上の部屋で探してます").ok, true);
eq("野口 → 書く（語が無い・ブレインの後に戻す）", preBrainMayWriteRegistered("もう少し家賃あげて、他の部屋もいただけたら、ありがたいです!").ok, true);

console.log("■ ブレインが今回だけと決めた時に P4 の書き込みを戻す");
{
  const since = "2026-09-27T11:06:40Z";
  const rows = [
    { changed_field: "rent_max", old_value: "100000", new_value: "115000", created_at: "2026-09-27T11:06:52Z" },
    { changed_field: "rent_min", old_value: null, new_value: "88000", created_at: "2026-09-27T11:06:52Z" },
    { changed_field: "preferences", old_value: null, new_value: "広め", created_at: "2026-09-27T11:06:52Z" },
    { changed_field: "floor_plan", old_value: "1K", new_value: "1LDK", created_at: "2026-09-26T10:00:00Z" },
  ];
  const r = planScopeRevert(rows, { rent_max: 115000, rent_min: 88000, floor_plan: "1LDK", preferences: "広め" }, since);
  eq("上限・下限を書く前へ（こだわりの文字・発言より前の履歴は戻さない）", r.updates, { rent_max: 100000, rent_min: null });
  const r2 = planScopeRevert(rows, { rent_max: 125000, rent_min: 88000 }, since);
  eq("間に人が直した列は戻さない（竹内さんの手の 12.5万）", r2.updates, { rent_min: null });
  t("戻さない理由を残す", r2.skipped.some((s) => s.startsWith("rent_max")));
}

console.log("■ 今回だけの上書き（検索の一時調整・登録の条件は変えない）");
{
  const reg = { desired_area: "心斎橋", rent_max: 100000, floor_plan: "1K" };
  const a = buildTemporaryOverride("もう少し家賃あげて、他の部屋もいただけたら、ありがたいです!", reg);
  eq("野口: 家賃の上限だけ帯の決まりで 10万→11.5万", [a.override?.rent_max, a.override?.location, a.override?.rent_min], [115000, null, null]);
  const b = buildTemporaryOverride("家賃を15万円までにした場合の物件も\nあれば教えていただけませんか？🥺", { ...reg, rent_max: 120000 });
  eq("みなみ: 上限 15万", b.override?.rent_max, 150000);
  const c = buildTemporaryOverride("今回だけ難波周辺でも見てもらえますか？", reg);
  eq("今回だけ難波: 難波を足す（駅は文の中の物だけ）", c.override?.location?.stations, ["難波"]);
  const d = buildTemporaryOverride("今回だけ7畳以上のお部屋も見たいです", reg);
  eq("1K の 7畳以上 → 面積の下限 19㎡", d.override?.area_min, 19);
  eq("文に条件が無い → 上書きなし", buildTemporaryOverride("何個か比べたくて", reg).override, null);
}

console.log("■ お客様が送った物件の文からは上書きを作らない（監査: 天神ノ森駅だけ・3SLDK になっていた）");
for (const s of [
  "天神ノ森 3SLDK 1-2階 / https://suumo.jp/chintai/bc_100527213433/ / by SUUMO",
  "アドバンス大阪ソルテ\n大阪府大阪市大正区三軒家西１丁目25-6\n築8年\n7階\n65,000円\n管理費 8,000円\n1K\n25.08㎡\n\nアプリ上でご覧いただけます",
  "[画像] 【1件目の物件】 4.4万円 管理費等：6,000円 間：1DK",
]) {
  t(`物件の文: ${s.slice(0, 20)}`, looksLikePropertyShare(s) && buildTemporaryOverride(s, { rent_max: 70000 }).override === null);
}
t("条件の文は物件の文でない", !looksLikePropertyShare("家賃を15万円までにした場合の物件も"));

console.log(`\n${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
