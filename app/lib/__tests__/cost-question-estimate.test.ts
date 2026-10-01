// app/lib/__tests__/cost-question-estimate.test.ts
// 2026-10-02 竹内さんの決定「費用の質問で 見積書送る が本当に合う時だけ」の回帰テスト。文は本番のお客様の発言（名前・番号は入れていない）。
// 実行: npx tsx app/lib/__tests__/cost-question-estimate.test.ts
import { resolveCostQuestionEstimate, costQuestionInputFrom, CLEAR_NOT_ESTIMATE_REASONS, type CostQuestionEstimateInput } from "../cost-question-estimate";

let pass = 0, fail = 0;
function t(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log(`  OK  ${name}`); }
  else { fail++; console.log(`  NG  ${name}${extra ? ` -- ${extra}` : ""}`); }
}
const base: CostQuestionEstimateInput = { turnText: "", turnHasImage: false, turnQuotesOurMessage: false, hoursSinceOurLastPropertySend: 2, estimateSentSinceLastPropertySend: false, customerSentPropertyEarlier: false };
const r = (text: string, o: Partial<CostQuestionEstimateInput> = {}) => resolveCostQuestionEstimate({ ...base, ...o, turnText: text });

console.log("── 見積書送る（スタッフが押した形）");
for (const s of [
  "初期費用いくらくらいですか？", "こちらの初期費用教えてください！", "ここは初期費用どんな感じですか？", "初期費用総額どのくらいですか？",
  "初期費用聞いてもいいですか？", "ファーイーストの初期費用を知りたいです！", "初期費用はわからないですかね？",
  "前回おすすめしてもらったブロッサム十三の初期費用はどのくらいになりそうですか？", "初期費用119.000円ですか？",
  "見積もり一度作ってもらうことはできますか？", "こちらの見積もりも欲しいです", "初期費用の見積もり出してもらえると助かります！",
]) { const x = r(s); t(`見積書送る: ${s}`, x.action === "estimate_sheet", JSON.stringify(x)); }
{
  const x = r("前に見積もりだしていただいた富士林プラザなんですけど…できればもう1回見積もりだしてほしいんですけど可能ですか？", { estimateSentSinceLastPropertySend: true });
  t("見積済みでも もう1回見積もり → 見積書送る", x.action === "estimate_sheet", JSON.stringify(x));
  const y = r("かしこまりました！ 10月15日に入居した場合いくらかかりますか？", { estimateSentSinceLastPropertySend: true });
  t("見積済みでも 入居日を変えた場合いくら → 見積書送る（再見積）", y.action === "estimate_sheet", JSON.stringify(y));
}

console.log("── 見積書送るにしない（スタッフは手打ち・他の動き）");
const notCases: Array<[string, string]> = [
  ["初期費用もう少し安くなりませんか？", "値下げ・交渉"],
  ["こちら、礼金下げることは厳しいですか🥲", "値下げ・交渉"],
  ["交渉お願いしたいです！", "値下げ・交渉"],
  ["そうですか💦 もうちょい初期費用頑張れないですか⁇", "値下げ・交渉"],
  ["初期費用30万以内にできないですか？", "値下げ・交渉"],
  ["もっと初期費用安くなる物件ないですか？", "もっと安い物件の依頼"],
  ["ありがとうございます( ; ; ) すみません 江坂くらい安い初期費用のおうちはないでしょうか( ; ; )", "もっと安い物件の依頼"],
  ["気になることがあります 火災保険は、いくらが目安ですか？", "費用の1項目"],
  ["ありがとございます。 これは退去時の必要金額知りたいです。", "費用の1項目"],
  ["見積もりありがとうございます🙇🏻‍♀️ 1度確認してまた改めて連絡させていただきます🙇🏻‍♀️", "見積書へのお礼・受け取り"],
  ["[画像] 御見積書 様  2026年9月6日  この度は、連産業株式会社をご利用頂き誠にありがとうございました。", "他社の御見積書"],
  ["ちなみになんですが、1LDKだと平均的に家賃いくらくらいなんでしょうか？", "相場・平均の質問"],
  ["その¥36,260 は 賃料¥32,000 水道代¥3,300 火災保険のNサポート¥990 の合計額でよろしいでしょうか？", "費用の1項目"],
  ["家賃は81,000円でよろしいでしょうか？", "金額の確かめ"],
];
for (const [s, reason] of notCases) { const x = r(s); t(`外す（${reason}）: ${s.slice(0, 40)}`, !x.estimate && x.reason === reason, JSON.stringify(x)); }
for (const [, reason] of notCases) t(`理由「${reason}」は LLM の判断も外す型`, CLEAR_NOT_ESTIMATE_REASONS.has(reason));

console.log("── 既存の決まり（先に効く）");
t("支払いの時期 → 既存", r("初期費用の支払いはいつですか？").reason.startsWith("既存:"));
t("家賃の線 → 既存", r("家賃をいくらまでにしたら、堺筋本町あたりに物件が出てきますか？").reason.startsWith("既存:"));

console.log("── 持ち込みの物件 → 物件確認した（募集状況の確認が先）");
{
  const x = r("ここの初期費用いくらですか？ TC天美南 1階 https://suumo.jp/chintai/bc_100527713926/ by SUUMO");
  t("SUUMO の URL＋初期費用いくら → 物件確認した", x.action === "property_check_result", JSON.stringify(x));
  const y = r("[画像] 物件情報  西田文化 2階  2.2万円/管理費 - 数 -　礼 -  間取り: 2K\n初期費用教えて欲しいです", { turnHasImage: true });
  t("ポータルの画像＋初期費用 → 物件確認した", y.action === "property_check_result", JSON.stringify(y));
  const z = r("[画像] こちらの物件の初期費用教えてください", { turnHasImage: true, turnQuotesOurMessage: true });
  t("こちらの通への引用の画像（ポータルの文字なし）→ 見積書送る", z.action === "estimate_sheet", JSON.stringify(z));
}

console.log("── 見積書は送り済み（再見積でない）→ 送り直さない");
t("見積済み＋初期費用いくら", !r("初期費用いくらですか？", { estimateSentSinceLastPropertySend: true }).estimate);

console.log("── 入力の組み立て（新しい順の通と AIX の記録）");
{
  const msgs = [
    { sender: "customer", text: "初期費用いくらですか？", created_at: "2026-10-02T03:00:10Z", quoted_message_id: "q1" },
    { sender: "staff", text: "🌟 一番オススメ ○○ 205号室", created_at: "2026-10-02T01:00:00Z" },
    { sender: "customer", text: "https://suumo.jp/chintai/x", created_at: "2026-10-01T23:00:00Z" },
  ];
  const aix = [{ aix_type: "estimate_sheet", created_at: "2026-10-01T00:00:00Z" }];
  const i = costQuestionInputFrom(msgs, aix);
  t("今回の連投は最後のこちらの通より後", i.turnText === "初期費用いくらですか？", i.turnText);
  t("引用返信", i.turnQuotesOurMessage);
  t("最後の物件の送付から約2時間", Math.abs((i.hoursSinceOurLastPropertySend ?? 0) - 2.0) < 0.1, String(i.hoursSinceOurLastPropertySend));
  t("見積書は物件の送付より前 → 送付後は未送", !i.estimateSentSinceLastPropertySend);
  t("その前にお客様が URL", i.customerSentPropertyEarlier);
}

console.log(`\n合計: ${pass}/${pass + fail}`);
if (fail > 0) process.exit(1);
