// app/lib/__tests__/writing-blueprint-patterns.test.ts — 文の設計図の場面の型（実行: npx tsx app/lib/__tests__/writing-blueprint-patterns.test.ts）
//   文は作った例（実際のお客様の文は使わない）。LLM なし
import {
  detectBlueprintPatterns, buildBlueprintPatternNote, minutesSinceLastStaff, concreteConditionOf, fixKasaOnPromiseOnly, timingQuestionOf,
  isUnpointedCost, isRestateApology, likedButMismatchOf, isWidenPermission, ownDeadlineOf, customerOnegaiForm, mirrorClosingNotation, PATTERN_NOTE_MAX,
  type PatternCtx,
} from "../writing-blueprint-patterns";

let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`); } };
const ids = (c: PatternCtx) => detectBlueprintPatterns(c).map((h) => h.id);
const at = (min: number) => new Date(Date.parse("2026-10-20T07:00:00Z") + min * 60_000).toISOString();

// e0e83baa 続きの番
const contMsgs = [{ sender: "staff", text: "お部屋お送りさせて頂きました！！", createdAt: at(0) }, { sender: "customer", text: "テスト館の12階は空いてますか？", createdAt: at(2) }];
t("続き: 2分", minutesSinceLastStaff(contMsgs) === 2);
t("続き: 型が出る", ids({ scene: "question", customerText: "テスト館の12階は空いてますか？", messages: contMsgs }).includes("continuation"));
t("続き: 60分後は出ない", !ids({ scene: "question", customerText: "空いてますか？", messages: [contMsgs[0], { ...contMsgs[1], createdAt: at(60) }] }).includes("continuation"));
t("続き: お礼だけは出ない", !ids({ scene: "ack", customerText: "ありがとうございます！", messages: [contMsgs[0], { sender: "customer", text: "ありがとうございます！", createdAt: at(1) }] }).includes("continuation"));
t("続き: こちらの送信が無ければ null", minutesSinceLastStaff([{ sender: "customer", text: "a" }]) === null);

// 1bc5683e お客様の条件をそのまま
const pet = concreteConditionOf({ scene: "property_share", customerText: "ここは犬のみですか？", messages: [{ sender: "customer", text: "猫を1匹飼っています" }] });
t("猫の人の犬のみ→猫飼育可能か", pet?.phrase === "猫飼育可能か");
t("今の文が猫なら出さない", concreteConditionOf({ scene: "question", customerText: "猫は飼えますか", customerConditions: "猫1匹" }) === null);
t("前に事情が無ければ出さない", concreteConditionOf({ scene: "question", customerText: "ペット可ですか", messages: [] }) === null);
t("条件の欄からも拾う", concreteConditionOf({ scene: "question", customerText: "ペット相談ですか", customerConditions: "小型犬1匹" })?.phrase === "小型犬飼育可能か");

// c0b845e8 ご査収は送った時だけ
const d1 = "かしこまりました😊！！\nテスト館406号室の初期費用、最大限割引させて頂いた御見積書を作成しお送りさせて頂きます！！\nお手隙の際にご査収ください😌！！";
const k1 = fixKasaOnPromiseOnly(d1, { sentThisTurn: false, messages: [{ sender: "customer", text: "初期費用どれぐらいですか" }] });
t("約束だけの番のご査収を外す", !!k1.changed && !/ご査収/.test(k1.text) && /お送りさせて頂きます/.test(k1.text));
t("送る番は外さない", fixKasaOnPromiseOnly(d1, { sentThisTurn: true }).changed === null);
t("直前に資料を送っていれば外さない", fixKasaOnPromiseOnly(d1, { messages: [{ sender: "staff", text: "[画像]" }, { sender: "customer", text: "ありがとう" }] }).changed === null);
t("送った文（お送りさせて頂きました）は外さない", fixKasaOnPromiseOnly("御見積書お送りさせて頂きました！！\nお手隙の際にご査収ください😌！！", {}).changed === null);
t("初期費用の場面で型が出る", ids({ scene: "cost", customerText: "初期費用どれぐらいですか" }).includes("kasa_promise_only"));

// 9b8dbfca 時期の知識
t("時期: いつ頃から探せば", timingQuestionOf("12月末に引っ越したいのですがいつ頃から探せばいいですか？") === "when");
t("時期: 繁忙期", timingQuestionOf("4月とかの繁忙期より今の時期の方が家賃安いですかね") === "busy_season");
t("時期: 関係ない質問は出ない", timingQuestionOf("駐車場ありますか？") === null);

// adc4d260 指さない初期費用
t("指さない初期費用（5件送った後）", isUnpointedCost({ scene: "cost", customerText: "初期費用いくらですか？", propertiesSentCount: 5 }));
t("物件を指す時は出ない", !isUnpointedCost({ scene: "cost", customerText: "こちらの初期費用いくらですか？", propertiesSentCount: 5 }));
t("送っていなければ出ない", !isUnpointedCost({ scene: "cost", customerText: "初期費用いくらですか？", propertiesSentCount: 0 }));

// 317c7a7c 言い直しの謝り
t("言い直しの謝り", isRestateApology("何度もすみません🥺心斎橋より西側で考えてて"));
t("ただの謝りは出ない", !isRestateApology("返信遅れてすみません"));
const ra = detectBlueprintPatterns({ scene: "conditions", customerText: "何度もすみません、梅田より北側で考えてて", name: "テスト" }).find((h) => h.id === "restate_apology");
t("言い直し: 名前とご満足の1文", !!ra && ra.line.includes("テストさんご満足頂けるお部屋が見つかるのが一番"));

// d9fa213d 気に入ったが1つ合わない
t("気に入ったが入居日", likedButMismatchOf("テスト館めっちゃいいんですけど入居可能日が引っかかってまして") === "入居可能日");
t("気に入っただけは出ない", likedButMismatchOf("テスト館めっちゃいいです！") === null);

// bf2c0517 広げる許し
t("10分弱までなら大丈夫", isWidenPermission("今テスト町の7丁目なので駅まで10分弱ぐらいまでなら大丈夫です"));
t("希望は許しではない", !isWidenPermission("駅から5分以内がいいです"));
const wp = detectBlueprintPatterns({ scene: "conditions", customerText: "今テスト町の7丁目なので駅まで10分弱ぐらいまでなら大丈夫です" }).find((h) => h.id === "widen_permission");
t("今の住まいの事情を受け止める", !!wp && wp.line.includes("今の住まい"));

// d9533aad お客様の期日
t("今日中にまた連絡します", ownDeadlineOf("全部見て今日中にまた連絡します！") === "今日中");
t("決まり次第また連絡します は期日ではない", ownDeadlineOf("入居時期が決まり次第また連絡します！") === null);
t("期日の番は続きの型を出さない", !ids({ scene: "considering", customerText: "全部見て今日中にまた連絡します！", messages: [{ sender: "staff", text: "お送りしました", createdAt: at(0) }, { sender: "customer", text: "全部見て今日中にまた連絡します！", createdAt: at(1) }] }).includes("continuation"));

// 5192922a 書き方に合わせる
t("漢字の人", customerOnegaiForm({ customerText: "よろしくお願い致します。" }) === "kanji");
t("ひらがなの人", customerOnegaiForm({ customerText: "よろしくお願いいたします" }) === "kana");
t("前の発言から拾う", customerOnegaiForm({ customerText: "はい", messages: [{ sender: "customer", text: "宜しくお願い致します" }] }) === "kanji");
t("書いていなければ null", customerOnegaiForm({ customerText: "了解です" }) === null);
t("締めをひらがなに", mirrorClosingNotation("何卒よろしくお願い致します！！", "kana").text === "何卒よろしくお願いいたします！！");
t("同じなら変えない", mirrorClosingNotation("何卒よろしくお願い致します！！", "kanji").changed === null);

// 本番の候補で見つけた誤り（2026-10-23・文は作り直した例）
t("条件の記入欄は時期の質問ではない", timingQuestionOf("①【ご入居の時期】⇒いつでも ②【ご希望の家賃】⇒5万") === null);
t("内覧できる時期は物件の事", timingQuestionOf("2階のお部屋って内覧出来るのはいつ頃でしょうか？") === null);
t("時間の『何時でも大丈夫』は広げる許しではない", !isWidenPermission("5日って12:00~16:00の間だと何時でも大丈夫ってことですか？"));
t("家賃の上限を上げてもよい は許し", isWidenPermission("5.3万位まででも大丈夫です！"));
t("初期費用を抑えたい（金額を聞いていない）は指さない初期費用ではない", !isUnpointedCost({ scene: "cost", customerText: "初期費用もできるだけ抑えたいと思ってます", propertiesSentCount: 5 }));
t("分割の質問は指さない初期費用ではない", !isUnpointedCost({ scene: "cost", customerText: "初期費用分割とかできないですよね？", propertiesSentCount: 5 }));
t("その物件の入居時期は時期の相談ではない", timingQuestionOf("ここの入居はいつからいけるんですか？") === null);
t("申込の時期は時期の相談", timingQuestionOf("10月末入居希望だといつ頃申し込めばいいでしょうか？") === "when");
t("○枚目の物件は指している", !isUnpointedCost({ scene: "cost", customerText: "2枚目の物件の初期費用も知りたいです！", propertiesSentCount: 5 }));
t("片仮名の名前の中のネックは障害ではない", likedButMismatchOf("ならアネックスの方が気に入ってます！") === null);
t("明日の連絡は今日の圧の型ではない", ownDeadlineOf("明日また連絡させて頂きます。") === null);

// 注記
t("型が無ければ空", buildBlueprintPatternNote({ scene: "ack", customerText: "了解です" }) === "");
const big = buildBlueprintPatternNote({ scene: "cost", customerText: "何度もすみません、初期費用いくらですか？今日中にまた連絡します。駅まで10分までなら大丈夫です よろしくお願い致します", propertiesSentCount: 6, name: "テスト" });
t(`注記は ${PATTERN_NOTE_MAX} 字以内`, big.length > 0 && big.length <= PATTERN_NOTE_MAX);

console.log(`\n${pass} OK / ${fail} NG`);
if (fail) process.exit(1);
