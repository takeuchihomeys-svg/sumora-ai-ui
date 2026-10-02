// app/lib/__tests__/final-check-overfire.test.ts — 2026-10-02 誤発火の3つの線（実行: npx tsx app/lib/__tests__/final-check-overfire.test.ts）
// 材料: 本番の実送信（scripts/audit-overfire-three.ts・365日・お客様の番に続くスタッフの手打ち 3,636通）。名前は伏せた
import { farewellOnMoveOutHit, duplicateOfSentApplies, customerStoppedSearch } from "../final-check-overfire";
import { detectSensitiveCase } from "../sensitive-case";
const SEP = "\n⁣\n";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean, extra = "") => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name} ${extra}`); } };

console.log("■ ① FAREWELL_ON_MOVEOUT_INFO");
t("転勤が無くなって見送り → 締めは正しい（当てない）", !farewellOnMoveOutHit("申し訳ありません。\n転勤の件無くなりましたので今回は見送りでお願いします。", "かしこまりました！！\nまたお部屋探しをされる際はいつでもお気軽にご連絡ください😊！！"));
t("今の家の退去の話（探し続ける）に締め → 当てる（規則の本来の相手）", farewellOnMoveOutHit("今の家は3月末退去予定です", "かしこまりました！！\nまたお部屋探しの際はお気軽にご連絡ください！！"));
t("転勤で引越し（探し続ける）に締め → 当てる", farewellOnMoveOutHit("4月から転勤になるので引越し先を探しています", "この度はありがとうございました！！"));
t("今の家の解約の句だけでは「やめた」と読まない", !customerStoppedSearch("今の家は3月末で解約します"));
t("generate-reply が none を渡せば当てない", !farewellOnMoveOutHit("今の家は3月末退去予定です", "またお部屋探しの際は", "none"));

console.log("■ ② DUPLICATE_OF_SENT（block にするのはお客様が了承・お礼だけの番）");
t("お礼だけ（朱莉の形）→ block", duplicateOfSentApplies("ありがとうございます！"));
t("「なるほど！かしこまりました」も了承", duplicateOfSentApplies("なるほど！かしこまりました"));
t("電話の時間の質問 → block しない（同じ問いに同じ答え）", !duplicateOfSentApplies(`15時半頃かけますので宜しくお願い致します。${SEP}お世話になります。\n本日電話いける時間ありますか？`));
t("到着の連絡 → block しない", !duplicateOfSentApplies("もうすぐ着きます！すみません🙇‍♀️"));
t("物件の URL → block しない", !duplicateOfSentApplies(`ありがとうございます！検討します😭${SEP}https://www.homes.co.jp/chintai/room/xxx`));
t("情報の送り直し（数字）→ block しない", !duplicateOfSentApplies(`あ、ほんとですね！\n申し訳ございません！${SEP}19690904です！`));

console.log("■ ③ SENSITIVE_CASE（app/lib/sensitive-case.ts）");
t("否決の仮定は当てない", detectSensitiveCase("今の家審査落ちた場合の候補です") === null && detectSensitiveCase("もし審査が通らなかった時に代理契約でも可能であれば") === null && detectSensitiveCase("ひとまずは針中野の物件の審査可否を急いで落ちた場合再度検討ですね。。") === null);
t("否決の結果・結果の問いは当てる", detectSensitiveCase("審査落ちたってことですかね？") === "審査否決" && detectSensitiveCase("審査ダメでしたか？") === "審査否決" && detectSensitiveCase("保証会社のところは審査通りませんでした。") === "審査否決");
t("物件1件をやめる（続けて探す）は当てない", [
  "中型、大型バイク\n置ける物件がいいので\ngm 粉浜やめます。\n\n物件理想オール電化",
  `19日にほかに見れそうな物件あればお願いします。${SEP}ここはやめときます💦`,
  "・コーポグリーンストーク 102号室\n\n(谷川ハイツはやめておきます)",
  "こちらはやばそうなんでやめときます。お知らせありがとうございます。",
  "そちらの物件拝見しましたが\n今回はやめておきます🙇🏻‍♀️💦",
].every((x) => detectSensitiveCase(x) === null));
t("引越し・申込をやめる／キャンセル・見送りは当てる", [
  "引越しやめます", "申込やめたいです", "先程の物件見送らせてください🙇‍♀️", "すみません、いったんキャンセルでお願いいたします。", "本日の内覧、キャンセルでお願いいたします。",
].every((x) => detectSensitiveCase(x) === "キャンセル・リスケ"));
console.log("■ ③（続き）残っていた候補3つ");
t("今の家の解約（探し続けている）は当てない", detectSensitiveCase("おはようございます。\n\n最寄り駅石橋阪大前6万までの1DK.1LDK,1Kの物件ありますか？\n明日物件解約します。\n\n入居が10/1に予定してます。\n9月いっぱいフリーレント、初期費用分割が出来るところ探してます。") === null);
t("「今の家は3月末で解約します」も当てない", detectSensitiveCase("今の家は3月末で解約します") === null);
t("申込・こちらの契約の解約は当てる", detectSensitiveCase("解約しますやっぱり") === "キャンセル・リスケ" && detectSensitiveCase("申込を解約したいです") === "キャンセル・リスケ");
t("自分の発言の取り消し（続けて進める）は当てない", detectSensitiveCase("取り消します。\n兄が仕事中断してくれるみたいで\n夜入力します。") === null);
t("申込・内覧の取り消しは当てる", detectSensitiveCase("申込取り消します") === "キャンセル・リスケ" && detectSensitiveCase("明日の内覧取り消します") === "キャンセル・リスケ");
t("画像の読み取りの中の約款の「否決」は当てない", detectSensitiveCase(`[画像] 重要事項説明書\n第12条 理事会の議決が否決された場合は…`) === null);
t("審査結果の通知の画面の「否決」は当てる", detectSensitiveCase("[画像] 審査結果のお知らせ 否決") === "審査否決");
t("審査の結果の問い・本当の否決・クレームは当てる", detectSensitiveCase(`[画像] 本人確認書類${SEP}お疲れ様です。\n審査ダメでしたか？`) === "審査否決" && detectSensitiveCase("そんな理由で否決になるんでしたら携帯契約の証明書出しますけど？") === "審査否決" && detectSensitiveCase("話が違うじゃないですか") === "クレーム");
t("条件フォームの「クレームが来て」は当てない（⑦ 10/01 の線のまま）", detectSensitiveCase("▶︎【お部屋お探し中！】\n⑧その他ご要望\n木造の為か、騒音がうるさいとクレームが来て疲れてます") === null);

console.log(`\n合計: ${pass}/${pass + fail}`); if (fail) process.exit(1);
