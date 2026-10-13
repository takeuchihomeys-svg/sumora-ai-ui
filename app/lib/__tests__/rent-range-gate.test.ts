// app/lib/__tests__/rent-range-gate.test.ts — 2026-10-13 見積金額内訳ゲートが家賃の幅（条件の言い直し）を見積の金額と取り違えない
//   実行: npx tsx app/lib/__tests__/rent-range-gate.test.ts
import { isRentConditionRangeSentence, enforceAixGates, GROUND_SEP } from "../validate-reply";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`); } };

const s1 = "天王寺エリアから家賃6万〜8万円以内・1K、1R・駅徒歩10分以内、マンション・初期費用を抑えられるお部屋を改めてピックアップしてお送りさせて頂きます😊！！";
t("会話に有る家賃の幅（6万〜8万）は免除", isRentConditionRangeSentence(s1, { groundText: ["こんにちは", "家賃は6万〜8万以内で探しています"].join(GROUND_SEP) }, {}));
t("「6〜8万」の表記でも値でそろえる", isRentConditionRangeSentence(s1, { groundText: "家賃6〜8万くらいで" }, {}));
t("「60000〜80000」の表記でも", isRentConditionRangeSentence(s1, { customerConditions: "rent_min=60000 rent_max=80000" }, {}));
t("会話に無い数字（作った条件）は免除しない", !isRentConditionRangeSentence(s1, { groundText: "家賃7万以内で" }, {}));
const s2 = "大阪市内の上の方のエリアから、川原さんご希望の家賃7〜11万円・1DK〜2K・築10年以内・デザイナーズ・敷金礼金無料のお部屋をピックアップしてお送りさせて頂きます！！";
t("敷金礼金無料（金額でない条件）を含む幅の言い直しは免除", isRentConditionRangeSentence(s2, { groundText: "7万から11万くらいで敷金礼金無料がいいです" }, {}));
t("漢数字の条件（六万〜八万・実物 3db9db75）", isRentConditionRangeSentence(s1, { groundText: "六万〜八万 ワンケー、ワンルーム 10年以内 十分以内" }, {}));
t("条件のフォームの家賃の欄（⇒7〜11・実物 5befce17）", isRentConditionRangeSentence(s2, { groundText: "①【ご入居の時期】⇒10/1\n②【ご希望の家賃（◯万円〜◯万円）】⇒7〜11\n③【希望の広さ・間取り】⇒1DK" }, {}));
t("家賃の行の他の数字（徒歩10分）を万で読まない", !isRentConditionRangeSentence("家賃10万円以内のお部屋をピックアップさせて頂きます", { groundText: "家賃は駅から10分以内で" }, {}));
t("家賃条件10万円程（目安）", isRentConditionRangeSentence("家賃条件10万円程でしたら1DKや1LDKのお部屋をオススメいたします！！", { groundText: "予算は10万くらいです" }, {}));
// 止めるもの（従来どおり）
t("物件固有の金額（幅でない）は免除しない", !isRentConditionRangeSentence("コートエスト都島は1LDKで家賃管理費込99,000円となります！！", { groundText: "家賃管理費込99,000円" }, {}));
t("敷金の金額を含む文は免除しない", !isRentConditionRangeSentence("家賃7万円以内・敷金50,000円のお部屋です", { groundText: "家賃7万円以内 敷金50,000円" }, {}));
t("初期費用の金額は免除しない", !isRentConditionRangeSentence("初期費用10万円以内・家賃6万円以内のお部屋", { groundText: "初期費用10万円以内 家賃6万円以内" }, {}));
t("RENT_RANGE_NOT_ESTIMATE=off で旧", !isRentConditionRangeSentence(s1, { groundText: "家賃は6万〜8万以内" }, { RENT_RANGE_NOT_ESTIMATE: "off" }));

// ゲート全体（10/13 YUMA 再生の形: ピックアップの約束への了承に条件を言い直す → 旧は文ごと消えて「はい！！」だけ）
const draft = "はい😊！！\n難波周辺全域から家賃6〜7万円・1Kのご条件で、ピックアップ出来次第お送りさせて頂きますので、何卒よろしくお願い致します😌！！";
const ctx = { customerMessage: "よろしくお願いします", lastStaffMsg: "かしこまりました！！ピックアップしお送りさせて頂きます！！", groundText: ["難波で家賃六万〜七万の1Kを探してます", "かしこまりました！！ピックアップしお送りさせて頂きます！！", "よろしくお願いします"].join(GROUND_SEP), estimateAllowed: false };
const after = enforceAixGates(draft, ctx);
t("ゲートで消えない（家賃の幅の言い直し）", !after.edits.some((e) => e.rule === "見積金額内訳") && /6〜7万円/.test(after.cleaned));
process.env.RENT_RANGE_NOT_ESTIMATE = "off";
const before = enforceAixGates(draft, ctx);
delete process.env.RENT_RANGE_NOT_ESTIMATE;

t("旧（off）では消えていた", before.edits.some((e) => e.rule === "見積金額内訳"));

console.log(`\n${pass} pass / ${fail} fail`);
if (fail) process.exit(1);
