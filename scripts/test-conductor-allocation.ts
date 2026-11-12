// scripts/test-conductor-allocation.ts — 番ごとの部品の配分表（app/lib/conductor-allocation.ts）のテスト（LLM/DB なし・費用0・作業員22）
// 実行: npx tsx scripts/test-conductor-allocation.ts
import assert from "node:assert/strict";
import {
  ALLOCATION, PARTS, PART_STAGE, STEP_TO_PART, FOCUS_ORDER_ROLES, allocationMode, pickAllocation, pickAllocationFromCues, allocationFromMeta,
  allocationDigest, allocationDigestShort, allocationMetaDigest, stopCheck, partCostUsd, normDepth,
} from "../app/lib/conductor-allocation";
import { CHECK_ORDER_TYPES, CHECK_DEPTH, type CheckStep } from "../app/lib/check-order";
import { FOCUS_ORDER } from "../app/lib/conductor-focus";
import { ORDER_ROLES } from "../app/lib/judge-basis-types";
import { toFreshDigest } from "../app/lib/brain-layers";
import { buildAllocReport, formatAllocReport } from "./lib/allocation-score";

let n = 0;
const t = (name: string, f: () => void) => { f(); n++; console.log("ok", name); };
const DEPTHS = ["shallow", "normal", "deep"] as const;

t("既定は off（未設定・空・変な値）・shadow と on だけ読む", () => {
  assert.equal(allocationMode({}), "off");
  assert.equal(allocationMode({ CONDUCTOR_ALLOCATION: "" }), "off");
  assert.equal(allocationMode({ CONDUCTOR_ALLOCATION: "yes" }), "off");
  assert.equal(allocationMode({ CONDUCTOR_ALLOCATION: " Shadow " }), "shadow");
  assert.equal(allocationMode({ CONDUCTOR_ALLOCATION: "on" }), "on");
});

t("off の時は digest に何も足さない（meta に conductor_allocation が無い＝al の欄が無い）", () => {
  const meta = { analyzed_msg_ts: "2026-11-12T00:00:00Z", action: "property_send", customer_intent: "x" };
  const d = toFreshDigest(meta, null) as Record<string, unknown>;
  assert.ok(!("al" in d));
  // 記録がある時だけ al が入る
  const a = allocationFromMeta({ scene_evidence: { scene: "property_share" } })!;
  const d2 = toFreshDigest({ ...meta, conductor_allocation: a }, null) as Record<string, unknown>;
  assert.equal(d2.al, "T4/d:judge>fetch>deep>combine>compose>writer");
  // 判断の欄は配分があってもなくても同じ（配分は道を変えない）
  for (const k of ["aix", "intent", "dir", "tc"]) assert.deepEqual(d2[k], d[k], k);
});

t("どの型×深さにも配分がある（型は check-order の T1〜T11 全部・深さは3段）", () => {
  assert.equal(CHECK_ORDER_TYPES.length, 11);
  for (const ty of CHECK_ORDER_TYPES) for (const d of DEPTHS) {
    const a = ALLOCATION[ty.id]?.[d];
    assert.ok(a, `${ty.id}/${d} が無い`);
    assert.equal(a.typeId, ty.id); assert.equal(a.depth, d);
    assert.ok(a.parts.length >= 2 && a.parts[0] === "judge", `${a.name} の先頭は judge`);
    assert.ok(a.why.length > 10, a.name);
    assert.ok(a.stop.maxUsd >= a.estUsd, `${a.name} 上限が目安より低い`);
  }
});

t("部品名は FOCUS_ORDER の役の中だけ（配分・動かさない部品・対応表・PARTS）", () => {
  for (const p of PARTS) assert.ok(FOCUS_ORDER_ROLES.has(p), `PARTS の ${p} が FOCUS_ORDER に無い`);
  // FOCUS_ORDER の役は全部 PARTS にある（抜け無し）
  for (const r of FOCUS_ORDER_ROLES) assert.ok((PARTS as readonly string[]).includes(r), `FOCUS_ORDER の ${r} が PARTS に無い`);
  assert.deepEqual([...ORDER_ROLES].sort(), [...PARTS].sort());
  for (const ty of Object.values(ALLOCATION)) for (const a of Object.values(ty)) {
    for (const p of [...a.parts, ...a.optional, ...a.skip.map((s) => s.part)]) assert.ok(FOCUS_ORDER_ROLES.has(p), `${a.name}: ${p}`);
    // 動かす＋動かさない＝全部の部品（重なり無し）・動かさない部品には理由
    assert.equal(a.parts.length + a.skip.length, PARTS.length, a.name);
    for (const s of a.skip) assert.ok(!a.parts.includes(s.part) && s.why.length > 3, `${a.name} skip ${s.part}`);
    for (const o of a.optional) assert.ok(a.parts.includes(o), `${a.name} optional ${o}`);
  }
  for (const ps of Object.values(STEP_TO_PART)) for (const p of ps) assert.ok(FOCUS_ORDER_ROLES.has(p), p);
});

