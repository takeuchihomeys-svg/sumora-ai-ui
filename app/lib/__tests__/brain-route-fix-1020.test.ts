// app/lib/__tests__/brain-route-fix-1020.test.ts — 2026-10-20 試験の道の外れ（見積・約束の後・不満→次の探し）の直し
//   実行: npx tsx app/lib/__tests__/brain-route-fix-1020.test.ts
import { routeFix1020, broughtTypedText, contractAixWhenTopEmpty, contractPromiseIsCheck, viewingCheckAlsoVacancy, concernRepickupTarget, concernRepickupAnswer, lastStaffReportedResult, checkAfterResultTurnOk } from "../brain-route-fix-1020";
import { broughtPropertyAsk, resolveTwoStage } from "../two-stage";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`); } };
const norm = (k: unknown) => (typeof k === "string" && k ? k : null);

// 切り替え
t("既定は off", routeFix1020("brought_text", {}) === false);
t("on で全部", routeFix1020("concern_repickup", { BRAIN_ROUTE_FIX_1020: "on" }));
t("名指し", routeFix1020("contract_aix", { BRAIN_ROUTE_FIX_1020: "contract_aix,brought_text" }) && !routeFix1020("promise_check", { BRAIN_ROUTE_FIX_1020: "contract_aix" }));
t("on でも1つ止める", !routeFix1020("focused_estimate", { BRAIN_ROUTE_FIX_1020: "on", BRAIN_ROUTE_FIX_1020_FOCUSED_ESTIMATE: "off" }));

// ① 画像の読み取りを除く（q184: SUUMO のボタン「最新の空室状況を知りたい」）
const q184 = ["[画像] 物件情報\nドルチェヴィータ新北野 3階\n無料 📧 最新の空室状況を知りたい", "ありがとうございます。初期費用まあまあしますね。\nこちらはどれくらいでしょうか？", "[画像] 物件情報\nエトワール北梅田 5階\n- 初期費用を知りたい"];
t("q184 旧は both", broughtPropertyAsk(q184.join("\n")) === "both");
t("q184 打った文だけ → cost", broughtPropertyAsk(broughtTypedText(q184)) === "cost");
const q183 = ["6万を切る物件ってどんな感じですか？", "[画像] 【物件名】フォーレ\n【現況/入居時期】空室/即入", "見積もり出してもらえますか？"];
t("q183 打った文だけ → cost", broughtPropertyAsk(broughtTypedText(q183)) === "cost");
t("空きを聞いた文は vacancy のまま", broughtPropertyAsk(broughtTypedText(["[画像] 資料", "ここ空いてますか？"])) === "vacancy");

// ② 持ち込みで費用だけ → 見積の2段
{
  const base = { finalAix: "property_check_result", decisionSource: "llm", pickupReady: false, postApply: false, customerText: "見積もり出してもらえますか？", ackOnly: false };
  process.env.BRAIN_ROUTE_FIX_1020 = "";
  const off = resolveTwoStage({ ...base, brought: { ask: "cost", count: 2 } });
  t("off: brought_both（check）", off?.kind === "check" && /brought_both/.test(off.source));
  process.env.BRAIN_ROUTE_FIX_1020 = "on";
  const on = resolveTwoStage({ ...base, brought: { ask: "cost", count: 2 } });
  t("on: brought_estimate（estimate・2件）", on?.kind === "estimate" && /brought_estimate/.test(on.source) && /2件/.test(on.direction));
  const both = resolveTwoStage({ ...base, brought: { ask: "both", count: 1 } });
  t("on: 空きも聞いた番は brought_both のまま", both?.kind === "check" && /brought_both/.test(both.source));
  process.env.BRAIN_ROUTE_FIX_1020 = "";
}

// ③ 最後の aix が空・依頼が route=aix
const tc184 = { lead_with: 0, asks: [{ route: "aix", aix: "estimate_sheet" }, { route: "aix", aix: "property_check_result" }] };
t("lead_with の AIX", contractAixWhenTopEmpty(tc184, norm) === "estimate_sheet");
t("lead_with 無し・2種類は決めない", contractAixWhenTopEmpty({ asks: tc184.asks }, norm) === null);
t("1種類なら決める", contractAixWhenTopEmpty({ asks: [{ route: "aix", aix: "estimate_sheet" }, { route: "reply" }] }, norm) === "estimate_sheet");
t("閉じる番は決めない", contractAixWhenTopEmpty({ ...tc184, close_only: true }, norm) === null);

// ⑤ 確認の約束（q177）
t("q177 確認させて頂きます（設備）", contractPromiseIsCheck({ asks: [{ route: "promise", answer: "確認させて頂きます", about: "property_equipment" }] }));
t("探す約束は確認にしない", !contractPromiseIsCheck({ asks: [{ route: "promise", answer: "ピックアップしてお送り", about: "search_condition" }] }));
t("返信だけは確認にしない", !contractPromiseIsCheck({ asks: [{ route: "reply", answer: "確認させて頂きます", about: "property_equipment" }] }));

// ⑤b 確認の結果の直後
t("q177 結果の17分後", lastStaffReportedResult({ text: "駐車場と礼金について管理会社へ確認・交渉させて頂きました！！駐車場空き1台のみ…とのことです😊！！", at: "2026-08-24T01:54:00Z" }, "2026-08-24T02:11:48Z"));
t("約束だけは結果でない", !lastStaffReportedResult({ text: "管理会社に確認させて頂きます！！確認出来次第ご連絡させて頂きます！！", at: "2026-08-24T01:54:00Z" }, "2026-08-24T02:11:48Z"));
t("7時間後は外す", !lastStaffReportedResult({ text: "確認させて頂きました", at: "2026-08-24T01:00:00Z" }, "2026-08-24T08:00:00Z"));

t("⑤b 結果の後の追いの質問は通す", checkAfterResultTurnOk("駐車場は2台目も借りれますか？", false));
t("⑤b q177 駐車場の空きの追いの質問は通す", checkAfterResultTurnOk("諸々ご確認ありがとうございます🙏🏻\n\n駐車場の空きは「軽」専用とかでは特にないですかね？？\nまた、礼金の件もありがとうございます！", false));
t("⑤b 持ち込み（URL）は外す", !checkAfterResultTurnOk("上野芝 2LDK https://suumo.jp/x こちらどうでしょう", false));
t("⑤b 画像の番は外す", !checkAfterResultTurnOk("ここはどうでしょうか？", true));
t("⑤b 別のお部屋の空きの問いは外す", !checkAfterResultTurnOk("12階は空いてますか？", false));

// ⑥ 内覧可否＋募集状況（q179）
t("q179 内覧可否と募集状況", viewingCheckAlsoVacancy("JS House・メイウール木川中里413のご内覧可否と募集状況を管理会社に確認させて頂きます！！"));
t("内覧可否だけ", !viewingCheckAlsoVacancy("高殿サンク内覧可能か確認させていただきます！！"));

// ⑦ 不満→探す約束（q170）
{
  const base = { concern: { topic: "設備", object: "お風呂が狭い" }, customerText: "ありがとうございますm(_ _)m\nお風呂が狭いと赤ちゃんのお風呂入れるのが難しいなって思っちゃって…💦", ackOnly: false, propertiesSent: true, finalAix: null, decisionSource: null, postApply: false, tc: { asks: [{ route: "reply", kind: "concern", about: "property_equipment" }] } };
  t("q170 当たる", concernRepickupTarget(base) === 0);
  t("問いは当てない", concernRepickupTarget({ ...base, customerText: "お風呂は広いですか？" }) === null);
  t("費用の懸念は当てない", concernRepickupTarget({ ...base, concern: { topic: "費用", object: "初期費用まあまあ" } }) === null);
  t("送る前は当てない", concernRepickupTarget({ ...base, propertiesSent: false }) === null);
  t("AIX がある番は当てない", concernRepickupTarget({ ...base, finalAix: "estimate_sheet" }) === null);
  t("約束がある番は当てない", concernRepickupTarget({ ...base, tc: { asks: [{ route: "promise", kind: "concern" }] } }) === null);
  const a = concernRepickupAnswer("お風呂が狭い");
  t("答えの文 お風呂広め・ピックアップ・確認なし", /お風呂広め/.test(a) && /ピックアップ/.test(a) && !/確認/.test(a));
}

console.log(`\n${pass} OK / ${fail} NG`);
if (fail) process.exit(1);
