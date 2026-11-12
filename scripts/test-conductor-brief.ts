// scripts/test-conductor-brief.ts — 統括の指示書（conductor-brief.ts）と確かめる段・自信の印（conductor-doubt.ts）のテスト（LLM/DB なし・費用0・作業員22）
// 実行: npx tsx scripts/test-conductor-brief.ts
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { conductorBriefMode, buildConductorBrief, conductorBriefDigest, BRIEF_NONE } from "../app/lib/conductor-brief";
import { DOUBT_TABLE, DOUBT_KINDS, SURE_CUES, SURE_LINE, HANDOFF_RULE, briefDoubts, briefSure, rankDoubtKinds } from "../app/lib/conductor-doubt";
import { BASIS_ROUTE_WORD_RE } from "../app/lib/brain-judge-basis";
import { toFreshDigest } from "../app/lib/brain-layers";

let n = 0;
const t = (name: string, f: () => void) => { f(); n++; console.log("ok", name); };
const cell = (key: string, state: string) => ({ key, state }) as never;

t("既定は off（未設定・変な値）・shadow／on は記録だけ", () => {
  assert.equal(conductorBriefMode({}), "off");
  assert.equal(conductorBriefMode({ CONDUCTOR_BRIEF: "x" }), "off");
  assert.equal(conductorBriefMode({ CONDUCTOR_BRIEF: "shadow" }), "shadow");
  assert.equal(conductorBriefMode({ CONDUCTOR_BRIEF: "on" }), "shadow");
});

t("off の時は digest に cb が無い・記録がある時だけ入る", () => {
  const d = toFreshDigest({ analyzed_msg_ts: null, action: "x" }, null) as Record<string, unknown>;
  assert.ok(!("cb" in d));
  const b = buildConductorBrief({});
  const d2 = toFreshDigest({ analyzed_msg_ts: null, action: "x", conductor_brief: b }, null) as Record<string, unknown>;
  assert.match(String(d2.cb), /^未\|p:\?\|m:未\|o:未\|f:未\|d:-\|s:/);
});

t("部品が無い欄は「未」・何が未かを notYet に", () => {
  const b = buildConductorBrief({});
  for (const k of ["main", "facts", "missing", "open", "type", "alloc", "combine", "next"] as const) assert.equal(b[k], BRIEF_NONE, k);
  for (const k of ["customer_part", "fact_id", "next_concrete", "missing", "open", "type", "alloc", "combine", "key_point"]) assert.ok(b.notYet.includes(k), k);
});

const meta = {
  analyzed_msg_ts: "2026-11-12T03:00:00Z", action: null, reply_mode: "auto_reply",
  check_order_type: "T2_question_fact",
  conductor_allocation: { name: "T2_question_fact/n", parts: ["judge", "fetch", "combine", "compose", "writer", "check_ground"] },
  two_message_plan_digest: "1:answer",
  turn_contract: { asks: [{ quote: "最短でいつ入居", kind: "question", route: "reply", basis: "company_fact", answer: "審査次第でお申込日から10日程", topic: "move_in" }] },
  judge_basis: { purpose: "answer", key_point: "最短の入居の日", depth: "normal", readings: [{ focus: "answer" }], chosen: 0 },
  conductor_brief_inputs: { info: { node: "searching", cells: [cell("move_in", "known"), cell("area", "unknown")] }, ledger: { open: [], keptPromises: [] } },
};
t("具体の一覧: 主の要件・事実と出所・足りない情報・照らし合わせ・型と順番・配分・組・次の一手・目的と要点", () => {
  const b = buildConductorBrief(meta);
  assert.deepEqual(b.main !== BRIEF_NONE && b.main.items[0], { kind: "question", quote: "最短でいつ入居", topic: "move_in" });
  assert.deepEqual(b.facts, [{ quote: "最短でいつ入居", value: "審査次第でお申込日から10日程", from: "会社の事実" }]);
  assert.deepEqual(b.missing !== BRIEF_NONE && b.missing.keys, [{ key: "area", state: "unknown" }]);
  assert.deepEqual(b.open, []);
  assert.ok(b.type !== BRIEF_NONE && b.type.id === "T2_question_fact" && b.type.check[0] === "read_ask" && b.type.depth === "normal+fact");
  assert.ok(b.alloc !== BRIEF_NONE && b.alloc.parts.includes("check_ground"));
  assert.equal(b.combine, "1:answer");
  assert.ok(b.next !== BRIEF_NONE && b.next.from === "type_table");
  assert.deepEqual(b.aim, { purpose: "answer", purposeFrom: "judge_basis", keyPoint: "最短の入居の日" });
  assert.equal(b.doubts.length, 0);
  assert.equal(b.sure.level, "high");
  assert.equal(conductorBriefDigest(b), "T2|p:answer|m:1|o:0|f:1|d:-|s:high|未:3");
});

t("返信か AIX かを決める言葉を入れない（指示書の欄の名前・型の表の文・事実の値以外）", () => {
  const b = buildConductorBrief(meta);
  const own = JSON.stringify({ ...b, facts: [], main: BRIEF_NONE, type: b.type === BRIEF_NONE ? b.type : { ...b.type, why: "" } });
  assert.ok(!BASIS_ROUTE_WORD_RE.test(own), own);
});

