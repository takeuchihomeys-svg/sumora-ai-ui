// 試験の組のスイッチの届き（scripts/lib/exam-switch-reach.ts）
// 実行: npx tsx scripts/lib/__tests__/exam-switch-reach.test.ts（全 PASS で exit 0）
import { switchReachOf, onSwitchesOfMeta } from "../exam-switch-reach";

let pass = 0, fail = 0;
const ok = (name: string, c: boolean, d: unknown = "") => { if (c) pass++; else { fail++; console.error(`✗ ${name}`, d); } };
const st = (rs: ReturnType<typeof switchReachOf>, sw: string) => rs.find((x) => x.sw === sw)?.status;

// 昨夜の ess-1122r-pickupwhy の形: 画像の読みの行は0・選んだ理由の印は入る前の版
const night = [
  { id: "q364", marks: { ack_confirm: 434 }, ledger: { property_pickups: 8, sent_facts: 5 } },
  { id: "q212", marks: { ack_confirm: 403 }, ledger: { property_pickups: 5 } },
  { id: "q351", marks: { ack_confirm: 418 }, ledger: { sent_facts: 7 } },
  { id: "q351", marks: { ack_confirm: 418 }, ledger: { sent_facts: 7 } },
];
const old = () => false; // 試験の HEAD に印のコミットが無い
const r1 = switchReachOf(["PICKUP_WHY_TO_BRAIN", "SIP_JUDGE"], night, old);
ok("SIP_JUDGE: 要る材料（画像の読み）が0行＝効いていない", st(r1, "SIP_JUDGE") === "no_material");
ok("PICKUP_WHY_TO_BRAIN: 材料はあるが印が入る前の版＝確かめられない", st(r1, "PICKUP_WHY_TO_BRAIN") === "mark_after_head" && r1[0].withMaterial.join(",") === "q364,q212");
ok("同じ問題の回は1問に寄せる", r1[0].problems === 3);
// 印の入った版
const now = [
  { id: "q364", marks: { pickup_why: 120 }, ledger: { property_pickups: 8 } },
  { id: "q334", marks: { pickup_why: 90, pickup_why_sip: 2 }, ledger: { sent_image_properties: 4 } },
  { id: "q351", marks: {}, ledger: {} },
];
const r2 = switchReachOf(["PICKUP_WHY_TO_BRAIN", "SIP_JUDGE"], now);
ok("印が立った問題＝効いた", st(r2, "PICKUP_WHY_TO_BRAIN") === "reached" && r2[0].hit.join(",") === "q364,q334" && st(r2, "SIP_JUDGE") === "reached" && r2[1].hit.join(",") === "q334");
ok("材料はあるのに印0＝効いていない", st(switchReachOf(["SIP_JUDGE"], [{ id: "q1", marks: {}, ledger: { sent_image_properties: 3 } }]), "SIP_JUDGE") === "not_reached");
ok("⑥の差し替えは指示文に入った印 rule6_open で見る（印が無ければ効いていない）", st(switchReachOf(["BRAIN_RULE6_OPEN_PROMISE"], [{ id: "q1", marks: { rule6_open: 1 } }]), "BRAIN_RULE6_OPEN_PROMISE") === "reached" && st(switchReachOf(["BRAIN_RULE6_OPEN_PROMISE"], [{ id: "q1", marks: {} }]), "BRAIN_RULE6_OPEN_PROMISE") === "not_reached");
{
  const tonight = ["ACK_PICKUP_AIX_PATH", "BRAIN_RULE6_OPEN_PROMISE", "ACK_FORM_COUNT_WITH_AIX", "BRAIN_CLOSED_THANKS_NO_REPLY", "BRAIN_FAR_OTHER_FIRST", "BRAIN_FULFIL_TURN", "BRAIN_LAYOUT_ASK_TEMPORARY", "BRAIN_MESSAGE_PLAN", "OUR_PARTS_PROMISE_WIDE", "INFO_FILL_MAP", "EQUIPMENT_WISH_LOOKUP"];
  ok("11/23 今夜流すスイッチは全部対応表にある（対応表に無い＝確かめられない回を出さない）", tonight.every((sw) => st(switchReachOf([sw], [{ id: "q1" }]), sw) !== "unknown"));
  ok("q197 の6つは印で見る（No.15 の1行が立った問題）", st(switchReachOf(["BRAIN_CLOSED_THANKS_NO_REPLY"], [{ id: "q197", marks: { d1103_n15: 90 } }, { id: "q065", marks: {} }]), "BRAIN_CLOSED_THANKS_NO_REPLY") === "reached" && st(switchReachOf(["BRAIN_MESSAGE_PLAN"], [{ id: "q197", metaKeys: ["message_plan"] }]), "BRAIN_MESSAGE_PLAN") === "reached");
}
ok("対応表に無いスイッチは確かめられない", st(switchReachOf(["FOO_BAR"], now), "FOO_BAR") === "unknown");
ok("CHECK_RESULT_STATE: 空室確認のタスクが写しに0行＝効いていない", st(switchReachOf(["CHECK_RESULT_STATE"], night), "CHECK_RESULT_STATE") === "no_material");
ok("了承の細かいスイッチは印が材料の行まで（部分の注）", !!switchReachOf(["ACK_PICKUP_AIX_PATH"], night)[0].note);
{
  const rows = [{ id: "q1", metaKeys: ["turn_read", "reply_mode"] }, { id: "q2", metaKeys: ["reply_mode"] }];
  const r = switchReachOf(["TURN_READ", "LATENT_FIVE"], rows);
  ok("結果の欄で見る印（TURN_READ は turn_read の欄・LATENT_FIVE は欄が無ければ効いていない）", st(r, "TURN_READ") === "reached" && r[0].hit.join(",") === "q1" && st(r, "LATENT_FIVE") === "not_reached");
  ok("照らし合わせの印は入る前の版なら確かめられない", st(switchReachOf(["CONDUCTOR_EXCHANGE_LEDGER_BRAIN"], rows, () => false), "CONDUCTOR_EXCHANGE_LEDGER_BRAIN") === "mark_after_head"
    && st(switchReachOf(["CONDUCTOR_EXCHANGE_LEDGER_BRAIN"], [{ id: "q1", marks: { exchange: 80 } }]), "CONDUCTOR_EXCHANGE_LEDGER_BRAIN") === "reached");
}
ok("メタの on のスイッチだけ", onSwitchesOfMeta({ envFp: { pairs: { A: "on", B: "off", C: " ON " } } }).join(",") === "A,C" && onSwitchesOfMeta(null).length === 0);

console.log(`exam-switch-reach: PASS ${pass} / FAIL ${fail}`);
if (fail) process.exit(1);
