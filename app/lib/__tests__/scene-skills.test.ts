// app/lib/__tests__/scene-skills.test.ts — 場面の技能と決まりの本（純関数）
import { sceneSkillsOn, buildRuleBook, ruleBookNote, buildSceneSkill, ruleText, type RuleRow } from "../scene-skills";
let pass = 0, fail = 0;
const t = (n: string, ok: boolean, info?: unknown) => { if (ok) pass++; else { fail++; console.log(`  NG ${n} → ${JSON.stringify(info)}`); } };
const r = (id: string, priority: number, tags: string[], parent: string | null, created_at = "2026-10-01", title = `決まり${id}`): RuleRow => ({ id, title, insight: `中身${id}`, priority, tags, parent, created_at });
const rows: RuleRow[] = [
  r("p0", 0, ["絶対・最優先"], null),
  r("umb", 1, ["統括"], null, "2026-10-02"),                     // 場面の札が無い親（祖先として入る）
  r("c1", 2, ["場面:初期費用"], "umb", "2026-10-05"),
  r("c2", 1, ["場面:初期費用"], "umb", "2026-10-06"),
  r("x", 1, ["場面:内覧"], null),
];
t("既定 off", !sceneSkillsOn({}) && sceneSkillsOn({ SCENE_SKILLS: "on" }));
const book = buildRuleBook(rows, "cost", { maxPriority: 2 });
t("P0 が先頭・親が子より先・場面外の祖先も入る・他の場面は入らない", book.map((b) => b.id).join() === "p0,umb,c2,c1", book.map((b) => b.id));
t("子の parent は本の中の親", book.find((b) => b.id === "c1")?.parent === "umb");
t("既定は P1 まで", !buildRuleBook(rows, "cost").some((b) => b.id === "c1"));
const tight = buildRuleBook(rows, "cost", { maxPriority: 2, budgetChars: 10 });
t("上限でも P0 は落とさない", tight.some((b) => b.id === "p0"));
const note = ruleBookNote(book, "cost");
t("注記（★・字下げ）", /★ 決まりp0/.test(note) && /\n　・ 決まりc2/.test(note), note);
const sk = buildSceneSkill(rows, "cost", { retires: ["stanceNote:締め"] });
t("技能（道具は NEED_TOOLS の名前・束は2つ・退役の一覧）", sk.brain.tools.includes("estimate") && sk.writer.rules.length > 0 && sk.retires[0] === "stanceNote:締め");
t("1行の長さ", ruleText({ title: "題", insight: "あ".repeat(500) }).length <= 220);
console.log(`scene-skills: ${pass} pass / ${fail} fail`);
if (fail) process.exit(1);
