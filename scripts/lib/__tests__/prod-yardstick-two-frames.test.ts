// 本番の物差しの「今の通／後の通」の2枠（scripts/lib/prod-yardstick.ts）のテスト（LLM も DB も使わない）
// 2026-11-12 作業員1（弱い所 268）。見張りの番 11447・12189 は実物の値（作業員16 の指摘の番）
// 実行: npx tsx scripts/lib/__tests__/prod-yardstick-two-frames.test.ts
import { brainFrames, staffFrames, judgeTwoFrames, countTwoFrames, twoStageKindOf, yardstickTwoFramesOn } from "../prod-yardstick";

let fail = 0, pass = 0;
function ok(name: string, cond: boolean, detail = "") { if (cond) pass++; else { fail++; console.error(`✗ ${name}${detail ? `\n   ${detail}` : ""}`); } }
const t0 = Date.parse("2026-11-07T08:02:39.3Z");
const min = (n: number) => t0 + n * 60_000;

ok("既定 off", yardstickTwoFramesOn({}) === false && yardstickTwoFramesOn({ YARDSTICK_TWO_FRAMES: "on" }) === true);
ok("2段の種類", twoStageKindOf("rule:two_stage_promise(pickup_unless_ack)+search_split") === "pickup_unless_ack" && twoStageKindOf("rule:answerable_direct(brought_estimate)") === null);

{ // 12189: ブレインは2段（約束の返信＋後で物件）・見張りの brain_action は property_send・竹内さんは約束の返信（約2時間後）
  const b = brainFrames("物件", "rule:two_stage_promise(pickup_unless_ack)+search_split");
  ok("12189: ブレインの今=返信・後=物件", b.now === "返信" && b.later === "物件", JSON.stringify(b));
  const s = staffFrames(t0, [{ at: min(117), family: "返信" }]);
  const j = judgeTwoFrames(b, s);
  ok("12189: 今の通は当たり（前の数えでは 物件 vs 返信 の外れ）", j.now === "hit", JSON.stringify(j));
  ok("12189: 後の通は約束したがまだ送っていない（brain_only）", j.later === "brain_only", JSON.stringify(j));
}
{ // 11447: ブレインは AIX 直接（見積）・竹内さんは先に初回の挨拶の返信→11分後に AIX
  const ta = Date.parse("2026-11-05T09:56:29.927Z");
  const b = brainFrames("見積", "rule:answerable_direct(brought_estimate)");
  const s = staffFrames(ta, [{ at: Date.parse("2026-11-05T10:10:05Z"), family: "返信" }, { at: Date.parse("2026-11-05T10:21:28Z"), family: "確認" }]);
  ok("11447: スタッフの今=返信・後=確認", s.now === "返信" && s.later === "確認", JSON.stringify(s));
  const j = judgeTwoFrames(b, s);
  ok("11447: 今の通は外れ（ブレインは AIX 直接・竹内さんは返信が先）・後の通はスタッフだけ", j.now === "miss" && j.later === "staff_only", JSON.stringify(j));
}
{
  ok("両方 AIX 直接で同じ → 今の通の当たり・後はなし", JSON.stringify(judgeTwoFrames(brainFrames("見積", null), staffFrames(t0, [{ at: min(5), family: "見積" }]))) === JSON.stringify({ now: "hit", later: "na" }));
  ok("2段どうしで後の AIX も同じ → 後の通も当たり", judgeTwoFrames(brainFrames("確認", "rule:two_stage_promise(check)"), staffFrames(t0, [{ at: min(3), family: "返信" }, { at: min(200), family: "確認" }])).later === "hit");
  ok("2段どうしで後の AIX が違う → 後の通の外れ", judgeTwoFrames(brainFrames("確認", "rule:two_stage_promise(check)"), staffFrames(t0, [{ at: min(3), family: "返信" }, { at: min(200), family: "見積" }])).later === "miss");
  ok("24時間より後の AIX は後の通に入れない", staffFrames(t0, [{ at: min(3), family: "返信" }, { at: min(25 * 60), family: "物件" }]).later === null);
  ok("スタッフの一手が無い番は返信（待ち）と同じに扱う", judgeTwoFrames(brainFrames("返信", null), staffFrames(t0, [])).now === "hit");
}
{
  const m = countTwoFrames([
    { scene: "a", judge: { now: "hit", later: "brain_only" } }, { scene: "a", judge: { now: "miss", later: "staff_only" } }, { scene: "a", judge: { now: "hit", later: "hit" } },
  ]);
  const a = m.get("a")!;
  ok("数え", a.n === 3 && a.nowHit === 2 && a.laterHit === 1 && a.brainOnly === 1 && a.staffOnly === 1, JSON.stringify(a));
}
console.log(`prod-yardstick-two-frames: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
