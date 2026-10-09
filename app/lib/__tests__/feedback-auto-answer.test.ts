// AI 質問を設計知見（竹内さんの決定）で自動で答える（10/08 竹内さん「自動的にする」）
// 実行: npx tsx app/lib/__tests__/feedback-auto-answer.test.ts
import {
  feedbackAutoAnswerEnabled, pickAutoAnswerTargets, pickAixPatternToClose, questionQuery, autoAnswerPrompt, parseAutoAnswer, buildAutoAnswer,
  type PendingQuestion, type KbBasisRow,
} from "../feedback-auto-answer";
let passed = 0, failed = 0;
function it(name: string, fn: () => void) { try { fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); } }
function eq<T>(a: T, b: T, msg = "") { const x = JSON.stringify(a), y = JSON.stringify(b); if (x !== y) throw new Error(`${msg} got ${x} want ${y}`); }
function ok(v: unknown, msg = "") { if (!v) throw new Error(`expected truthy ${msg}`); }
const NOW = Date.parse("2026-10-08T03:00:00Z");
const Q = (o: Partial<PendingQuestion>): PendingQuestion => ({ id: "q1", question: "内覧の候補日は返信で出してよいですか？どの場面で使いますか", category: "knowledge_gap", created_at: "2026-09-10T00:00:00Z", ...o });

it("戻す口", () => { eq(feedbackAutoAnswerEnabled({}), true); eq(feedbackAutoAnswerEnabled({ FEEDBACK_AUTO_ANSWER: "off" }), false); });
it("対象: knowledge_gap・prompt_ambiguity だけ（aix_boundary・rule_review・aix_pattern は答えない）・古い順・上限", () => {
  const rows = [Q({ id: "b", created_at: "2026-09-20T00:00:00Z" }), Q({ id: "a", category: "prompt_ambiguity" }), Q({ id: "c", category: "aix_boundary" }), Q({ id: "d", category: "rule_review" }), Q({ id: "e", category: "aix_pattern" }), Q({ id: "f", question: "短い" })];
  eq(pickAutoAnswerTargets(rows).map((r) => r.id), ["a", "b"]);
  eq(pickAutoAnswerTargets(rows, 1).map((r) => r.id), ["a"]);
});
it("aix_pattern は7日たったら閉じる（aix-weekly-learning が編集差分から学ぶ）", () => {
  const rows = [Q({ id: "old", category: "aix_pattern", created_at: "2026-09-30T00:00:00Z" }), Q({ id: "new", category: "aix_pattern", created_at: "2026-10-05T00:00:00Z" }), Q({ id: "kg" })];
  eq(pickAixPatternToClose(rows, NOW), ["old"]);
});
it("引く問い: 札・区切り線・見出しを除く", () => {
  const q = questionQuery("[knowledge_id:b53bfb11]\n❓【確認】適用場面が不明確\n\n━━ 今回の会話（実例）━━\n内覧の候補日は");
  ok(!/knowledge_id|━|❓|【確認】/.test(q), q); ok(q.includes("内覧の候補日は"), q);
});
const KB: KbBasisRow[] = [
  { id: "aaaaaaaa-1", title: "内覧の候補日は AIX 内覧調整で出す", insight: "返信で候補日を作らない", priority: 1 },
  { id: "bbbbbbbb-2", title: "事例: ある日の内覧", insight: "経緯", priority: 3 },
];
it("答えの文: P0/P1 の根拠がある時だけ・根拠の id と題を付ける", () => {
  const a = buildAutoAnswer(parseAutoAnswer('```json\n{"answerable":true,"answer":"候補日は返信で作らず AIX 内覧調整で出す","basis":[1,2]}\n```'), KB);
  ok(a && a.text.startsWith("【自動回答・竹内さんの決定（設計知見）から】"), a?.text);
  eq(a?.basisIds, ["aaaaaaaa-1"]);
  ok(a!.text.includes("aaaaaaaa「内覧の候補日は"), a!.text);
});
it("答えない: answerable=false・根拠が P2/P3 だけ・空の答え・読めない返事", () => {
  eq(buildAutoAnswer(parseAutoAnswer('{"answerable":false,"answer":"","basis":[]}'), KB), null);
  eq(buildAutoAnswer(parseAutoAnswer('{"answerable":true,"answer":"事例どおりにする事になっている","basis":[2]}'), KB), null);
  eq(buildAutoAnswer(parseAutoAnswer('{"answerable":true,"answer":"","basis":[1]}'), KB), null);
  eq(parseAutoAnswer("わかりません"), null);
  eq(buildAutoAnswer(parseAutoAnswer('{"answerable":true,"answer":"番号違いの根拠を挙げた答え","basis":[9]}'), KB), null);
});
it("問いの文は呼ぶ側の伏せを通す（本名は渡さない）", () => {
  const p = autoAnswerPrompt("氏名：山田花子 さんの件", KB, (s) => s.replace(/山田花子/g, "［伏せ］"));
  ok(!p.includes("山田花子") && p.includes("［伏せ］") && p.includes("[1] （P1）"), p);
});
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
