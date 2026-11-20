// 試験の外れから統括の学びの下書きを作る（scripts/lib/exam-lessons.ts）
// 実行: npx tsx scripts/lib/__tests__/exam-lessons.test.ts（全 PASS で exit 0）
import { buildLessonDrafts, lessonPrompt, cleanLesson, lessonsBuildOn, missKindOf } from "../exam-lessons";

let pass = 0, fail = 0;
const ok = (name: string, c: boolean, d: unknown = "") => { if (c) pass++; else { fail++; console.error(`✗ ${name}`, d); } };

ok("既定 off・on で入る", !lessonsBuildOn({}) && lessonsBuildOn({ CONDUCTOR_LESSONS_BUILD: "on" }));
ok("原因の3つへの寄せ", missKindOf("材料が届いていない") === "material_missing" && missKindOf("場面・決まりの読み違い") === "scene_misread" && missKindOf("AIX の番を返信にした") === "reply_vs_aix" && missKindOf("要確認") === null);

// 今夜の q174 の形: 前 2段:pickup 3/3・今 2/4（2回目 AIX:estimate_sheet・4回目 返信）＝過半数で道○ではない（2/4）
const brain = { check_order: { type: "T1_conditions_first", scene: "conditions" }, customer_emotion: "迷い", situation_now: { stage: "proposing" } };
const rows = [
  { id: "q174", rep: 1, path: { code: "2段:pickup", ok: true }, score: { pass: true }, brain },
  { id: "q174", rep: 2, path: { code: "AIX:estimate_sheet", ok: false }, score: { pass: false }, brain },
  { id: "q174", rep: 3, path: { code: "2段:pickup", ok: true }, score: { pass: true }, brain },
  { id: "q174", rep: 4, path: { code: "返信", ok: false }, score: { pass: false }, brain },
  { id: "q999", rep: 1, path: { code: "返信", ok: false }, score: { pass: false }, brain }, // 従業員の番（作らない）
  { id: "q100", rep: 1, path: { code: "返信", ok: true }, score: { pass: true }, brain },   // 当たり（作らない）
];
const problems = [
  { id: "q174", conv: "conv-174", accept: ["2段:pickup"], why: "条件の提示→ピックアップの約束", customer: "〇〇駅で2LDK", type: "待って・閉じる" },
  { id: "q999", conv: "conv-999", accept: ["返信"], customer: "x" },
  { id: "q100", conv: "conv-100", accept: ["返信"], customer: "y" },
];
const ds = buildLessonDrafts("grp-brain-1121-p1", rows as never, problems, new Set(["q174", "q100"]));
ok("外れた竹内さんの番だけ（q174）", ds.length === 1 && ds[0].source === "exam:q174#2@grp-brain-1121-p1", ds.map((d) => d.source));
const d = ds[0];
ok("欄が埋まる（場面・駅・気持ち・確認の順番・一手）", d.scene === "conditions" && d.stage === "proposing" && d.mood === "迷い" && d.check_order === "T1_conditions_first" && d.expected_act === "2段:pickup" && d.got_act === "AIX:estimate_sheet", d);
ok("出所の会話（漏れの線）と重ね鍵", d.source_conv === "conv-174" && d.dedupe_key === "conv-174|conditions|2段:pickup|AIX:estimate_sheet");
ok("状況の文は場面・段階・お客様", d.situation_text.includes("場面: conditions") && d.situation_text.includes("段階: proposing"));
const pr = lessonPrompt(d);
ok("問いにお客様の文を渡さない（型・一手・why だけ）", !pr.includes("〇〇駅で2LDK") && pr.includes("竹内さんの一手: 2段:pickup"));
ok("1行・80字・名前を伏せる", cleanLesson("「条件の場面では佐藤さんにピックアップの約束を返す（なぜ: 条件が出たら探す番）」\n2行目") === "条件の場面ではお客様にピックアップの約束を返す（なぜ: 条件が出たら探す番）");
ok("短すぎる答えは使わない", cleanLesson("はい") === null);

console.log(`exam-lessons: ${pass} pass / ${fail} fail`);
if (fail) process.exit(1);