t("判断の順番（CheckStep）は全部、部品の対応表にある（名前は分けたまま）", () => {
  const steps = new Set<CheckStep>(CHECK_ORDER_TYPES.flatMap((x) => x.check));
  for (const s of steps) assert.ok(STEP_TO_PART[s]?.length, `対応が無い ${s}`);
  // 名前が重ならない（判断の1歩と部品は別の名前）
  for (const s of Object.keys(STEP_TO_PART)) assert.ok(!(PARTS as readonly string[]).includes(s), `同じ名前 ${s}`);
});

t("部品の順は段の順（大まか→細部→組み立て→確かめ）で、FOCUS_ORDER の各行の並びと食い違わない", () => {
  const rank = { rough: 0, detail: 1, compose: 2, verify: 3 };
  for (const ty of Object.values(ALLOCATION)) for (const a of Object.values(ty)) {
    for (let i = 1; i < a.parts.length; i++) assert.ok(rank[PART_STAGE[a.parts[i - 1]]] <= rank[PART_STAGE[a.parts[i]]], `${a.name} ${a.parts.join(">")}`);
    assert.equal(new Set(a.parts).size, a.parts.length, `${a.name} 重複`);
  }
  // FOCUS_ORDER の段（rough/detail/compose/verify）と PART_STAGE が同じ（propose だけ property_search→aix_desk・配分は promise_keep の aix_desk→property_search）
  for (const steps of Object.values(FOCUS_ORDER)) for (const s of steps) if (s.role !== "judge") assert.equal(PART_STAGE[s.role as keyof typeof PART_STAGE], s.stage, s.role);
});

t("浅い番は部品が少なく安い・深い番だけ deep を動かす（T3 は深くても deep を動かさない）", () => {
  for (const ty of CHECK_ORDER_TYPES) {
    const s = ALLOCATION[ty.id].shallow, nn = ALLOCATION[ty.id].normal, d = ALLOCATION[ty.id].deep;
    assert.ok(s.parts.length <= nn.parts.length && nn.parts.length <= d.parts.length, ty.id);
    assert.ok(s.estUsd <= nn.estUsd && nn.estUsd <= d.estUsd, `${ty.id} ${s.estUsd} ${nn.estUsd} ${d.estUsd}`);
    assert.ok(!s.parts.includes("deep") && !nn.parts.includes("deep"), ty.id);
    assert.ok(!s.parts.includes("check_worry") && !nn.parts.includes("check_worry"), ty.id);
    if (ty.id !== "T3_question_staff_only") assert.ok(d.parts.includes("deep"), ty.id);
  }
  assert.ok(!ALLOCATION.T3_question_staff_only.deep.parts.includes("deep"));
  assert.ok(ALLOCATION.T6_considering.deep.parts.includes("check_worry"));
  // 返信か AIX かの決め（後で果たす AIX）を今の番に寄せない: T1・T4 は aix_desk・estimate を動かさない
  for (const id of ["T1_conditions_first", "T4_property_shared"]) for (const d of DEPTHS) {
    assert.ok(!ALLOCATION[id][d].parts.includes("aix_desk") && !ALLOCATION[id][d].parts.includes("estimate"), `${id}/${d}`);
  }
  assert.equal(partCostUsd("deep"), 0.12);
});

t("選び方: 深さが無ければ型の既定の深さ・型が無ければ null（今まで通り）", () => {
  assert.equal(pickAllocation("T4_property_shared")!.name, "T4_property_shared/d");
  assert.equal(pickAllocation("T6_considering")!.depth, CHECK_DEPTH.T6_considering.base);
  assert.equal(pickAllocation("T2_question_fact", "shallow")!.name, "T2_question_fact/s");
  assert.equal(pickAllocation("T99"), null);
  assert.equal(pickAllocation(null), null);
  const c = pickAllocationFromCues({ resultReady: true, hasQuestion: true }, "normal")!;
  assert.equal(c.alloc.name, "T10_result_ready/n");
  assert.equal(pickAllocationFromCues({}), null);
  assert.equal(normDepth("light"), "shallow");
});

