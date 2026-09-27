// app/lib/__tests__/rent-raise.test.ts
// 2026-09-27 竹内「こういうの来たら AIX モードだと家賃を上げて物件検索する形になっているか。今回のお客さん家賃10万までなので12万円まで上げる」
// 文は本番のお客様の実物（2026-03〜09-27 の「家賃・予算 × 上げ/高くても」を全部拾った21通）と竹内さんの例。
// 実行: npx tsx app/lib/__tests__/rent-raise.test.ts（全 PASS で exit 0）
import { detectRentRaiseRequest, computeRaisedRentMax, statesRentMin, applyRentGuards, applyConditionGuards, roomJoMinInText, joToFloorAreaMin, floorAreaMinFromJo, isSingleRoomPlan, DEFAULT_RENT_RAISE_YEN } from "../rent-raise";

let pass = 0, fail = 0;
function t(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log(`  OK  ${name}`); }
  else { fail++; console.log(`  NG  ${name}${extra ? ` -- ${extra}` : ""}`); }
}
const eq = (name: string, a: unknown, b: unknown) => t(name, JSON.stringify(a) === JSON.stringify(b), `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);
const kind = (s: string) => { const r = detectRentRaiseRequest(s); return r ? (r.kind === "absolute" ? `abs:${r.toYen}` : r.kind === "delta" ? `delta:${r.deltaYen}` : "default") : null; };

console.log("■ 上げての依頼（実物）");
eq("野口 95019eb8（今回）", kind("もう少し家賃あげて、他の部屋もいただけたら、ありがたいです!"), "default");
eq("d8691e41", kind("もう少し家賃上げて良いので、\n新大阪、東三国でありそうですか？😭😭"), "default");
eq("2a86fda2 上限を11万まで", kind("お疲れ様です！\n物件の条件変更したくて\n家賃の上限を11万まで上げても大丈夫なのでミナミから徒歩40分圏内の場所にして欲しいです。\n急な連絡となって申し訳ないです。"), "abs:110000");
eq("c000080f 高くても9万までに上限上げ", kind("駅は環状線のみで調べてもらうことってできますか、？(汗)\nあと家賃は高くても9万までに上限上げようと思うので、なるべく最寄駅まで徒歩7分圏内で広めのお部屋ってありますかね、？無理言ってすみません。"), "abs:90000");

console.log("■ 上げての依頼（言い方）");
eq("1万上げて", kind("家賃1万上げてください"), "delta:10000");
eq("5千円アップ", kind("家賃5千円アップしても大丈夫です"), "delta:5000");
eq("12万でも", kind("予算は12万でも大丈夫です"), "abs:120000");
eq("12万に上げて", kind("家賃を12万に上げてもらえますか"), "abs:120000");
eq("9万5千円まで", kind("家賃9万5千円まで上げても大丈夫です"), "abs:95000");
eq("予算上げます", kind("予算上げますので他のもお願いします"), "default");
eq("家賃高くてもいい", kind("家賃もう少し高くてもいいので広い部屋がいいです"), "default");
eq("家賃高めでも", kind("家賃高めでも大丈夫です"), "default");

console.log("■ 上げての依頼でない（実物）");
eq("684551d4 厳しい", kind("家賃をあげるのは厳しいです。"), null);
eq("533b20d0 初期費用", kind("初期費用少し高くても大丈夫です！"), null);
eq("533b20d0 交渉", kind("二匹で交渉してほしいです\n少し家賃上がってもいーので"), null);
eq("62d01e33 質問", kind("福島ってなると野田駅周辺より家賃って上がりますか？💭"), null);
eq("217a4b44 気になる", kind("いただいた2つだと、フォーレス・ウィンは少し狭くなってしまう割に家賃が上がってしまうのが気になってしまっています。"), null);
eq("9280fa49 質問", kind("その分家賃が少し上がる感じですか？"), null);
eq("ca571e21 保証料", kind("相見積もり取ると\n保証料がもう少し高く出てきます.."), null);
eq("05a98e6f 値下げ", kind("・家賃を2,000円お値下げ\n・フリーレント1ヶ月を付けていただく"), null);
eq("YUMA 以上がいい", kind("梅田まで30分以内で、家賃7万くらいまでの1Kか1DK探してます！2階以上がいいです"), null);
eq("上げたくない", kind("家賃は上げたくないです"), null);
eq("徒歩の上限", kind("徒歩の上限を上げてもいいです"), null);
eq("初期費用の予算", kind("初期費用の予算を上げても大丈夫です"), null);

console.log("■ 上限の計算（竹内さん: 10万→12万）");
eq("既定 +2万", computeRaisedRentMax(100000, { kind: "default", evidence: "" }), 120000);
eq("既定の幅は2万", DEFAULT_RENT_RAISE_YEN, 20000);
eq("+1万", computeRaisedRentMax(100000, { kind: "delta", deltaYen: 10000, evidence: "" }), 110000);
eq("金額 11万", computeRaisedRentMax(100000, { kind: "absolute", toYen: 110000, evidence: "" }), 110000);
eq("金額が今以下 → 上げない", computeRaisedRentMax(100000, { kind: "absolute", toYen: 90000, evidence: "" }), null);
eq("登録の上限なし・相対 → 上げない", computeRaisedRentMax(null, { kind: "default", evidence: "" }), null);
eq("登録の上限なし・金額 → その金額", computeRaisedRentMax(null, { kind: "absolute", toYen: 90000, evidence: "" }), 90000);

console.log("■ 下限をはっきり言ったか");
t("8万以上", statesRentMin("家賃8万以上で"));
t("8万〜10万", statesRentMin("8万〜10万くらいで"));
t("7万から9万", statesRentMin("7万から9万で探してます"));
t("下限", statesRentMin("下限は7万でお願いします"));
t("野口（下限なし）", !statesRentMin("もう少し家賃あげて、他の部屋もいただけたら、ありがたいです!"));
t("〜10万（上限だけ）", !statesRentMin("家賃〜10万まで"));
t("11万まで", !statesRentMin("家賃の上限を11万まで上げても大丈夫"));

console.log("■ 抽出に当てる（P4）");
{
  // 実物: Haiku がスタッフの文「合計88,000円」を下限と読んだ
  const r = applyRentGuards("もう少し家賃あげて、他の部屋もいただけたら、ありがたいです!", { rent_max: 100000, rent_min: null },
    { rent_min: 88000, other_requests: "現在提示された物件より家賃を上げた複数の他物件を希望" }, "p4");
  eq("野口: 下限 88000 を外す・上限 10万→12万", { min: r.extracted.rent_min, max: r.extracted.rent_max, other: !!r.extracted.other_requests }, { min: undefined, max: 120000, other: true });
}
{
  const r = applyRentGuards("家賃の上限を11万まで上げても大丈夫です", { rent_max: 90000 }, { rent_max: 110000 }, "p4");
  eq("金額あり: 11万", r.extracted.rent_max, 110000);
}
{
  const r = applyRentGuards("もう少し家賃上げて良いので", { rent_max: 80000 }, { rent_max: 70000 }, "p4");
  eq("LLM が下げた上限を上書き: 8万→10万", r.extracted.rent_max, 100000);
}
{
  const r = applyRentGuards("家賃8万〜10万で探してます", { rent_max: 90000 }, { rent_min: 80000, rent_max: 100000 }, "p4");
  eq("下限を言った時は残す", { min: r.extracted.rent_min, max: r.extracted.rent_max }, { min: 80000, max: 100000 });
}
{
  const r = applyRentGuards("ペット可でお願いします", { rent_max: 90000 }, { preferences: "ペット可" }, "p4");
  eq("家賃の話でない → 触らない", r.extracted, { preferences: "ペット可" });
}

console.log("■ 抽出に当てる（ブレインの橋・条件ブレイン＝follow: 二重に上げない）");
{
  const r = applyRentGuards("もう少し家賃あげて、他の部屋もいただけたら、ありがたいです!", { rent_max: 120000 }, { rent_max: 140000, rent_min: 88000 }, "follow");
  eq("相対の上げは家賃に触らない", { min: r.extracted.rent_min, max: r.extracted.rent_max }, { min: undefined, max: undefined });
}
{
  const r = applyRentGuards("家賃の上限を11万まで上げても大丈夫です", { rent_max: 110000 }, { rent_max: 110000 }, "follow");
  eq("金額ありは同じ値（何度当てても同じ）", r.extracted.rent_max, 110000);
}

console.log("■ 洋室の広さ（未桜さん 22b2511e）");
eq("未桜 7畳以上", roomJoMinInText("何回も送ってきてもらってるのにすみません🥲\n大国町エリアで1Kでできたら7畳以上の部屋で探してます🙇🏻‍♀️🙇🏻‍♀️\nよろしくお願いします"), 7);
eq("7帖以上", roomJoMinInText("洋室7帖以上がいいです"), 7);
eq("1K(7畳)以上", roomJoMinInText("1K(7畳)以上"), 7);
eq("８帖はほしい（全角）", roomJoMinInText("８帖はほしいです"), 8);
eq("LDK12帖以上は洋室でない", roomJoMinInText("LDK12帖以上"), null);
eq("帖の話なし", roomJoMinInText("大国町で1Kでお願いします"), null);
eq("換算 7帖→19㎡", joToFloorAreaMin(7), 19);
eq("換算 6帖→17㎡", joToFloorAreaMin(6), 17);
{
  const r = applyConditionGuards("大国町エリアで1Kでできたら7畳以上の部屋で探してます", { rent_max: 90000, floor_area_min: 25 },
    { desired_area: "大国町エリア", floor_plan: "1K", preferences: "7畳以上の部屋" }, "p4");
  eq("未桜: 面積の下限 25→19・文字の希望は残す", { a: r.extracted.floor_area_min, p: r.extracted.preferences, rent: r.extracted.rent_max }, { a: 19, p: "7畳以上の部屋", rent: undefined });
}
console.log("■ 帖→㎡ は 1R・1K だけ（監査で見つけた誤り）");
eq("はるか（1LDK 35㎡）「洋室4畳以上は欲しい」→ 換算しない", floorAreaMinFromJo("ありがとうございます😊\n洋室4畳以上は欲しいです、、\n\nまた新着出たらお願いします🙇‍♂️", "1LDK"), null);
eq("紗季「5帖の部屋にエアコンないのが気になって」（物件の感想）→ 帖の希望でない", roomJoMinInText("5帖の部屋にエアコンないのが気になって、\nこの部屋みたいに、２つの部屋ができるだけくっついていなくて"), null);
eq("🧸🤎「8畳以上の広いワンルームでもいいかな」→ 8帖・1R", floorAreaMinFromJo("8畳以上の広いワンルームでもいいかなとおもってます、、", "1R"), { jo: 8, sqm: 20 });
eq("文に 1LDK があれば換算しない", floorAreaMinFromJo("1LDKで洋室6帖以上", "1K"), null);
eq("間取りが分からない → 換算しない", floorAreaMinFromJo("7畳以上で", null), null);
eq("1K・1R は1部屋", [isSingleRoomPlan("1K・1R"), isSingleRoomPlan("1K 1LDK"), isSingleRoomPlan("1K〜1DK"), isSingleRoomPlan("ワンルーム")], [true, false, false, true]);
{
  const r = applyConditionGuards("ありがとうございます😊\n洋室4畳以上は欲しいです、、", { floor_area_min: 35, floor_plan: "1LDK" }, {}, "p4");
  eq("はるか: 35㎡ を壊さない", r.extracted.floor_area_min, undefined);
}
{
  const r = applyConditionGuards("7畳以上で25㎡以上がいいです", { floor_area_min: null }, { floor_area_min: 25 }, "p4");
  eq("㎡ を言った時は ㎡ のまま", r.extracted.floor_area_min, 25);
}

console.log(`\n${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
