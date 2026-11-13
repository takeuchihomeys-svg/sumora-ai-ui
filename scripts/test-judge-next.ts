// scripts/test-judge-next.ts — 判断の根拠のメモの次の行き先・答えられるのに約束にした印（BRAIN_JUDGE_BASIS_NEXT）→ 文の統括（compose-sentence-plan）へ plan のテスト（LLM/DB なし・費用0・作業員22）
// 実行: npx tsx scripts/test-judge-next.ts
import assert from "node:assert/strict";
import { brainJudgeBasisOutputItem, brainJudgeBasisNextOn, judgeNextOf, normalizeJudgeBasis, BRAIN_JUDGE_BASIS_FIELD } from "../app/lib/brain-judge-basis";
import { NEXT_DEST } from "../app/lib/next-move-types";
import { readSevenFields, readComposeContext, composeContextLines, handoffLeaks, BRAIN_FIELD_ROUTE, HANDOFF_FIELDS, JUDGE_DEST_TO_LEAD, JUDGE_DEST_JA, LEAD_TOS } from "../app/lib/compose-sentence-plan";
import { FIELD_LINKS } from "../app/lib/conductor-field-links";

let n = 0;
const t = (name: string, f: () => void) => { f(); n++; console.log("ok", name); };
const ON = { BRAIN_JUDGE_BASIS: "on", BRAIN_JUDGE_BASIS_NEXT: "on" };

t("既定 off: 出力の指定は今と同じ・judge_next は作らない", () => {
  assert.equal(brainJudgeBasisNextOn({}), false);
  assert.equal(brainJudgeBasisOutputItem({ BRAIN_JUDGE_BASIS: "on" }).includes("next_dest"), false);
  assert.ok(brainJudgeBasisOutputItem({ BRAIN_JUDGE_BASIS: "on" }).endsWith(BRAIN_JUDGE_BASIS_FIELD));
  assert.equal(brainJudgeBasisOutputItem({ BRAIN_JUDGE_BASIS_NEXT: "on" }), "");
  assert.equal(judgeNextOf({ next_dest: "viewing", focus: "close" }, { BRAIN_JUDGE_BASIS: "on" }), undefined);
  assert.equal(judgeNextOf({ next_dest: "viewing", focus: "close" }, {}), undefined);
});

t("on: next_dest と held_answerable は judge_basis の最後（order_why・key_point の後）＝道の前に置かない", () => {
  const s = brainJudgeBasisOutputItem(ON);
  assert.ok(s.indexOf('"next_dest"') > s.indexOf('"key_point"') && s.indexOf('"held_answerable"') > s.indexOf('"next_dest"'));
  assert.ok(s.indexOf('"next_dest"') > s.indexOf('"order_why"'));
  for (const d of NEXT_DEST) assert.ok(s.includes(d), d);
  assert.match(s, /道は変えない/);
});

t("読み取り: 一覧の外の行き先は捨てる・held は真偽だけ受ける", () => {
  const l = normalizeJudgeBasis({ focus: "answer", next_dest: "viewing", held_answerable: { held: true, quote: "何時まで内覧できますか" } })!;
  assert.equal(l.nextDest, "viewing"); assert.deepEqual(l.held, { held: true, quote: "何時まで内覧できますか" });
  assert.equal(normalizeJudgeBasis({ focus: "answer", next_dest: "bogus", held_answerable: { held: "yes" } })!.nextDest, null);
  assert.equal(normalizeJudgeBasis({ focus: "answer", held_answerable: { held: "yes" } })!.held, null);
  assert.deepEqual(judgeNextOf({ focus: "answer", next_dest: "viewing", held_answerable: { held: false, quote: "x" } }, ON), { dest: "viewing", held: false, quote: null });
  assert.equal(judgeNextOf({ focus: "answer" }, ON), undefined);
});

t("文の統括: judge_next の行き先を誘導先に（訴求のタイミング・方向の文より先）・src は judge_next", () => {
  const meta = { judge_next: { dest: "viewing", held: false, quote: null }, appeal_timing: { kind: "apply", level: "must" }, reply_direction: "答えて終える" };
  const s = readSevenFields(meta);
  assert.equal(s.leadTo, "viewing"); assert.equal(s.src.leadTo, "judge_next");
  // 無い時は今まで通り（訴求のタイミング）
  const s0 = readSevenFields({ appeal_timing: { kind: "apply", level: "must" } });
  assert.equal(s0.leadTo, "apply"); assert.equal(s0.src.leadTo, "material");
  // 7つの欄（seven_read.lead）がある時はそちらが先（ブレインの竹内さんの読みを優先）
  const s7 = readSevenFields({ seven_read: { lead: "estimate" }, judge_next: { dest: "viewing", held: false, quote: null } });
  assert.equal(s7.leadTo, "estimate");
  for (const [k, v] of Object.entries(JUDGE_DEST_TO_LEAD)) { assert.ok((NEXT_DEST as readonly string[]).includes(k), k); assert.ok((LEAD_TOS as readonly string[]).includes(v), v); }
  for (const d of NEXT_DEST) assert.ok(JUDGE_DEST_JA[d], d);
});

t("文の統括の注記に届く（受け渡しの漏れなし）・答えられるのに約束にしかけた問いの行", () => {
  const meta = { judge_next: { dest: "answer_only", held: true, quote: "最短の入居日" } };
  const lines = composeContextLines(readComposeContext(meta));
  assert.ok(lines.some((l) => l.includes("次の行き先（ブレイン・道の後）: 答えて終わり")));
  assert.ok(lines.some((l) => l.includes("答えられるのに確かめる約束にしかけた問い（材料で答える）: 最短の入居日")));
  assert.deepEqual(handoffLeaks(meta, lines.join("\n")), []);
  assert.equal(BRAIN_FIELD_ROUTE.judge_next, "plan");
  assert.ok(HANDOFF_FIELDS.some((f) => f.key === "judge_next" && f.carried === "plan"));
  assert.deepEqual(composeContextLines(readComposeContext({})).filter((l) => /次の行き先|しかけた問い/.test(l)), []);
});

t("連携の表: judge_next の行（道の後・文の統括へ）", () => {
  const r = FIELD_LINKS.find((x) => x.field === "judge_next");
  assert.ok(r && r.place === "after_route" && r.receivers.includes("compose") && r.metaKey === "judge_next");
});
console.log(`\n${n} 件 ok`);