t("meta から: 型の id → 場面の既定の型・深さは judge_basis → brain_depth → 既定・action は読まない", () => {
  assert.equal(allocationFromMeta(null), null);
  assert.equal(allocationFromMeta({ scene_evidence: { scene: "other" } }), null);
  const a = allocationFromMeta({ check_order_type: "T9_apply_signal", judge_basis: { depth: "shallow" }, brain_depth: { depth: "deep" } })!;
  assert.deepEqual([a.name, a.from, a.depth_from], ["T9_apply_signal/s", "type", "judge_basis"]);
  const b = allocationFromMeta({ brain_depth: { depth: "light" } }, { scene: "ack" })!;
  assert.deepEqual([b.name, b.from, b.depth_from], ["T5_ack_hypothesis/s", "scene", "brain_depth"]);
  const x1 = allocationFromMeta({ scene_evidence: { scene: "cost" }, action: "estimate_sheet" });
  const x2 = allocationFromMeta({ scene_evidence: { scene: "cost" }, action: null });
  assert.deepEqual(x1, x2);
});

t("記録の1行: 名前と部品の順（orderDigest と同じ > つなぎ）", () => {
  const a = ALLOCATION.T5_ack_hypothesis.shallow;
  assert.equal(allocationDigest(a), "T5_ack_hypothesis/s:judge>writer");
  assert.equal(allocationDigestShort(a), "T5/s:judge>writer");
  assert.equal(allocationMetaDigest({ name: a.name, parts: a.parts }), "T5/s:judge>writer");
  assert.equal(allocationMetaDigest({ name: "x" }), null);
  assert.equal(allocationDigest(null), null);
});

t("止め時: 材料がそろったら fetch を呼ばない・任意の部品は上限を超えたら呼ばない・必須は止めない", () => {
  const a = ALLOCATION.T4_property_shared.deep;
  assert.equal(stopCheck(a, "fetch", { spentUsd: 0, have: [] }).call, true);
  assert.equal(stopCheck(a, "fetch", { spentUsd: 0, have: a.stop.materials }).call, false);
  assert.equal(stopCheck(a, "deep", { spentUsd: a.stop.maxUsd, have: [] }).call, false);
  assert.equal(stopCheck(a, "writer", { spentUsd: 99, have: [] }).call, true);
  assert.equal(stopCheck(a, "estimate", { spentUsd: 0, have: [] }).call, false);
});

t("物差し: 答案の配分（記録あり・推定）ごとに道の当たりと費用（id つき・label で等分）", () => {
  const specs = [{ id: "q1", scene: "ack" }, { id: "q2", scene: "property_share" }, { id: "q3", scene: "other" }];
  const rows = [
    { id: "q1", rep: 1, label: "L", brain: { conductor_allocation: allocationFromMeta({}, { scene: "ack" }) }, score: { path: true } },
    { id: "q2", rep: 1, label: "L", brain: {}, score: { path: false } },
    { id: "q3", rep: 1, label: "L", brain: {}, score: { path: true } },
  ];
  const r = buildAllocReport(specs, rows, [{ route: "script:brain-exam-L", usd: 0.3 }, { route: "x", usd: 0.1, id: "q2" }]);
  assert.equal(r.none, 1);
  const t5 = r.rows.find((x) => x.alloc === "T5_ack_hypothesis/n")!;
  assert.deepEqual([t5.n, t5.inferred, t5.pathOk, t5.usdPerTurn], [1, 0, 1, 0.1]);
  const t4 = r.rows.find((x) => x.alloc === "T4_property_shared/d")!;
  assert.deepEqual([t4.inferred, t4.hitRate, t4.usdPerTurn], [1, 0, 0.1]);
  assert.ok(formatAllocReport(r).includes("T4_property_shared/d"));
});

// 配分表の一覧（報告用）
if (process.argv.includes("--table")) for (const ty of CHECK_ORDER_TYPES) for (const d of DEPTHS) { const a = ALLOCATION[ty.id][d]; console.log(`${a.name}\t$${a.estUsd}\t${a.parts.join(">")}\t任意:${a.optional.join(",") || "-"}`); }
console.log(`\n${n} 件 ok`);
