// app/lib/__tests__/r10-decision.test.ts — 10巡目（10/08 竹内さんの答え）: 更に安く→代表確認／内覧当日の挨拶／同じ日の2通目は AIX を直接（実行: npx tsx app/lib/__tests__/r10-decision.test.ts）
import { customerAsksFurtherDiscount, furtherDiscountDaihyo } from "../further-discount";
import { viewingDayGreetingDue } from "../viewing-day-greeting";
import { resolveTwoStage, promiseKindsToday } from "../two-stage";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean, extra = "") => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name} ${extra}`); } };

// ① 更に安く（実送信の文）
for (const s of ["ここを検討中なんですが、値段もう少し安くなりませんか？", "こちら、礼金下げることは厳しいですか🥲", "初期費用これ以上抑えることは難しいですかね", "割引できませんか？"]) t(`更に安くの依頼: ${s}`, customerAsksFurtherDiscount(s));
for (const s of ["ただ家賃もう少し下がったりしないですよね、、、🥲", "安いのには何か理由があるのでしょうか？", "初期費用いくらですか？", "ありがとうございます！"]) t(`更に安くではない: ${s}`, !customerAsksFurtherDiscount(s));
t("御見積書の後だけ", furtherDiscountDaihyo({ turnText: "もう少し安くなりませんか？", estimateSent: true, postApply: false, env: {} }) && !furtherDiscountDaihyo({ turnText: "もう少し安くなりませんか？", estimateSent: false, postApply: false, env: {} }));
t("申込以降は当てない", !furtherDiscountDaihyo({ turnText: "もう少し安くなりませんか？", estimateSent: true, postApply: true, env: {} }));
t("FURTHER_DISCOUNT_DAIHYO=off", !furtherDiscountDaihyo({ turnText: "もう少し安くなりませんか？", estimateSent: true, postApply: false, env: { FURTHER_DISCOUNT_DAIHYO: "off" } }));
t("2段は代表確認の AIX を約束の返信にしない", resolveTwoStage({ finalAix: "acknowledge_check", decisionSource: "rule:further_discount_daihyo", pickupReady: false, postApply: false }) === null);

// ② 確定した内覧の当日の挨拶
const now = Date.parse("2026-10-08T00:30:00Z"); // JST 9:30
t("今日の内覧・まだ挨拶なし → 出す", viewingDayGreetingDue({ appointmentDay: "today", staffMessages: [{ text: "待ち合わせ場所は…", createdAt: "2026-10-06T05:00:00Z" }], nowMs: now, env: {} }));
t("今日すでに『本日何卒よろしくお願い致します』→ 出さない", !viewingDayGreetingDue({ appointmentDay: "today", staffMessages: [{ text: "YUMAさんおはようございます！！本日13時からご内覧何卒よろしくお願い致します😊！！", createdAt: "2026-10-08T00:10:00Z" }], nowMs: now, env: {} }));
t("今日 内覧挨拶の AIX を押した → 出さない", !viewingDayGreetingDue({ appointmentDay: "today", staffMessages: [], aixTypesToday: ["greeting_viewing"], nowMs: now, env: {} }));
t("明日の内覧・済んだ/キャンセル（台帳が null）→ 出さない", !viewingDayGreetingDue({ appointmentDay: "tomorrow", staffMessages: [], nowMs: now, env: {} }) && !viewingDayGreetingDue({ appointmentDay: null, staffMessages: [], nowMs: now, env: {} }));
t("昨日の『本日よろしく』は数えない", viewingDayGreetingDue({ appointmentDay: "today", staffMessages: [{ text: "本日何卒よろしくお願い致します", createdAt: "2026-10-07T01:00:00Z" }], nowMs: now, env: {} }));
t("VIEWING_DAY_GREETING=off", !viewingDayGreetingDue({ appointmentDay: "today", staffMessages: [], nowMs: now, env: { VIEWING_DAY_GREETING: "off" } }));

// ③ 同じ日の2通目は約束を挟まず AIX
const staffToday = [{ text: "お送り頂きました物件の募集状況確認させて頂きます😊！！確認出来次第、最大限割引させていただいた初期費用の御見積書を作成しお送りさせて頂きます！！", createdAt: "2026-10-08T00:10:00Z" }];
const kinds = promiseKindsToday(staffToday, now);
t("今日の約束の種類（確認＋見積）", kinds.includes("check") && kinds.includes("estimate"), kinds.join(","));
t("昨日の約束は数えない", promiseKindsToday([{ ...staffToday[0], createdAt: "2026-10-07T00:10:00Z" }], now).length === 0);
const base = { decisionSource: "llm", pickupReady: false, postApply: false };
t("1通目の持ち込み → 約束（brought_both）", resolveTwoStage({ ...base, finalAix: "property_check_result", brought: { ask: "none", count: 1 }, promisedTodayKinds: [] })?.source === "rule:two_stage_promise(brought_both)");
t("同じ日の2通目の持ち込み → AIX を直接（null）", resolveTwoStage({ ...base, finalAix: "property_check_result", brought: { ask: "none", count: 1 }, promisedTodayKinds: kinds }) === null);
t("同じ日の2通目の見積の依頼 → AIX を直接", resolveTwoStage({ ...base, finalAix: "estimate_sheet", promisedTodayKinds: ["estimate"] }) === null);
t("今日の約束がピックアップだけ → 見積の依頼は約束のまま", resolveTwoStage({ ...base, finalAix: "estimate_sheet", promisedTodayKinds: ["pickup"] })?.kind === "estimate");
t("ピックアップは同じ日でも約束のまま（条件の番 96%）", resolveTwoStage({ ...base, finalAix: "property_send", promisedTodayKinds: ["pickup"] })?.kind === "pickup");
t("聞かれた事への答え（check_question）は対象外", resolveTwoStage({ ...base, finalAix: "property_check_result", customerText: "ここって宅配ボックスありますか？", promisedTodayKinds: ["check"] })?.source === "rule:two_stage_promise(check_question)");
{
  process.env.TWO_STAGE_SAME_DAY_DIRECT = "off";
  t("TWO_STAGE_SAME_DAY_DIRECT=off で旧（約束）", resolveTwoStage({ ...base, finalAix: "estimate_sheet", promisedTodayKinds: ["estimate"] })?.kind === "estimate");
  delete process.env.TWO_STAGE_SAME_DAY_DIRECT;
}
console.log(`\n合計: ${pass}/${pass + fail}`); if (fail) process.exit(1);
