// 最終チェックのプロンプトの会社の事実・時間の決まりを company-facts と同じ出所から作る（2026-11-13 作業員9・弱い所 686・FC_FACTS_FROM_COMPANY）
// 実行: npx tsx app/lib/__tests__/final-check-facts-source.test.ts
import { buildAnomalyScanPrompt, buildContextCheckPrompt, type FinalCheckContext } from "../final-check";
import { fcFactsFromCompanyOn, companyPolicyLinesForCheck, nightPromiseRuleForCheck } from "../final-check-facts-source";
import { PROCEDURE_FACTS } from "../procedure-question";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean, extra: unknown = "") => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`, String(extra).slice(0, 300)); } };
const txt = (b: Array<{ text: string }>) => b.map((x) => x.text).join("\n");
// 実物の形（61845054・11/10・名前は伏せた）: 内覧の話の番に書き直しが支払い方法を足した
const draft = "〇〇さんお世話になっております！！\n全然大丈夫です😊\n初期費用のお支払い方法はお振込での一括のみでの対応となります！！\n内覧につきましては、日程のご案内をお送りさせて頂きます！！";
const ctx = { lastCustomerMessage: "後内とかもしたいです", recentMessages: [{ sender: "customer", text: "後内とかもしたいです" }], account: "sumora" } as unknown as FinalCheckContext;

delete process.env.FC_FACTS_FROM_COMPANY; delete process.env.COMPANY_FACT_PAYMENT_LUMP;
t("既定 off", !fcFactsFromCompanyOn({}));
const offA = txt(buildAnomalyScanPrompt(draft, ctx));
const offC = txt(buildContextCheckPrompt(draft, ctx));
t("off: 今までの直書き（クレジットカード払いに対応）のまま", offA.includes("クレジットカード払いに対応・緊急連絡先は必須"));
t("off: 時間の決まりは2か所のまま", offC.includes("日本の営業時間は一般的に9:00-18:00") && offC.includes("18時以降であれば実行不可能な約束"));

process.env.FC_FACTS_FROM_COMPANY = "on";
const onA = txt(buildAnomalyScanPrompt(draft, ctx));
const onC = txt(buildContextCheckPrompt(draft, ctx));
t("on: 直書きの段落が無くなる", !onA.includes("クレジットカード払いに対応・緊急連絡先は必須"), onA.slice(0, 200));
t("on: 支払い方法は company-facts の文（カード対応・3.24%）", /クレジットカード払いに対応している/.test(onA) && /3\.24/.test(onA));
t("on: 審査・入居の目安は PROCEDURE_FACTS と同じ文", onA.includes(PROCEDURE_FACTS.lead.replace(/\*\*/g, "").trim()));
t("on: スモラの会話はスモラの割引の事実だけ", /（sumora）/.test(onA) && !/（ieyasu・giga）/.test(onA));
t("on: 時間の決まりは1つ（夜は明日確認の形）", onC.includes(nightPromiseRuleForCheck()) && !onC.includes("日本の営業時間は一般的に9:00-18:00"));
process.env.COMPANY_FACT_PAYMENT_LUMP = "on";
const lump = companyPolicyLinesForCheck("sumora").join("\n");
t("竹内さんの答えが一括のみになれば判定役の事実も同じ向きに変わる", /一括のお振込のみ/.test(lump) && !/クレジットカード払いに対応している/.test(lump), lump.slice(0, 200));
t("一括のみの時、on のプロンプトも一括のみ", /一括のお振込のみ/.test(txt(buildAnomalyScanPrompt(draft, ctx))));
delete process.env.COMPANY_FACT_PAYMENT_LUMP; delete process.env.FC_FACTS_FROM_COMPANY;
t("アカウント不明はブランドの割引の事実を両方", /（sumora）/.test(companyPolicyLinesForCheck(null).join("\n")) && /（ieyasu・giga）/.test(companyPolicyLinesForCheck(null).join("\n")));
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