t("疑いの印の表: 種類ごとに突き合わせ・なぜ・直しの型・直しの多い順", () => {
  assert.deepEqual(DOUBT_TABLE.map((d) => d.kind), [...DOUBT_KINDS]);
  for (const d of DOUBT_TABLE) assert.ok(d.compares.includes("×") && d.why.length > 15, d.kind);
  for (let i = 1; i < DOUBT_TABLE.length; i++) assert.ok(DOUBT_TABLE[i - 1].count1016 >= DOUBT_TABLE[i].count1016, DOUBT_TABLE[i].kind);
  // 2026-10-16 の weak-spots.json があれば、表の数と並びがそこから出る数と同じ
  const f = resolve(__dirname, "../../../exam-cache/edited-turns/2026-10-16/weak-spots.json");
  if (existsSync(f)) {
    const r = rankDoubtKinds((JSON.parse(readFileSync(f, "utf8")) as { spots: never[] }).spots);
    for (const d of DOUBT_TABLE) assert.equal(r.find((x) => x.kind === d.kind)!.n, d.count1016, d.kind);
    console.log("   2026-10-16 の直しの数:", r.map((x) => `${x.kind}=${x.n}`).join(" "));
  }
});

const base: Record<string, unknown> = { asks: [], ledger: null, info: null, typeId: null };
t("疑いの印: 種類ごとに当たる（決め直さない・meta は変えない）", () => {
  const kinds = (m: Record<string, unknown>, c: Record<string, unknown>) => briefDoubts(m, { ...base, ...c } as never).map((d) => d.kind);
  assert.deepEqual(kinds({}, { ledger: { open: [{ kind: "their_question_unanswered", what: "駐車場の空き", at: "", overdue: false }], keptPromises: [] }, asks: [{ quote: "初期費用", kind: "question" }] }), ["fact_missed"]);
  assert.deepEqual(kinds({ action: "property_send" }, { typeId: "T1_conditions_first" }), ["path_mismatch"]);
  assert.deepEqual(kinds({ reply_mode: "auto_reply", action: "x" }, { typeId: "T10_result_ready" }), ["path_mismatch"]);
  assert.deepEqual(kinds({ read_candidates: { turn: "ack_only" }, customer_questions: ["何時まで？"] }, {}), ["misread"]);
  assert.deepEqual(kinds({ judge_basis: { focus: "close" }, conductor_focus: { focus: "answer" } }, {}), ["misread"]);
  assert.deepEqual(kinds({ appeal_timing: { level: "must" }, hesitancy_pattern: "thinking" }, {}), ["push_over_ceiling"]);
  assert.deepEqual(kinds({ appeal_timing: { level: "must" }, hesitancy_pattern: "thinking", customer_mindset: { anxiety: { target: "先に取られる" } } }, {}), []);
  assert.deepEqual(kinds({}, { asks: [{ kind: "question", route: "promise", basis: "material", answer: "確認させて頂きます" }] }), ["held_answerable"]);
  assert.deepEqual(kinds({}, { asks: [{ kind: "request", route: "promise", answer: "募集状況を確認させて頂きます" }], info: { node: "x", cells: [cell("area", "known")] } }), ["held_answerable"]);
  assert.deepEqual(kinds({ analyzed_msg_ts: "2026-11-12T12:30:00Z" }, { asks: [{ kind: "request", route: "promise", answer: "本日中にご連絡させて頂きます" }] }), ["time_line"]);
  assert.deepEqual(kinds({ analyzed_msg_ts: "2026-11-12T03:30:00Z" }, { asks: [{ kind: "request", route: "promise", answer: "本日中にご連絡させて頂きます" }] }), []);
  assert.deepEqual(kinds({}, { asks: [{ kind: "question", route: "reply", basis: "judgement", answer: "空いています" }] }), ["answered_staff_only"]);
  assert.deepEqual(kinds({ action: "estimate_sheet" }, { asks: [{ kind: "question", route: "aix", basis: "company_fact", answer: "カード払いなら可" }] }), ["fact_but_staff"]);
  // 複数当たった時は表の並び（直しの多い順）
  const many = briefDoubts({ action: "property_send", read_candidates: { turn: "ack_only" }, customer_questions: ["?"] }, { ...base, typeId: "T4_property_shared", ledger: { open: [{ kind: "their_question_unanswered", what: "ペット可否", at: "", overdue: false }], keptPromises: [] } } as never);
  assert.deepEqual(many.map((d) => d.kind), ["fact_missed", "path_mismatch", "misread"]);
});

t("自信の印: 手がかりごとに重みとなぜ・合計で高・中・低・人に回す線の案", () => {
  for (const c of SURE_CUES) assert.ok(c.weight > 0 && c.why.length > 10, c.key);
  const s0 = briefSure({}, { doubts: [], info: null, typeId: "T2_question_fact" });
  assert.deepEqual([s0.level, s0.score, s0.handoff], ["high", 0, false]);
  const s1 = briefSure({ judge_basis: { depth: "deep" } }, { doubts: [], info: null, typeId: "T12_hooked_comparing_taken" });
  assert.deepEqual([s1.level, s1.score, s1.cues], ["mid", 2, ["deep", "rare_type"]]);
  const s2 = briefSure({ read_candidates: { options: ["a", "b"], chosen: null } }, { doubts: [{ kind: "misread", why: "" }], info: { node: null, cells: [cell("area", "unwired")] }, typeId: null });
  assert.equal(s2.level, "low"); assert.ok(s2.score >= SURE_LINE.low); assert.equal(s2.handoff, true);
  const s3 = briefSure({}, { doubts: [{ kind: HANDOFF_RULE.kinds[0], why: "" }], info: null, typeId: "T2_question_fact" });
  assert.deepEqual([s3.level, s3.handoff], ["mid", true]);
});

console.log(`\n${n} 件 ok`);
