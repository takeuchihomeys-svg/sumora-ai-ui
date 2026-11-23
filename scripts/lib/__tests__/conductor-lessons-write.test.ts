// npx tsx scripts/lib/__tests__/conductor-lessons-write.test.ts
// 2026-11-23 作業員L: 統括の学びに書く前の確かめ（表の CHECK・NOT NULL と同じ線・鍵）
import assert from "node:assert/strict";
import { lessonRowProblems, lessonInsertRow, lessonWriteKeyProblem, LESSON_MAX } from "../conductor-lessons-write";

const ok = { source: "lesson:L-1123", source_conv: "x", dedupe_key: "L|a", scene: "AIX:property_send", stage: "proposing", mood: null, expected_act: "AIX:property_send", got_act: "返信", changed_stage: null, miss_kind: "scene_misread" as const, check_order: null, situation_text: "場面: AIX:property_send", lesson: "型（なぜ: …）" };
assert.deepEqual(lessonRowProblems(ok), []);
assert.ok(lessonRowProblems({ ...ok, lesson: "あ".repeat(LESSON_MAX + 1) })[0].includes("120"));
assert.ok(lessonRowProblems({ ...ok, miss_kind: "other" as never }).some((p) => p.includes("miss_kind")));
assert.ok(lessonRowProblems({ ...ok, situation_text: "" }).some((p) => p.includes("situation_text")));
assert.deepEqual(lessonRowProblems({ ...ok, miss_kind: null }), []);
// seed（表に無い欄）は入れない・is_current は true
const row = lessonInsertRow({ ...ok, seed: { type: null } });
assert.equal("seed" in row, false);
assert.equal(row.is_current, true);
// 鍵: service が無ければ書かない（公開キーは RLS で落ちる）
assert.ok(lessonWriteKeyProblem({ NEXT_PUBLIC_SUPABASE_ANON_KEY: "x" }));
assert.equal(lessonWriteKeyProblem({ SUPABASE_SERVICE_ROLE_KEY: "y" }), null);
console.log("conductor-lessons-write: ok");
