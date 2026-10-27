// 約束の期限の日と残り（app/lib/promise-due.ts・PROMISE_DUE_NOTE）— 作り物の時刻・LLM なし
// 実行: npx tsx app/lib/__tests__/promise-due.test.ts
import { promiseDueDay, promiseDueLabel, promiseDueNoteEnabled } from "../promise-due";
import { buildPromiseBrainNote, type PromiseTrack } from "../promise-tracker";

let passed = 0, failed = 0;
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function eq<T>(a: T, b: T) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); }

const SAID = Date.parse("2026-10-27T18:00:00+09:00"); // 火曜
const md = (d: number | null) => (d == null ? null : `${new Date(d).getUTCMonth() + 1}/${new Date(d).getUTCDate()}`);
console.log("promise-due");
it("切替は既定 off", () => { eq(promiseDueNoteEnabled({}), false); eq(promiseDueNoteEnabled({ PROMISE_DUE_NOTE: "on" }), true); });
it("期限の日を読む", () => {
  eq(md(promiseDueDay("明日一番で管理会社に確認させて頂きます", SAID)), "10/28");
  eq(md(promiseDueDay("本日中にお送りさせて頂きます", SAID)), "10/27");
  eq(md(promiseDueDay("10/30までにお送りさせて頂きます", SAID)), "10/30");
  eq(md(promiseDueDay("週明けにご連絡させて頂きます", SAID)), "11/2");
  eq(md(promiseDueDay("金曜日にご連絡させて頂きます", SAID)), "10/30");
  eq(md(promiseDueDay("来週の月曜にご連絡させて頂きます", SAID)), "11/2");
  eq(md(promiseDueDay("確認出来次第ご連絡させて頂きます", SAID)), null);
});
it("残り・今日・過ぎ", () => {
  eq(promiseDueLabel("明日一番で確認させて頂きます", SAID, Date.parse("2026-10-28T10:00:00+09:00")), "期限 10/28（今日）");
  eq(promiseDueLabel("明日一番で確認させて頂きます", SAID, Date.parse("2026-10-30T10:00:00+09:00")), "期限 10/28（2日過ぎ）");
  eq(promiseDueLabel("10/30までにお送りさせて頂きます", SAID, Date.parse("2026-10-28T10:00:00+09:00")), "期限 10/30（あと2日）");
});
it("ブレインの材料: off は「期限の語あり」・on は期限の日", () => {
  const track: PromiseTrack = { made: 1, kept: 0, open: [{ kind: "確認", sentence: "明日一番で管理会社に確認させて頂きます", at: new Date(SAID).toISOString(), elapsedH: 40, hasDeadline: true, status: "遅れ" }] };
  const now = Date.parse("2026-10-29T10:00:00+09:00");
  delete process.env.PROMISE_DUE_NOTE;
  eq(buildPromiseBrainNote(track, null, now).includes("・期限の語あり"), true);
  process.env.PROMISE_DUE_NOTE = "on";
  try { eq(buildPromiseBrainNote(track, null, now).includes("・期限 10/28（1日過ぎ）"), true); } finally { delete process.env.PROMISE_DUE_NOTE; }
});
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
