// scripts/test-feeling-conductor-table.ts — 気持ち・状況から統括の5つの判断を決める表（FEELING_CONDUCTOR_TABLE 既定 off・作業員I 11/15・LLM/DB なし・費用0）
// 実行: npx tsx scripts/test-feeling-conductor-table.ts
import assert from "node:assert/strict";
import { decideFromFeeling, feelingTableMode, applyFeelingFocus, feelingPriorityCues, feelingNextStrength, feelingNextSend, feelingBriefSection, feelingDigest, FEELING_ROWS } from "../app/lib/feeling-conductor-table";
import { priorityCuesFromMeta } from "../app/lib/priority-table";
import { concreteNextMove } from "../app/lib/next-move-concrete";
import { allocationFromMeta } from "../app/lib/conductor-allocation";
import { buildConductorBrief, BRIEF_NONE } from "../app/lib/conductor-brief";
import { briefLineForRole } from "../app/lib/compose-brief-roles";
import { compareTurn } from "./feeling-conductor-count";
import { FOCUS_KINDS, type Focus as FocusReal } from "../app/lib/conductor-focus";
import { NEXT_DEST, NEXT_STRENGTH, type NextDest as NDReal, type NextStrength as NSReal } from "../app/lib/next-move-types";
import type { Focus as FocusLocal, NextDest as NDLocal, NextStrength as NSLocal } from "../app/lib/feeling-conductor-table";

let n = 0;
const t = (name: string, f: () => void) => { f(); n++; console.log("ok", name); };
const withEnv = (v: string | null, f: () => void) => { const k = "FEELING_CONDUCTOR_TABLE"; const old = process.env[k]; if (v == null) delete process.env[k]; else process.env[k] = v; try { f(); } finally { if (old == null) delete process.env[k]; else process.env[k] = old; } };
const mind = (state: string, extra: Record<string, unknown> = {}) => ({ customer_mindset: { state, anxiety: null, hesitation: null, decideGap: null, ...extra } });

