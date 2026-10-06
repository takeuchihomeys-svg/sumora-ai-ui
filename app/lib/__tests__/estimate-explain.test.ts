// app/lib/__tests__/estimate-explain.test.ts — 御見積書の「このお部屋の費用の事情」の文（実行: npx tsx app/lib/__tests__/estimate-explain.test.ts）
// 2026-10-06 ⑫ 竹内さん（R・カーサピエント 203号室の実送信）
import { estimateExplain, buildEstimateExplainNote, secondLinesFromCard } from "../estimate-explain";

let pass = 0, fail = 0;
const t = (name: string, ok: boolean, extra = "") => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name} ${extra}`); } };

// R・カーサピエント 203号室（10/04 の実送信）: 割引0円・仲介手数料 30,000＋税 3,000・クリーニング費用あり
{
  const e = estimateExplain({ account: "sumora", discountYen: 0, commissionYen: 33000, cleaningFeeYen: 44000 });
  t("札の行＝実送信と同じ", e.cardLine === "こちらの物件貸主様から報酬が出ないお部屋となりますので、仲介手数料33,000円となります。", String(e.cardLine));
  t("2通目＝実送信と同じ2文（クリーニング→報酬・最安値）",
    e.secondLines.join("\n") === "こちらのお部屋クリーニング費用はご契約時にお支払いの為費用が初期費用がかかる物件となります！！\n貸主様から報酬が出ない物件となりますので、スモ割は出来ませんが仲介手数料33,000円となりますので、最安値の費用でお取引させて頂きます😌！！", e.secondLines.join(" / "));
  t("注記は事実と入れる文だけ", /見積書の読み取り/.test(buildEstimateExplainNote(e)) && /33,000円/.test(buildEstimateExplainNote(e)));
}
// 7/21 フジパレス出来島 WESTII 103（実送信）: 割引0円・仲介手数料2,980円
{
  const e = estimateExplain({ account: "sumora", discountYen: 0, commissionYen: 2980 });
  t("2,980円 → 「スモ割が適用できないお部屋となっており、仲介手数料2,980円のみで」", e.cardLine === "スモ割が適用できないお部屋となっており、仲介手数料2,980円のみでご案内させていただきます！！", String(e.cardLine));
  t("2通目は 7/15 の実送信の形", e.secondLines[0] === "スモ割が出来ないお部屋となりますが、仲介手数料2,980円のみでご案内させていただきますので他社さんよりは初期費用抑えてご紹介可能です！！");
}
t("イエヤス・割引0円・手数料0円 → 実送信の形", estimateExplain({ account: "ieyasu", discountYen: 0, commissionYen: 0 }).secondLines[0] === "イエヤス割が出来ないお部屋となりますが、仲介手数料0円でご紹介させていただきます😊！！");
t("ギガ・割引0円・手数料0円 → 実送信の形", estimateExplain({ account: "giga", discountYen: 0, commissionYen: 0 }).secondLines[0] === "ギガ割が適用出来ないお部屋となりますが仲介手数料0円でご案内させていただきます！！");
t("イエヤス・手数料をいただくお部屋は作らない（物件ごと）", estimateExplain({ account: "ieyasu", discountYen: 0, commissionYen: 36000 }).secondLines.length === 0);
// 作らない
t("割引があるお部屋は今まで通り（事情の文なし）", (() => { const e = estimateExplain({ account: "sumora", discountYen: 20000, commissionYen: 2980 }); return !e.cardLine && e.secondLines.length === 0; })());
t("仲介手数料が読めない → 文を作らない（数字を作らない）", (() => { const e = estimateExplain({ account: "sumora", discountYen: 0, commissionYen: null }); return !e.cardLine && e.secondLines.length === 0; })());
t("割引が読めない → 文を作らない", estimateExplain({ account: "sumora", discountYen: null, commissionYen: 33000 }).cardLine === null);
t("事情が無ければ注記は空", buildEstimateExplainNote(estimateExplain({ account: "sumora", discountYen: 10000, commissionYen: 2980 })) === "");
// 2通目（aix-template-generate）は送った札の行から: R・カーサピエントの札（10/04 の実送信そのまま）
const R_CARD = "【カーサピエント 203号室】\n\n初期費用：355,880円\n\nスモラなら一般的な不動産業者より70,400円節約出来ます！！\n\n※ご入居日によって日割家賃が発生致します。\nこちらの物件貸主様から報酬が出ないお部屋となりますので、仲介手数料33,000円となります。";
t("札から2通目＝実送信の文", secondLinesFromCard(R_CARD, null)[0] === "貸主様から報酬が出ない物件となりますので、スモ割は出来ませんが仲介手数料33,000円となりますので、最安値の費用でお取引させて頂きます😌！！", JSON.stringify(secondLinesFromCard(R_CARD, null)));
t("事情の行の無い札 → 何も足さない", secondLinesFromCard("【A 101号室】\n初期費用：100,000円\n🌟20,000円割引させて頂き", null).length === 0);
console.log(`\n合計: ${pass}/${pass + fail}`); if (fail) process.exit(1);
