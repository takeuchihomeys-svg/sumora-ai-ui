// npx tsx app/lib/__tests__/conductor-lessons.test.ts
// 2026-11-21 作業員L: 統括が近い場面の学びを読む口（漏れの線・材料の1塊・記録の id・最終チェックの印）
import assert from "node:assert/strict";
import { conductorLessonsMode, excludeOwnConversation, excludeSourcesFor, pickLessons, lessonsMaterialLine, lessonsDigest, sameMissMark, type LessonRow } from "../conductor-lessons";

assert.equal(conductorLessonsMode({}), "off");
assert.equal(conductorLessonsMode({ CONDUCTOR_LESSONS: "shadow" }), "shadow");
assert.equal(conductorLessonsMode({ CONDUCTOR_LESSONS: "on" }), "on");

const conv = "44fd59ab-d7e3-4c37-9ac2-a8e722756eb7";
const rows: LessonRow[] = [
  { id: "aaaaaaaa-1", source: "exam:q404", source_conv: "44fd59ab-d7e3-4c37-9ac2-a8e722756eb7", scene: "proposing", stage: "proposing", lesson: "自分の会話の学び", got_act: "reply:promise", expected_act: "aix:property_send" },
  { id: "bbbbbbbb-2", source: "prod:44fd59ab@2026-11-01", scene: "proposing", lesson: "本番の同じ会話の学び" },
  { id: "cccccccc-3", source: "exam:q333", source_conv: "d040f80a", scene: "conditions", stage: "proposing", mood: "question", lesson: "条件の言い直しの番は新しい条件で探す約束が先。古い候補を送らない", miss_kind: "scene_misread", got_act: "aix:property_send", expected_act: "reply:promise" },
  { id: "dddddddd-4", source: "exam:q159", source_conv: "f7deb105", scene: "estimate", lesson: "条件の言い直しの番は新しい条件で探す約束が先。古い候補を送らない" },
  { id: "eeeeeeee-5", source: "exam:q323", source_conv: "a7ac4c90", scene: "estimate", stage: "estimate", lesson: "審査を先にの依頼は申込で審査をかけられると返信で答える", miss_kind: "reply_vs_aix" },
  { id: "ffffffff-6", source: "exam:q406", source_conv: "40f0db25", scene: "viewing", lesson: "4件目" },
];

// 漏れの線: 今の会話から作った学び（source_conv・prod の出所）は読まない
assert.deepEqual(excludeOwnConversation(rows, conv).map((r) => r.id[0]), ["c", "d", "e", "f"]);
assert.deepEqual(excludeSourcesFor(conv), ["prod:44fd59ab"]);
// 上位3件・同じ学びの文は1つに
const got = pickLessons(rows, conv);
assert.deepEqual(got.map((r) => r.id[0]), ["c", "e", "f"]);
// 材料の1塊（型となぜ・写さない）と記録の id
const line = lessonsMaterialLine(got);
assert.ok(line.startsWith("【近い場面の学び（型となぜ・参考。答えの文は写さない・今の会話の事実が優先）】"));
assert.ok(line.includes("- conditions・proposing: 条件の言い直しの番は新しい条件で探す約束が先。古い候補を送らない（前の外れ: 場面の読み違い）"), line);
assert.equal(lessonsDigest(got), "cccccccc,eeeeeeee,ffffffff");
assert.equal(lessonsMaterialLine([]), "");
assert.equal(lessonsDigest([]), null);
// 最終チェックの印: 同じ場面で前に外した一手と同じ下書きの一手だけ
assert.deepEqual(sameMissMark("aix:property_send", got, "conditions"), ["cccccccc"]);
assert.deepEqual(sameMissMark("aix:property_send", got, "estimate"), []);
assert.deepEqual(sameMissMark("reply:promise", got, "conditions"), []);
assert.deepEqual(sameMissMark("", got), []);

console.log("conductor-lessons: ok");
