// app/lib/__tests__/aix-record.test.ts — 1件の AIX の記録の型と、staff_aix が空の理由（実行: npx tsx app/lib/__tests__/aix-record.test.ts）
//   実物の形: aix_usage_logs の 11/12〜13 の行（ピッカー・物件の状態・勧め）と、見張りの番 11447（11/05・次のお客様の発言の後に物件確認した）
import { toAixRecords, staffAixState, brainMatchOf, pickerSub, pressedByOf, watchAixRecordV2On } from "../aix-record";
let pass = 0, fail = 0;
const t = (n: string, ok: boolean, d = "") => { if (ok) pass++; else { fail++; console.log(`NG ${n} ${d}`); } };

t("既定 off", !watchAixRecordV2On({}) && watchAixRecordV2On({ WATCH_AIX_RECORD_V2: "on" }));
// 11/13 の実物の形（物件確認した・空きあり・代わり・勧め none・直した・見積同封）
const rows = [
  { aix_type: "property_check_result", check_pattern: "available", created_at: "2026-11-12T23:10:00Z", picker_choices: { all_available: false, estimate_text: false, viewing_continue: true }, prop_statuses: ["available", "alternative"], suggested_action: "none", was_edited: true, estimate_sent: true, line_message_id: "L1" },
  { aix_type: "acknowledge_check", check_pattern: null, created_at: "2026-11-12T23:12:00Z", picker_choices: { ack_preset: "daihyo_initial_cost" }, prop_statuses: null, suggested_action: "property_check_result", was_edited: true, estimate_sent: null, line_message_id: "L2" },
  { aix_type: "viewing_invite", check_pattern: null, created_at: "2026-11-13T02:00:00Z", picker_choices: { viewing_mode: "通常", include_calendar: false }, suggested_action: "viewing_invite", was_edited: true, line_message_id: "L9" },
];
const w = (id: string) => (id === "L1" ? { writer: "takeuchi", basis: "device" } : id === "L2" ? { writer: "employee", basis: "style" } : null);
const r = toAixRecords(rows, (at) => at < "2026-11-13T00:00:00Z", w);
t("下の種類は check_pattern・無ければピッカーの値", r[0].sub === "available" && r[1].sub === "ack_preset=daihyo_initial_cost" && r[2].sub === "viewing_mode=通常", JSON.stringify(r.map((x) => x.sub)));
t("物件の状態", JSON.stringify(r[0].statuses) === JSON.stringify(["available", "alternative"]) && r[1].statuses === null);
t("何通目（まとまりの中の押した順）", r[0].nth === 1 && r[1].nth === 2 && r[2].nth === 1 && r[2].burst === false);
t("ブレインの勧めと同じか（none は勧め無し）", r[0].brain === "no_suggest" && r[1].brain === "diff" && r[2].brain === "same");
t("直した・見積を同封", r[0].edited === true && r[0].estimate === true && r[1].estimate === null);
t("押した人（竹内さん基準）・結べない時は unknown", r[0].by === "takeuchi" && r[0].by_basis === "device" && r[1].by === "employee" && r[2].by === "unknown" && r[2].by_basis === null);
t("押した人: 書き手が takeuchi／employee 以外は unknown", pressedByOf({ writer: "both" }).by === "unknown" && pressedByOf(null).by === "unknown");
t("brainMatchOf: 空は勧め無し", brainMatchOf("property_send", "") === "no_suggest" && brainMatchOf("property_send", "property_recommendation") === "diff");
t("pickerSub: 真偽だけなら null", pickerSub({ has_purpose: false }) === null && pickerSub(null) === null);
// 番 11447: 09:56:46 にお客様の最後の発言・10:11:38 に次のお客様の発言（窓の終わり）・10:21:38 に物件確認した
const st = staffAixState({ windowPresses: 0, closed: true, customerLastAt: "2026-11-05T09:56:46Z", endAt: "2026-11-05T10:11:38Z", allPresses: [{ aix_type: "property_check_result", created_at: "2026-11-05T10:21:38Z" }] });
t("11447: 次のお客様の発言の後に押した＝次の番の一手", st === "next_turn", st);
t("窓の中に押した＝pressed", staffAixState({ windowPresses: 1, closed: true, customerLastAt: "2026-11-05T09:56:46Z", endAt: "2026-11-05T10:11:38Z", allPresses: [] }) === "pressed");
t("窓が閉じて AIX 無し＝none", staffAixState({ windowPresses: 0, closed: true, customerLastAt: "2026-11-05T09:56:46Z", endAt: "2026-11-05T10:11:38Z", allPresses: [] }) === "none");
t("窓が開いている＝unknown", staffAixState({ windowPresses: 0, closed: false, customerLastAt: "2026-11-05T09:56:46Z", endAt: "2026-11-06T09:56:46Z", allPresses: [] }) === "unknown");
t("24時間より後の AIX は次の番の一手に数えない＝none", staffAixState({ windowPresses: 0, closed: true, customerLastAt: "2026-11-05T09:56:46Z", endAt: "2026-11-05T10:11:38Z", allPresses: [{ aix_type: "property_send", created_at: "2026-11-06T10:00:00Z" }] }) === "none");
console.log(`aix-record: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
