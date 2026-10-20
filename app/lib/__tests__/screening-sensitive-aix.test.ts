// 審査の事情（screening-sensitive）の AIX・物件の経路のテスト（LLM なし・DB なし・外への fetch なし）
// 実行: npx tsx app/lib/__tests__/screening-sensitive-aix.test.ts
// ⚠ 実際のお客様の文は使わない（作り文だけ）
import { readFileSync } from "node:fs";
import {
  screeningPiiAixEnabled, screeningPiiPinsAction, screeningPiiForcesClaude, dropScreeningSensitiveLines, SCREENING_PII_PROPERTY_ONLY_ACTIONS,
  type ScreeningSensitiveHit,
} from "../screening-sensitive";
import { screeningSensitiveForConversation, clearScreeningSensitiveCache, SCREENING_SENSITIVE_MISS_TTL_MS, SCREENING_SENSITIVE_UNREADABLE } from "../screening-sensitive-server";
import { runInDeepseekScope, setDeepseekScope } from "../deepseek-scope";
import { willRouteAlt } from "../llm-alt-provider";
import { jevSystemOne } from "../jev-client";

let passed = 0, failed = 0;
const queue: Array<[string, () => unknown]> = [];
function it(name: string, fn: () => unknown) { queue.push([name, fn]); }
function ok(cond: unknown, msg: string) { if (!cond) throw new Error(msg); }

const HIT: ScreeningSensitiveHit = { category: "保証人の事情", word: "保証人がいない" };
// 回す設定（鍵は作り物・fetch しない＝willRouteAlt は設定を読むだけ）
const ALT_ENV = { LLM_ALT_PROVIDER: "deepseek", DEEPSEEK_API_KEY: "test-key", LLM_ALT_ACTIONS: "property_send,estimate_sheet,viewing_invite,greeting_viewing,property_check_result,acknowledge_check,followup_revive,property_text_detail" };
// aix/action と同じ順: 当たり → postApply → willRouteAlt
const goesAlt = (action: string, hit: ScreeningSensitiveHit | null, env: Record<string, string | undefined> = {}) =>
  willRouteAlt(action, { postApply: screeningPiiForcesClaude(action, hit, env) }, { ...ALT_ENV, ...env });

// ─── 名札の判定 ───────────────────────────────────────────────
const HISTORY = ["property_send", "estimate_sheet", "viewing_invite", "greeting_viewing", "property_check_result", "acknowledge_check", "followup_revive", "property_recommendation", "condition_hearing", "brand_new_action"];
it("履歴を入れる名札（AIX の本文）は当たれば Claude", () => {
  for (const a of HISTORY) {
    ok(screeningPiiPinsAction(a), `${a} を固定しない`);
    ok(screeningPiiForcesClaude(a, HIT, {}), `${a} を当たりで固定しない`);
  }
});
it("履歴を入れる名札: 当たれば DeepSeek に回らない・当たらなければ今までどおり回る", () => {
  for (const a of ["property_send", "estimate_sheet", "viewing_invite"]) {
    ok(goesAlt(a, null) === true, `${a}: 当たり無しで回らない（設定の前提が崩れた）`);
    ok(goesAlt(a, HIT) === false, `${a}: 当たりで回っている`);
  }
});
it("物件の文だけを読む名札（property_text_detail 等）は当たっても DeepSeek のまま", () => {
  for (const a of SCREENING_PII_PROPERTY_ONLY_ACTIONS) ok(!screeningPiiForcesClaude(a, HIT, {}), `${a} を固定している`);
  ok(goesAlt("property_text_detail", HIT) === true, "property_text_detail が回らない");
});
it("SCREENING_PII_CLAUDE_AIX=off・SCREENING_PII_CLAUDE=off は今までどおり（当たっても回る）", () => {
  ok(screeningPiiAixEnabled({}) === true, "既定 on");
  ok(screeningPiiAixEnabled({ SCREENING_PII_CLAUDE_AIX: "off" }) === false, "AIX off");
  ok(screeningPiiAixEnabled({ SCREENING_PII_CLAUDE: "OFF" }) === false, "全体 off");
  ok(goesAlt("property_send", HIT, { SCREENING_PII_CLAUDE_AIX: "off" }) === true, "AIX off で回らない");
  ok(goesAlt("property_send", HIT, { SCREENING_PII_CLAUDE: "off" }) === true, "全体 off で回らない");
});
it("行ごとに落とす: 事情の行だけ消え、物件の条件の言い方（外国人可）は残る", () => {
  const t = "駅徒歩10分以内\n保証人がいないので相談したい\n外国人可の物件";
  ok(dropScreeningSensitiveLines(t) === "駅徒歩10分以内\n外国人可の物件", dropScreeningSensitiveLines(t));
});

