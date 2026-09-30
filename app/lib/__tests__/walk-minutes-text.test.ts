// app/lib/__tests__/walk-minutes-text.test.ts — 実行: npx tsx app/lib/__tests__/walk-minutes-text.test.ts
// 2026-09-30 YUMA「これからは駅10分以内でお願いします」で登録の徒歩が変わらなかった件（app/lib/walk-minutes-text.ts）。
//   文は本番のお客様の発言そのまま（scripts/audit-walk-minutes.ts・180日・近い文 279件のうち読めた 30件と読まない文を目で読んだ物）
import { walkMinutesInText } from "../walk-minutes-text";
import { classifyConditionTurn, gateExtractedConditions, isRequestOnlyClause } from "../condition-source-gate";

let pass = 0, fail = 0;
function eq(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name} -- got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); }
}

console.log("── 読む（上限を言い切っている）");
eq("★ YUMA「これからは駅10分以内でお願いします」", walkMinutesInText("これからは駅10分以内でお願いします"), 10);
eq("徒歩10分以内", walkMinutesInText("徒歩10分以内でお願いします"), 10);
eq("駅から5分以内", walkMinutesInText("駅から5分以内がいいです"), 5);
eq("全角の数字", walkMinutesInText("駅から徒歩１０分以内"), 10);
eq("実物: 浪速区 中央区辺りで 駅から徒歩10分以内 築15年以内", walkMinutesInText("浪速区 中央区辺りで\n駅から徒歩10分以内\n築15年以内"), 10);
eq("実物: 最寄り駅から徒歩10分以内", walkMinutesInText("・家賃：50万円以内\n・最寄り駅から徒歩10分以内\n・築15年以内"), 10);
eq("実物: 駅から徒歩10分圏内でなるべく綺麗な部屋で", walkMinutesInText("藤井寺、富田林、羽曳野市あたりで2LDK以上で家賃7万以下駐車場付き、風呂トイレ別 独立洗面台、駅から徒歩10分圏内でなるべく綺麗な部屋で初期費用5万くらいのところないですか？"), 10);
eq("実物: 駅から15分以内、難波、梅田まで30〜４０分以内（通勤の節は読まず徒歩だけ）", walkMinutesInText("エアコンつき、 駅から15分以内、難波、梅田まで30〜４０分以内、古くてもリノベーションされていればok"), 15);
eq("実物: 1DKで駅から徒歩10分圏内で家賃8万位内はないですよね", walkMinutesInText("探してみてて、1DKで駅から徒歩10分圏内で家賃8万位内はないですよね、？💦"), 10);
eq("実物: 徒歩30分圏内ならありますか?", walkMinutesInText("徒歩30分圏内ならありますか?"), 30);
eq("駅徒歩5分以内（箇条書き）", walkMinutesInText("* 大国町・なんば・心斎橋 ・西大橋・島之内エリア、駅徒歩5分以内"), 5);
eq("歩いて7分まで", walkMinutesInText("最寄駅まで歩いて7分までだと嬉しいです"), 7);
eq("2つあれば最初（言い切った上限）", walkMinutesInText("徒歩10分以内、できれば5分以内"), 10);

console.log("── 読まない（上限でない・通勤・駅名つき・場所からの徒歩・他の乗り物）");
eq("実物: 駅から7分ってめっちゃ良いところでしたね（感想）", walkMinutesInText("駅から7分ってめっちゃ良いところでしたね🥲 残念です"), null);
eq("実物: 物件の貼り付け「西中島南方駅 徒歩6分」", walkMinutesInText("【賃貸マンション】 Osaka Metro御堂筋線 西中島南方駅 徒歩6分 https://www.homes.co.jp/chintai/b-1553370005146/"), null);
eq("実物: 全部徒歩20分とかでなくて", walkMinutesInText("自分でも探したりはしたんですけど、全部徒歩20分とかでなくて"), null);
eq("実物: 駅徒歩3分〜5分とかで（上限の言い切りでない）", walkMinutesInText("駅徒歩3分〜5分とかで"), null);
eq("実物: 駅徒歩10分程度（程度は上限でない）", walkMinutesInText("大阪市内でペット可2LDK駅徒歩10分程度 家賃17万前後で初期費用安い物件ありますか？？"), null);
eq("実物: ミナミから徒歩40分圏内の場所（駅でない場所からの徒歩）", walkMinutesInText("家賃の上限を11万まで上げても大丈夫なのでミナミから徒歩40分圏内の場所にして欲しいです。"), null);
eq("実物: ミナミ周辺(徒歩15分圏内)", walkMinutesInText("お部屋ミナミ周辺(徒歩15分圏内)で、オートロック、バストイレ別、独立洗面台ワンルームで探せますか？"), null);
eq("通勤: 梅田駅まで30分以内", walkMinutesInText("梅田駅まで30分以内で行けるところ"), null);
eq("通勤: なんばまで電車で20分以内", walkMinutesInText("なんばまで電車で20分以内"), null);
eq("通勤: 職場まで徒歩でなく30分以内", walkMinutesInText("職場まで30分以内がいいです"), null);
eq("駅名つきの駅（梅田駅10分以内）は読まない", walkMinutesInText("梅田駅10分以内"), null);
eq("自転車で10分以内", walkMinutesInText("駅まで自転車で10分以内"), null);
eq("バス10分以内", walkMinutesInText("バスで10分以内"), null);
eq("バス・トイレ別は乗り物ではない（同じ節の徒歩は読む）", walkMinutesInText("バス・トイレ別で徒歩10分以内"), 10);
eq("徒歩10分以上（以上は上限でない）", walkMinutesInText("徒歩10分以上かかるのはきついです"), null);
eq("0分・3桁は読まない", [walkMinutesInText("徒歩0分以内"), walkMinutesInText("徒歩100分以内")], [null, null]);
eq("空・null", [walkMinutesInText(""), walkMinutesInText(null), walkMinutesInText(undefined)], [null, null, null]);
eq("内覧の待ち合わせ「駅に10分前に」", walkMinutesInText("駅に10分前に着きます"), null);
eq("「あと10分で着きます」", walkMinutesInText("あと10分で駅に着きます"), null);

console.log("── 入口の見分け（condition-source-gate）: 徒歩の上限の節を「依頼だけ」で捨てない（YUMA 9/30 再テストで P4 が書けなかった本当の原因）");
{
  const t1 = classifyConditionTurn("これからは駅10分以内でお願いします");
  eq("YUMA: これからは駅10分以内でお願いします → 条件の節として残る", [t1.kind, t1.conditionText], ["condition", "これからは駅10分以内でお願いします"]);
  eq("その節の徒歩は関所を通る", gateExtractedConditions({ walk_minutes: 10 }, t1, { walk_minutes: 15 }).extracted, { walk_minutes: 10 });
  eq("依頼だけの節は今まで通り捨てる", isRequestOnlyClause("新着でオススメ物件あればご連絡お願いします"), true);
  eq("通勤の節（梅田駅まで30分以内でお願いします）は徒歩として拾わない", walkMinutesInText("梅田駅まで30分以内でお願いします"), null);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
