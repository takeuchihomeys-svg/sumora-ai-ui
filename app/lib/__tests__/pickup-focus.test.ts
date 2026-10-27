// app/lib/__tests__/pickup-focus.test.ts（実行: npx tsx app/lib/__tests__/pickup-focus.test.ts）
//   条件の文は 90日の物件ピックアップした で竹内さんが送った番の実物の形（名前・場所の細部は伏せていない一般の条件だけ）
import { pickupFocusCandidates, pickupFocusNote, pickupFocusOneEnabled } from "../pickup-focus";

let pass = 0, fail = 0;
const t = (name: string, ok: boolean, info?: unknown) => { if (ok) pass++; else { fail++; console.log(`  NG  ${name}${info !== undefined ? ` → ${JSON.stringify(info)}` : ""}`); } };

{
  // 竹内さん「中央区・西区・浪速区周辺から…犬猫1匹ずつ飼育可能なお部屋全てお探し」
  const c = pickupFocusCandidates("エリア: 中央区 西区 浪速区\n間取り: 1LDK 2DK 2LDK\n家賃: 20万円以内\n希望: 犬猫1匹ずつ飼育可能物件のみ、キッチンのシンクが広い、新しい方が嬉しい、安ければ安い方が嬉しい");
  t("「のみ」が付いたペットが一番", c[0]?.label === "ペット" && /犬猫1匹ずつ/.test(c[0].phrase), c);
}
{
  // 竹内さん「本町・堺筋本町を重点的に ペット可のお部屋で…」
  const c = pickupFocusCandidates("エリア: 本町、堺筋本町\n家賃: 15万円以内\n希望: ペット可だと嬉しい・駅近希望", ["ペット可で探してほしいです"]);
  t("直近のお客様の文に出たペットが一番", c[0]?.label === "ペット", c);
  t("駅近は軸にしない", !c.some((x) => /駅近/.test(x.phrase)), c);
}
{
  // 竹内さん「中央区・浪速区から25㎡の広めの1K・1Rで…」
  const c = pickupFocusCandidates("エリア: 中央区・浪速区\n間取り: 1K・1R\n家賃: 12万円以内\nその他: 築浅希望、風呂トイレ別、家賃は低い方が良い、部屋は広い方が良い", ["25㎡以上の広めがいいです"]);
  t("直近に出た広さが一番", c[0]?.label === "広さ", c);
  t("最大2つ", c.length <= 2);
}
t("条件が無い時は空", pickupFocusCandidates("エリア: 天王寺\n家賃: 8万円以内").length === 0);
t("材料: 1つまで・候補つき", /1つまで/.test(pickupFocusNote([{ label: "ペット", phrase: "ペット可", score: 3 }])) && /ペット可（ペット）/.test(pickupFocusNote([{ label: "ペット", phrase: "ペット可", score: 3 }])));
t("材料: 候補なしはエリアの形", /周辺全域から/.test(pickupFocusNote([])));
t("既定 off", pickupFocusOneEnabled({}) === false && pickupFocusOneEnabled({ PICKUP_FOCUS_ONE: "on" }) === true);

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
