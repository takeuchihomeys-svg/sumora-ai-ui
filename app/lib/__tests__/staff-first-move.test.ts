// app/lib/__tests__/staff-first-move.test.ts — こちらの「最初の一手」（番 10415 の型: 約束の返信の後に AIX）
//   実行: npx tsx app/lib/__tests__/staff-first-move.test.ts
import { staffFirstMove, aixLogsFromWatch, staffMoveExclusion, ackSceneOf } from "../staff-first-move";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`); } };
const T = Date.parse("2026-11-03T10:37:31Z");
const aix = aixLogsFromWatch([{ at: "2026-11-03T11:05:00Z", aix_type: "property_check_result", check_pattern: "unavailable" }, { at: "2026-11-03T11:06:00Z", aix_type: "property_send", check_pattern: null }]);
const msgs = [{ at: Date.parse("2026-11-03T10:40:00Z"), isAix: false, writer: "takeuchi" }, { at: Date.parse("2026-11-03T11:05:10Z"), isAix: true, writer: "takeuchi" }];
const m = staffFirstMove(T, msgs, aix);
t("10415 の型: 最初の送信が約束の返信なら、一手は返信（後の AIX は数えない）", m?.kind === "reply" && m.aix === null && m.writer === "takeuchi");
const m2 = staffFirstMove(T, msgs.slice(1), aix);
t("最初の送信が AIX なら、その近くに押した AIX の種類とピッカー", m2?.kind === "aix" && m2.aix === "property_check_result" && m2.picker === "unavailable");
t("AIX の記録が近くに無ければ aix_unknown", staffFirstMove(T, [{ at: T + 60_000, isAix: true, writer: null }], [])?.aix === "aix_unknown");
t("番の前の送信・24時間より後は数えない・無ければ null", staffFirstMove(T, [{ at: T - 1000, isAix: false, writer: "x" }, { at: T + 86_400_001, isAix: false, writer: "x" }], []) === null);
// 2026-11-07 見張りの数え方: 後で送った AIX・お礼の番の約束の果たし（実物: 番 12062 お礼→26分で物件確認した／番 11932 →83分で物件確認した）
{
  const T0 = Date.parse("2026-11-06T10:59:37.82Z");
  const fmAck = staffFirstMove(T0, [{ at: Date.parse("2026-11-06T11:26:01.694Z"), isAix: true, writer: "takeuchi" }], aixLogsFromWatch([{ at: "2026-11-06T11:26:05.805Z", aix_type: "property_check_result", check_pattern: "available" }]));
  t("12062: お礼の番で26分後に物件確認した＝スタッフの番", staffMoveExclusion(T0, fmAck, { ackOnly: true }) === "ack_fulfil_aix");
  t("同じ番でもお礼でなければ外さない（90分前）", staffMoveExclusion(T0, fmAck, { ackOnly: false }) === null);
  t("止める WATCH_COUNT_LATE_AIX=off", staffMoveExclusion(T0, fmAck, { ackOnly: true, env: { WATCH_COUNT_LATE_AIX: "off" } }) === null);
  const T1 = Date.parse("2026-11-06T08:30:31.649Z");
  const fmLate = staffFirstMove(T1, [{ at: Date.parse("2026-11-06T09:53:52.551Z"), isAix: true, writer: "takeuchi" }], aixLogsFromWatch([{ at: "2026-11-06T09:53:56.754Z", aix_type: "property_check_result", check_pattern: "mgmt_equipment" }]));
  t("11932: 83分後の AIX は線（90分）の手前＝外さない", staffMoveExclusion(T1, fmLate, {}) === null);
  t("線を80分にすれば後で送った AIX", staffMoveExclusion(T1, fmLate, { lateMin: 80 }) === "late_aix");
  t("返信の一手は外さない", staffMoveExclusion(T1, { kind: "reply", aix: null, picker: null, writer: "takeuchi", at: T1 + 200 * 60_000 }, {}) === null);
  t("お礼の番でも30分を過ぎた見積書は外さない（90分前）", staffMoveExclusion(T1, { kind: "aix", aix: "estimate_sheet", picker: null, writer: "takeuchi", at: T1 + 45 * 60_000 }, { ackOnly: true }) === null);
  t("お礼の番の内覧の AIX は約束の果たしに数えない", staffMoveExclusion(T1, { kind: "aix", aix: "viewing_invite", picker: null, writer: "takeuchi", at: T1 + 5 * 60_000 }, { ackOnly: true }) === null);
  t("場面の鍵でお礼の番", ackSceneOf("返信:短い了承・お礼") && !ackSceneOf("返信:質問") && ackSceneOf(null, "感謝返し"));
}
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
