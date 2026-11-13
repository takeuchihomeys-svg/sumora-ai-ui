// 本番の物差しの「今の通／後の通」の2枠（scripts/lib/prod-yardstick.ts）のテスト（LLM も DB も使わない）
// 2026-11-12 作業員1（弱い所 268）。見張りの番 11447・12189 は実物の値（作業員16 の指摘の番）
// 実行: npx tsx scripts/lib/__tests__/prod-yardstick-two-frames.test.ts
import { brainFrames, staffFrames, judgeTwoFrames, countTwoFrames, twoStageKindOf, yardstickTwoFramesOn, fillStaffAix, yardstickAixLogFillOn, mergeFillFrames, applyStaffAixState } from "../prod-yardstick";
import { aixFamily } from "../prod-yardstick-db";

let fail = 0, pass = 0;
function ok(name: string, cond: boolean, detail = "") { if (cond) pass++; else { fail++; console.error(`✗ ${name}${detail ? `\n   ${detail}` : ""}`); } }
const t0 = Date.parse("2026-11-07T08:02:39.3Z");
const min = (n: number) => t0 + n * 60_000;

ok("既定 on（11/13）・off で止まる", yardstickTwoFramesOn({}) === true && yardstickTwoFramesOn({ YARDSTICK_TWO_FRAMES: "off" }) === false);
// 11/13: 組の窓は既定 on。下の 11/07 の2枠のテストは組の窓 off の数え（comboMs を渡さない呼び方は process.env を読む）
process.env.YARDSTICK_COMBO_WINDOW = "off";
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
// 2026-11-13 作業員7b: 組の窓（YARDSTICK_COMBO_WINDOW・既定 off）。実物 12240 の形: 挨拶の返信 04:25:12 → AIX【条件ヒアリング】04:25:22
{
  const t0 = Date.parse("2026-11-07T17:12:18Z");
  const mv = [{ at: Date.parse("2026-11-08T04:25:12Z"), family: "返信" }, { at: Date.parse("2026-11-08T04:25:22Z"), family: "条件ヒアリング" }];
  const off = staffFrames(t0, mv, { comboMs: null }), on = staffFrames(t0, mv, { comboMs: 120_000 });
  ok("組の窓 off: 今=返信・後=AIX", off.now === "返信" && off.later === "条件ヒアリング" && !off.combo);
  ok("組の窓 on: 今=AIX（返信→AIX の組）", on.now === "条件ヒアリング" && on.later === null && on.combo === true);
  ok("組の窓 on: ブレインが AIX【条件ヒアリング】なら今の通は当たり", judgeTwoFrames({ now: "条件ヒアリング", later: null }, on).now === "hit" && judgeTwoFrames({ now: "条件ヒアリング", later: null }, off).now === "miss");
  const late = staffFrames(t0, [mv[0], { at: mv[0].at + 5 * 60_000, family: "条件ヒアリング" }], { comboMs: 120_000 });
  ok("2分を越えた AIX は組にしない（後の通）", late.now === "返信" && late.later === "条件ヒアリング");
  delete process.env.YARDSTICK_COMBO_WINDOW;
  ok("既定 on（11/13）", staffFrames(t0, mv).now === "条件ヒアリング");
  process.env.YARDSTICK_COMBO_WINDOW = "off";
  ok("off で止まる", staffFrames(t0, mv).now === "返信");
}
// 2026-11-13 作業員8b: 見張りの staff_aix が空の番を aix_usage_logs で補う（実物 11447・11/05 09:56:29Z・竹内さん 14分 返信 → 25分 property_check_result＋condition_hearing）
{
  const T = Date.parse("2026-11-05T09:56:29.927Z");
  const logs = [{ at: Date.parse("2026-11-05T10:21:38.708Z"), aixType: "property_check_result", checkPattern: null }, { at: Date.parse("2026-11-05T10:21:44.832Z"), aixType: "condition_hearing", checkPattern: null }, { at: T - 3_600_000, aixType: "estimate_sheet", checkPattern: null }];
  ok("補いは既定 on・=off で止める", yardstickAixLogFillOn({}) && !yardstickAixLogFillOn({ YARDSTICK_AIX_LOG_FILL: "off" }));
  const filled = fillStaffAix([], logs, T);
  ok("空の見張りは番の後の記録で補う（番の前は入れない）", filled.map((a) => a.aixType).join(",") === "property_check_result,condition_hearing", JSON.stringify(filled));
  ok("見張りに有る時は見張りのまま", fillStaffAix([{ at: T + 60_000, aixType: "estimate_sheet", checkPattern: null }], logs, T).map((a) => a.aixType).join() === "estimate_sheet");
  const fam = (at: number) => aixFamily(filled.filter((a) => Math.abs(a.at - at) <= 10 * 60_000).sort((a, b) => Math.abs(a.at - at) - Math.abs(b.at - at))[0]?.aixType ?? "aix_unknown");
  const moves = [{ at: T + 14 * 60_000, family: "返信" }, { at: Date.parse("2026-11-05T10:21:39Z"), family: fam(Date.parse("2026-11-05T10:21:39Z")) }];
  const s2 = staffFrames(T, moves, { comboMs: 120_000 });
  ok("補った後: 後の通は確認の系統（aix_unknown でない）・組の窓（2分）には入らない", s2.now === "返信" && s2.later !== "aix_unknown" && !!s2.later && !s2.combo, JSON.stringify(s2));
  ok("ブレインの見積は今の通の外れのまま（判断の外れ＝弱い所 836）", judgeTwoFrames(brainFrames(aixFamily("estimate_sheet"), "rule:answerable_direct(brought_estimate)"), s2).now === "miss");
}
// 2026-11-13 作業員8b: 補いは後の通だけ（今の通・組の窓に入らない）・next_turn は今の通を返信に
{
  const T = Date.parse("2026-11-05T09:56:29.927Z");
  // 見張りに AIX が無い番で、補った AIX が最初の返信から1分後（組の窓の中）でも、今の通は返信のまま・補いは後の通へ
  const movesWatch = [{ at: T + 14 * 60_000, family: "返信" }, { at: T + 15 * 60_000, family: "aix_unknown" }];
  const movesFill = [{ at: T + 14 * 60_000, family: "返信" }, { at: T + 15 * 60_000, family: "確認" }];
  const sNow = staffFrames(T, movesWatch, { comboMs: 120_000 }), sFill = staffFrames(T, movesFill, { comboMs: 120_000 });
  ok("前提: 見張りだけでも aix_unknown は組の窓で今の通に入る形", sNow.combo === true && sNow.now === "aix_unknown");
  const sNow2 = staffFrames(T, movesWatch, { comboMs: null });
  const m = mergeFillFrames(sNow2, sFill);
  ok("補いは今の通に入らない（見張りの今のまま）", m.now === "返信", JSON.stringify(m));
  ok("補いは後の通に入る（組でも後へ）", m.later === "確認", JSON.stringify(m));
  ok("見張りで後の通が分かっていれば見張りのまま", mergeFillFrames({ now: "返信", later: "見積" }, { now: "返信", later: "確認" }).later === "見積");
  ok("見張りの組（今の通が AIX）は補いで変えない", JSON.stringify(mergeFillFrames({ now: "見積", later: null, combo: true }, { now: "返信", later: "確認" })) === JSON.stringify({ now: "見積", later: null, combo: true }));
  ok("next_turn は今の通を返信に・後はそのまま", JSON.stringify(applyStaffAixState({ now: "aix_unknown", later: "確認" }, "next_turn")) === JSON.stringify({ now: "返信", later: "確認", combo: false }));
  ok("他の理由は変えない", applyStaffAixState({ now: "見積", later: null }, "pressed").now === "見積" && applyStaffAixState({ now: "見積", later: null }, null).now === "見積");
  ok("配線: 今の通（最初の一手）は見張りの AIX だけ", (() => { const src = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "prod-yardstick-db.ts"), "utf8") as string; return !/staffFirstMove([^)]*staffAixOf(w))/.test(src) && src.includes("mergeFillFrames(sNow, staffFrames(tAt, movesOf(logs)))"); })());
}
// 2026-11-13 作業員7b: 2段を外して AIX に決め切った番（作業員4 の実物 12555 の decision_source）
{
  const ds = "rule:two_stage_promise(brought_estimate)+two_choice_narrow(estimate)";
  delete process.env.YARDSTICK_TWO_STAGE_UNDONE;
  const f = brainFrames("見積", ds);
  ok("12555: 今=見積の AIX（2段ではない）", f.now === "見積" && f.later === null);
  ok("12555: 竹内さんの AIX【見積書送る】の直接と今の通が当たり", judgeTwoFrames(f, { now: "見積", later: null }).now === "hit");
  process.env.YARDSTICK_TWO_STAGE_UNDONE = "off";
  ok("off で旧の数え（今=返信）", brainFrames("見積", ds).now === "返信");
  delete process.env.YARDSTICK_TWO_STAGE_UNDONE;
  ok("2段のまま（印なし）は今=返信", brainFrames("物件", "rule:two_stage_promise(pickup_unless_ack)").now === "返信");
  ok("search_split は2段のまま（12189）", brainFrames("物件", "rule:two_stage_promise(pickup_unless_ack)+search_split").now === "返信");
  ok("ブレインの系統が返信なら印があっても今=返信", brainFrames("返信", ds).now === "返信");
}
console.log(`prod-yardstick-two-frames: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
