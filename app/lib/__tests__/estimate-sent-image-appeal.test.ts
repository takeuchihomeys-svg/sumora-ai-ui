// app/lib/__tests__/estimate-sent-image-appeal.test.ts — 見積書の持ち込みのお部屋の刺さり具合（ESTIMATE_SIP_APPEAL・2026-11-18 作業員K）
//   実行: npx tsx app/lib/__tests__/estimate-sent-image-appeal.test.ts
import { estimateSipAppealOn, summaryFromSipFacts, sipRowFor, estimateSipAppeal } from "../estimate-sent-image-appeal";
import { resolveEstimateClosing } from "../estimate-second-message";
let pass = 0, fail = 0;
const t = (n: string, ok: boolean, info?: unknown) => { if (ok) { pass++; console.log(`  OK  ${n}`); } else { fail++; console.log(`  NG  ${n}`, info === undefined ? "" : JSON.stringify(info)); } };
t("既定 off", !estimateSipAppealOn({}) && estimateSipAppealOn({ ESTIMATE_SIP_APPEAL: "on" }));
const facts = { room_no: "502", rent: 78000, admin_fee_yen: 8000, deposit_months: 0, key_money_months: 0, floor_plan: "1K", area_sqm: 25.5, station: "本町", walk_minutes: 5, built_ym: "2019年3月" };
const sum = summaryFromSipFacts("テストレジデンス本町", facts);
t("読みの事実 → 物件の文", /賃料 78,000円/.test(sum) && /管理費 8,000円/.test(sum) && /1K 25.5㎡/.test(sum) && /本町駅 徒歩5分/.test(sum), sum);
const rows = [
  { property_name: "テストレジデンス本町", room_no: "502", created_at: "2026-11-01T00:00:00Z", facts },
  { property_name: "別のマンション", room_no: "502", created_at: "2026-11-02T00:00:00Z", facts },
];
t("号室と建物で当てる", sipRowFor(rows, { name: "テストレジデンス本町", room: "502" })?.property_name === "テストレジデンス本町");
t("号室が違えば当てない", sipRowFor(rows, { name: "テストレジデンス本町", room: "503" }) === null);
t("お客様の行が無ければ null", estimateSipAppeal(rows, [{ name: "テストレジデンス本町", room: "502" }], null).appeal === null);
const over = estimateSipAppeal(rows, [{ name: "テストレジデンス本町", room: "502" }], { rent_max: 60000 } as never);
t("家賃が上限を大きく超える → 刺さらない（weak）", over.appeal === "weak" && over.found === 1, over);
t("読めないお部屋だけ → null", estimateSipAppeal(rows, [{ name: "無い建物", room: "101" }], { rent_max: 90000 } as never).appeal === null);
// 締めの決め
t("先に見る: 刺さらない → ご査収（頼まれた見積でも）", resolveEstimateClosing({ viewed: false, appeal: "weak", customerAsked: true, appealFirst: true }).closing === "receipt");
t("先に見る: 刺さる・今見られる → 内覧", resolveEstimateClosing({ viewed: false, appeal: "strong", customerAsked: true, appealFirst: true }).closing === "viewing");
t("先に見る: 刺さる・退去予定 → 申込", resolveEstimateClosing({ viewed: false, appeal: "strong", notViewable: true, appealFirst: true }).closing === "apply");
t("先に見ない（既定）: 頼まれた見積 → 内覧のまま", resolveEstimateClosing({ viewed: false, appeal: "weak", customerAsked: true }).closing === "viewing");
t("懸念の時は押さない（先に見る時も）", resolveEstimateClosing({ viewed: false, appeal: "strong", customerAsked: true, appealFirst: true, reactionKind: "concern" }).closing === "receipt");
t("内覧の後はご査収のまま", resolveEstimateClosing({ viewed: true, appeal: "strong", appealFirst: true }).closing === "receipt");
console.log(`\n${pass} OK / ${fail} NG`);
if (fail) process.exit(1);