// 型の名前が元の部品と同じ（import しない代わりに突き合わせる）
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const _s1: Same<FocusLocal, FocusReal> = true; const _s2: Same<NDLocal, NDReal> = true; const _s3: Same<NSLocal, NSReal> = true; void _s1; void _s2; void _s3;
t("型の名前が conductor-focus・next-move-types と同じ", () => { assert.equal(FOCUS_KINDS.length, 7); assert.equal(NEXT_DEST.length, 10); assert.equal(NEXT_STRENGTH.length, 5); });
t("既定 off・shadow は判断に使わない", () => {
  assert.equal(feelingTableMode({}), "off");
  assert.equal(feelingTableMode({ FEELING_CONDUCTOR_TABLE: "shadow" }), "shadow");
  const meta = { ...mind("先に取られる不安"), feeling_conductor: decideFromFeeling(mind("先に取られる不安")) };
  withEnv(null, () => { assert.deepEqual(feelingPriorityCues(meta), {}); assert.equal(feelingNextStrength(meta), null); assert.equal(feelingNextSend(meta), null); assert.equal(feelingBriefSection(meta), null); });
  withEnv("shadow", () => { assert.deepEqual(feelingPriorityCues(meta), {}); assert.equal(feelingNextStrength(meta), null); });
});
t("表の行はどれも出所を持つ（竹内さんの決定のある行だけ）", () => {
  for (const r of FEELING_ROWS) assert.ok(r.source && r.source.length > 4, r.id);
});
t("先に取られる不安: 重点=次の一手・押す・抑えの提案・次＝申込で抑える", () => {
  const d = decideFromFeeling(mind("先に取られる不安"));
  assert.deepEqual(d.rows, ["taken_worry"]);
  assert.equal(d.focus, "propose"); assert.equal(d.push, "push"); assert.match(d.combo ?? "", /抑え/); assert.equal(d.next?.dest, "apply");
  assert.deepEqual(d.writer.head, ["focus"]); assert.deepEqual(d.writer.close, ["push"]);
});
t("審査の不安は強さ3（latent_five）の時だけ・後ろ向きは当てない", () => {
  assert.deepEqual(decideFromFeeling(mind("審査の不安", { anxiety: { target: "審査", direction: "前向き" } })).rows, []);
  const d = decideFromFeeling({ ...mind("審査の不安", { anxiety: { target: "審査", direction: "前向き" } }), latent_five: { feeling: { kind: "不安", strength: "strong" } } });
  assert.deepEqual(d.rows, ["screening_worry_strong"]); assert.equal(d.focus, "ease"); assert.equal(d.push, "push");
  assert.deepEqual(decideFromFeeling({ ...mind("審査の不安", { anxiety: { target: "審査", direction: "後ろ向き" } }), latent_five: { feeling: { strength: "strong" } } }).rows, []);
});
t("迷い（物件どうし）: 添える。入居まで30日以内なら1段上げて押す", () => {
  const m = mind("迷い", { hesitation: "複数物件で迷う" });
  assert.equal(decideFromFeeling(m).push, "add");
  const d = decideFromFeeling(m, { daysToMoveIn: 12 });
  assert.equal(d.push, "push"); assert.match(d.pushFrom ?? "", /time_close/);
  assert.equal(decideFromFeeling(m, { daysToMoveIn: 60 }).push, "add");
  // 迷いでも他社と比べている等は当てない（決定は物件どうしだけ）
  assert.deepEqual(decideFromFeeling(mind("迷い", { hesitation: "他社・他の物件と比べる" })).rows, []);
});
t("安くしたい: 見積の数で段階（0→見積書・1→代表確認で下げた見積書・2→代表確認か初期費用の説明）", () => {
  assert.equal(decideFromFeeling(mind("安くしたい"), { estimatesSent: 0 }).next?.what, "最大限割引の御見積書");
  assert.match(decideFromFeeling(mind("安くしたい"), { estimatesSent: 1 }).next?.what ?? "", /代表確認でさらに下げた/);
  assert.equal(decideFromFeeling(mind("安くしたい"), { estimatesSent: 2 }).next?.aix, "cost_explain");
});
t("安さを不審に思う: AIX【初期費用を説明】", () => {
  const d = decideFromFeeling({ turn_contract: { asks: [{ quote: "なんでこんなに安いんですか", kind: "question" }] } });
  assert.deepEqual(d.rows, ["cheap_doubt"]); assert.equal(d.next?.aix, "cost_explain");
});
t("見積を頼んだ: 見積書の後、未内覧なら内覧へ", () => {
  const m = { turn_contract: { asks: [{ quote: "初期費用いくらですか", kind: "question", about: "property_cost" }] } };
  assert.equal(decideFromFeeling(m, { estimatesSent: 0 }).next?.aix, "estimate_sheet");
  assert.equal(decideFromFeeling(m, { estimatesSent: 1, viewing: "none" }).next?.aix, "viewing_invite");
  assert.equal(decideFromFeeling(m, { estimatesSent: 1, viewing: "done" }).next, null);
});
t("内覧したい: 段階どおり（候補日→待ち合わせ）", () => {
  assert.equal(decideFromFeeling(mind("内覧したい"), { viewing: "none" }).next?.aix, "viewing_invite");
  assert.equal(decideFromFeeling(mind("内覧したい"), { viewing: "scheduled" }).next?.aix, "meeting_place");
  assert.equal(decideFromFeeling(mind("内覧したい"), { viewing: "place_sent" }).next, null);
});
t("開いている約束＋手元の結果: 重点＝約束を果たす", () => {
  const d = decideFromFeeling({ action_ledger: { facts: { confirmationPromisedUnfulfilled: true } }, now_vs_later: { ready_now: ["確認の結果"] } });
  assert.deepEqual(d.rows, ["promise_with_result"]); assert.equal(d.focus, "promise_keep");
});
t("「？」の行（興味が薄い・不満・家族に相談）は判断を決めず open に残す", () => {
  const d = decideFromFeeling(mind("興味が薄い"));
  assert.deepEqual(d.rows, []); assert.deepEqual(d.open, ["low_interest"]); assert.equal(d.focus, null);
  assert.deepEqual(decideFromFeeling(mind("迷い", { hesitation: "家族・同居人に相談" })).open, ["decider_elsewhere"]);
  assert.equal(feelingDigest(d), "-|f:-|p:-|n:-|?:low_interest");
});
t("on: 重点を表の重点に（元は focus_brain）", () => {
  const meta: Record<string, unknown> = { ...mind("先に取られる不安"), conductor_focus: { focus: "answer", why: "x" } };
  meta.feeling_conductor = decideFromFeeling(meta);
  withEnv(null, () => assert.equal(applyFeelingFocus(meta), false));
  withEnv("on", () => assert.equal(applyFeelingFocus(meta), true));
  assert.equal((meta.conductor_focus as { focus: string }).focus, "propose");
  assert.equal((meta.conductor_focus as { focus_brain: string }).focus_brain, "answer");
});
t("on: 優先度の表の手がかり（先に取られる不安）", () => {
  const meta: Record<string, unknown> = { ...mind("先に取られる不安") };
  meta.feeling_conductor = decideFromFeeling(meta);
  withEnv(null, () => assert.equal(priorityCuesFromMeta(meta).takenWorry, false));
  withEnv("on", () => assert.equal(priorityCuesFromMeta(meta).takenWorry, true));
});
t("on: 具体の一手は材料が無い番だけ表の次に送る物", () => {
  const meta: Record<string, unknown> = { ...mind("内覧したい") };
  meta.feeling_conductor = decideFromFeeling(meta, { viewing: "none" });
  withEnv(null, () => assert.equal(concreteNextMove({ meta }).from, "type_table"));
  withEnv("on", () => { const c = concreteNextMove({ meta }); assert.equal(c.from, "feeling_table"); assert.equal(c.steps[0].aix, "viewing_invite"); });
  // 開いている約束が先（材料が勝つ）
  const m2: Record<string, unknown> = { ...meta, action_ledger: { facts: { estimatePromisedUnfulfilled: true } } };
  withEnv("on", () => assert.equal(concreteNextMove({ meta: m2 }).from, "open_promise"));
});
t("on: 配分に次に送る物の部品を足す（深さ・上限は変えない）", () => {
  const meta: Record<string, unknown> = { ...mind("安くしたい"), check_order_type: "T2_question_fact" };
  meta.feeling_conductor = decideFromFeeling(meta, { estimatesSent: 0 });
  const off = allocationFromMeta(meta); assert.ok(off && !off.feeling_add);
  withEnv("on", () => { const a = allocationFromMeta(meta); assert.ok(a); if (!off!.parts.includes("estimate")) { assert.deepEqual(a!.feeling_add, ["estimate"]); assert.ok(a!.parts.includes("estimate")); } assert.equal(a!.max_usd, off!.max_usd); });
});
t("on: 指示書の次の一手の強さと書き手への1行", () => {
  const meta: Record<string, unknown> = { ...mind("先に取られる不安"), check_order_type: "T2_question_fact" };
  meta.feeling_conductor = decideFromFeeling(meta);
  withEnv(null, () => { const b = buildConductorBrief(meta); assert.equal(b.feeling, undefined); });
  withEnv("on", () => {
    const b = buildConductorBrief(meta);
    assert.ok(b.feeling && b.feeling.push === "押す");
    if (b.next !== BRIEF_NONE) { assert.equal(b.next.strength, "strong"); assert.match(b.next.strength_from ?? "", /feeling:taken_worry/); }
    const line = briefLineForRole({ ...meta, conductor_brief: b }, "close") ?? "";
    assert.match(line, /気持ち・状況の表: 重点 propose・一手の強さ 押す・組 抑え（申込の流れ）を提案・次に送る物 申込で抑える流れ/);
  });
});
t("数え: 竹内さんの一手と比べる（AIX の種類・申込で抑える・強さ）", () => {
  const d = decideFromFeeling(mind("先に取られる不安"));
  const c = compareTurn(d, { route: "reply", aixTypes: [], text: "ありがとうございます！！1部屋のみの募集となりますので、お申込みでお部屋抑えさせて頂きます！！" });
  assert.equal(c.next, true); assert.equal(c.push, true);
  const d2 = decideFromFeeling(mind("安くしたい"), { estimatesSent: 0 });
  assert.equal(compareTurn(d2, { route: "aix", aixTypes: ["estimate_sheet"], text: "" }).next, true);
  assert.equal(compareTurn(d2, { route: "reply", aixTypes: [], text: "確認させて頂きます！！" }).next, false);
});
console.log(`全部 ${n} 件 ok`);