// ─── 会話ごとの判定（DB を読み直さない） ───────────────────────────
it("リクエストの箱に同じ会話の判定があれば DB を読まない", async () => {
  clearScreeningSensitiveCache();
  let loads = 0;
  const load = async () => { loads++; return null; };
  const r = await runInDeepseekScope(async () => {
    setDeepseekScope({ conversationId: "c-scope", mark: { kind: "blocked" }, screeningSensitive: async () => HIT });
    return screeningSensitiveForConversation("c-scope", { sb: {} as never, load });
  });
  ok(r === HIT && loads === 0, `loads=${loads}`);
});
it("当たった会話は覚え続ける・当たらない会話は短い間だけ・同時の読みは1回", async () => {
  clearScreeningSensitiveCache();
  let loads = 0;
  const loadHit = async () => { loads++; return HIT; };
  await Promise.all([1, 2, 3].map(() => screeningSensitiveForConversation("c-hit", { sb: {} as never, load: loadHit, now: 0 })));
  ok(loads === 1, `同時の読み ${loads}`);
  ok((await screeningSensitiveForConversation("c-hit", { sb: {} as never, load: loadHit, now: 10 * SCREENING_SENSITIVE_MISS_TTL_MS })) === HIT && loads === 1, "当たりを忘れた");
  let missLoads = 0;
  const loadMiss = async () => { missLoads++; return null; };
  await screeningSensitiveForConversation("c-miss", { sb: {} as never, load: loadMiss, now: 0 });
  await screeningSensitiveForConversation("c-miss", { sb: {} as never, load: loadMiss, now: 1000 });
  ok(missLoads === 1, `短い間に読み直した ${missLoads}`);
  await screeningSensitiveForConversation("c-miss", { sb: {} as never, load: loadMiss, now: SCREENING_SENSITIVE_MISS_TTL_MS + 1 });
  ok(missLoads === 2, `時間が過ぎても読み直さない ${missLoads}`);
});
it("入口（fresh）は当たらなかった覚えを使わない・当たりの覚えは使う", async () => {
  clearScreeningSensitiveCache();
  let n = 0;
  await screeningSensitiveForConversation("c-fresh", { sb: {} as never, load: async () => { n++; return null; }, now: 0 });
  const r = await screeningSensitiveForConversation("c-fresh", { sb: {} as never, load: async () => { n++; return HIT; }, now: 1000, fresh: true });
  ok(r === HIT && n === 2, `2分の間に打ち明けられた会話を見落とした ${n}`);
  const r2 = await screeningSensitiveForConversation("c-fresh", { sb: {} as never, load: async () => { n++; return null; }, now: 2000, fresh: true });
  ok(r2 === HIT && n === 2, `当たりの覚えを使わない ${n}`);
});
it("読めなければ当たった側（覚えない）", async () => {
  clearScreeningSensitiveCache();
  const r = await screeningSensitiveForConversation("c-err", { sb: {} as never, load: async () => { throw new Error("db down"); } });
  ok(r === SCREENING_SENSITIVE_UNREADABLE, "当たった側に倒していない");
});

// ─── Jev（別の会社）: 当たった会話は呼ばない ─────────────────────────
const JEV_ENV = { TYPESAFE_API_KEY: "test-key" };
it("Jev: 当たった会話は fetch しない・当たらなければ fetch する・off は今までどおり", async () => {
  let calls = 0;
  const fetchImpl = (async () => { calls++; return new Response(JSON.stringify({ model: "jev-test", answers: {}, usage: { input_tokens: 0, output_tokens: 0 } }), { status: 200 }); }) as typeof fetch;
  const r1 = await jevSystemOne({ state: "x", questions: {}, conversationId: "c1", env: JEV_ENV, fetchImpl, screeningCheck: async () => HIT });
  ok(r1 === null && calls === 0, `当たりで呼んだ calls=${calls}`);
  await jevSystemOne({ state: "x", questions: {}, conversationId: "c1", env: JEV_ENV, fetchImpl, screeningCheck: async () => null });
  ok(calls === 1, `当たり無しで呼ばない calls=${calls}`);
  await jevSystemOne({ state: "x", questions: {}, conversationId: "c1", env: { ...JEV_ENV, SCREENING_PII_CLAUDE_AIX: "off" }, fetchImpl, screeningCheck: async () => HIT });
  ok(calls === 2, `off で呼ばない calls=${calls}`);
});

// ─── 配線（ソースを読んで確かめる） ─────────────────────────────
const src = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
it("aix/action: 当たれば postApply（申込以降と同じ）・名札で絞る・箱に置く", () => {
  const s = src("../../api/aix/action/route.ts");
  ok(/screeningPiiAixEnabled\(\) && screeningPiiPinsAction\(action\)/.test(s), "名札で絞っていない");
  ok(/if \(screeningPiiForcesClaude\(action, hit\)\) \{\s*ctx\.postApply = true;/.test(s), "postApply にしていない");
  const i = s.indexOf("screeningPiiForcesClaude(action, hit)");
  const j = s.indexOf("const goesAlt = willRouteAlt(action, { postApply: ctx.postApply })");
  ok(i > 0 && j > i, "回すかの判定の前で見ていない");
  ok(/screeningSensitive: \(\) => sensitiveP/.test(s), "箱に置いていない");
});
it("generate-reply: 読んだ判定を箱に置く", () => ok(/screeningSensitive: \(\) => screeningSensitivePromise/.test(src("../../api/generate-reply/route.ts")), "置いていない"));
it("condition-summary: 事情のある節は DeepSeek に渡さない", () => ok(/!screeningSensitiveSignal\(x\)/.test(src("../condition-summary-server.ts")), "落としていない"));
it("pref-learning: 事情のある発言を落とし、本文に残れば送らない", () => {
  const s = src("../customer-pref-learning-server.ts");
  ok(/msgs = msgs\.filter\(\(m\) => !screeningSensitiveSignal\(m\.text\)\)/.test(s), "発言を落としていない");
  ok(/screeningPiiAixEnabled\(\) && screeningSensitiveSignal\(user\)/.test(s), "最後の歯止めが無い");
});

(async () => {
  for (const [name, fn] of queue) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})();