// ── 2026-11-15 作業員I: 次に送る物 → AIX ツール（物件出し）への指示 ──
import { aixToolOrders, aixToolDigest, HOOK_POINT_TO_TOOL } from "../app/lib/feeling-aix-tool";
import { HOOK_POINTS } from "../app/lib/our-send-uptake";
import { AIX_BUTTON_LABELS } from "../app/lib/aix-taxonomy";
import { starSituationOf } from "../app/lib/recommend-star-rank";
import { HOOK_FEATURE_KEYS } from "../app/lib/hook-lean-core";
let n2 = 0;
const t2 = (name: string, f: () => void) => { f(); n2++; console.log("ok", name); };
t2("名前が揃っている（HOOK_POINTS・AIX の種類・🌟の場面の鍵・判定の学びの鍵）", () => {
  const sit = starSituationOf({}) as unknown as Record<string, unknown>;
  for (const [p, v] of Object.entries(HOOK_POINT_TO_TOOL)) {
    assert.ok((HOOK_POINTS as readonly string[]).includes(p), p);
    if (v?.star && v.star !== "equip") assert.ok(v.star in sit, v.star);
    if (v?.hook) assert.ok((HOOK_FEATURE_KEYS as readonly string[]).includes(v.hook), v.hook);
  }
  for (const a of ["property_recommendation", "estimate_sheet", "cost_explain", "viewing_invite", "meeting_place"]) assert.ok(AIX_BUTTON_LABELS[a], a);
});
t2("迷い（物件どうし）→ AIX【物件オススメ】で1件を推す（決定）", () => {
  const meta: Record<string, unknown> = { ...mind("迷い", { hesitation: "複数物件で迷う" }) };
  meta.feeling_conductor = decideFromFeeling(meta);
  const o = aixToolOrders(meta);
  assert.equal(o[0].kind, "recommend_one"); assert.equal(o[0].aix, "property_recommendation"); assert.equal(o[0].decided, true);
});
t2("安くしたい → AIX【見積書送る】・条件の言い直し → 条件の更新の案（決定）", () => {
  const meta: Record<string, unknown> = { ...mind("安くしたい"), condition_change_type: "area_change" };
  meta.feeling_conductor = decideFromFeeling(meta, { estimatesSent: 0 });
  const o = aixToolOrders(meta);
  assert.deepEqual(o.map((x) => x.kind), ["estimate", "condition_update"]);
  assert.ok(o.every((x) => x.decided));
  assert.equal(aixToolDigest(o), "estimate:estimate_sheet|condition_update:area_change");
});
t2("刺さった点 → 次のピックアップの重みは決まっていない案（decided=false・指示書の1行に出さない）", () => {
  const meta: Record<string, unknown> = { our_send_uptake: [{ part: "x", kind: "property", uptake: "reacted", hook: "hooked", degree: "strong", point: "駅・場所", cue: "駅近いのいい" }, { part: "y", kind: "property", uptake: "reacted", hook: "hooked", degree: "mid", point: "家賃", cue: null }] };
  meta.feeling_conductor = decideFromFeeling(meta);
  const o = aixToolOrders(meta);
  assert.equal(o.length, 1); assert.equal(o[0].kind, "pickup_weights"); assert.equal(o[0].decided, false);
  assert.deepEqual(o[0].star, ["stationNear"]); assert.deepEqual(o[0].hook, ["walk_near", "rent_upper"]);
  assert.equal(aixToolDigest(o), "?pickup_weights:stationNear");
});
t2("on: 指示書の書き手への1行に決まった AIX ツールの指示が出る", () => {
  const meta: Record<string, unknown> = { ...mind("先に取られる不安"), check_order_type: "T2_question_fact", condition_change_type: "rent_change" };
  meta.feeling_conductor = decideFromFeeling(meta);
  meta.feeling_aix_order = aixToolOrders(meta);
  withEnv("on", () => { const b = buildConductorBrief(meta); const line = briefLineForRole({ ...meta, conductor_brief: b }, "close") ?? ""; assert.match(line, /AIX ツール 申込で抑える流れ→返信の一手（申込の流れ）／登録の条件そのもの/); });
});
console.log(`AIX ツールへの指示 ${n2} 件 ok`);
