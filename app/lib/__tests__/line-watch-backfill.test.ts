// 見張りの過去の番の埋め戻し（app/lib/line-watch-backfill.ts）・番1行の判定（line-watch-turn-eval.ts）・月ごとの一致率（line-watch-daily.sceneStatsByMonth）・
// 埋め戻しを解禁の線（sceneStats）と自動返信の関所（watchAixMatchRates）から外す事
// 実行: npx tsx app/lib/__tests__/line-watch-backfill.test.ts（自己完結ハーネス。全 PASS で exit 0）
// 材料: 本番の形（8/10 583171e6 の古い下書き・手本の sent_at は送信の 1秒後・お客様の名前は伏せた）
import {
  isBackfillTurn, pastTurnsOf, exampleForBurst, isStaleExampleDraft, planBackfillTurn, guardBackfillJudgement, jstMonthOf,
  type BfMsg, type BfExample, type BfDecision,
} from "../line-watch-backfill";
import { evalWatchTurn } from "../line-watch-turn-eval";
import { sceneStats, sceneStatsByMonth, type StatTurn } from "../line-watch-daily";
import { watchAixMatchRates } from "../watch-aix-match";
import { JUDGE_VERSION } from "../line-watch-judge";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function eq<T>(actual: T, exp: T) { if (JSON.stringify(actual) !== JSON.stringify(exp)) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); }
const RULES = { applyFormRe: /記入欄】/, staffFailRe: /否決/ };
const t0 = Date.parse("2026-08-10T00:00:00.000Z");
const at = (min: number, sec = 0) => new Date(t0 + min * 60_000 + sec * 1000).toISOString().replace("Z", "+00:00");
const cust = (min: number, text = "お客様の発言"): BfMsg => ({ sender: "customer", created_at: at(min), text });
const staff = (min: number, text: string): BfMsg => ({ sender: "staff", created_at: at(min), text });
const ex = (id: string, sentMin: number, draft: string | null, extra: Partial<BfExample> = {}): BfExample =>
  ({ id, conversation_id: "c1", sent_at: at(sentMin, 1), created_at: at(sentMin, 2), ai_draft: draft, entry_source: "line_reply", ...extra });
const NOW = Date.parse("2026-10-08T12:00:00Z");
const ESTIMATE = "かずしさんお世話になっております！！\n\nかしこまりました！！最大限割引させていただいた御見積書を作成しお送りさせて頂きます😊！！";

console.log("印");
it("verdict_detail.backfill がある行だけ埋め戻し", () => {
  eq([isBackfillTurn({ verdict_detail: { backfill: "ai_reply_examples" } }), isBackfillTurn({ verdict_detail: { reason: "exact" } }), isBackfillTurn({ verdict_detail: null }), isBackfillTurn(null)], [true, false, false, false]);
});

console.log("番の切り方（10巡目の正解の表と同じ）");
it("連投は1つの番・番の後にスタッフの発言があるか・申込フォームの後は申込以降・否決で戻る", () => {
  const msgs = [cust(0), cust(1), staff(5, "かしこまりました！！"), cust(10), staff(12, "【申込フォーム記入欄】"), cust(20), staff(25, "審査否決となりました"), cust(30), cust(40)];
  const ts = pastTurnsOf(msgs.slice(0, 8), [], RULES);
  eq(ts.map((t) => [t.turnAt === at(0) || t.turnAt === at(10) || t.turnAt === at(20) || t.turnAt === at(30), t.post, t.laterStaff]), [[true, false, true], [true, false, true], [true, true, true], [true, false, false]]);
  eq(ts[0].custLastAt, at(1));
});
it("申込へ（push 以外）の押下からも申込以降", () => {
  const ts = pastTurnsOf([cust(0), staff(2, "はい"), cust(10), staff(12, "はい")], [{ aix_type: "application_push", app_sub_mode: "apply", created_at: at(5) }], RULES);
  eq(ts.map((t) => t.post), [false, true]);
  const push = pastTurnsOf([cust(0), staff(2, "はい"), cust(10), staff(12, "はい")], [{ aix_type: "application_push", app_sub_mode: "push", created_at: at(5) }], RULES);
  eq(push.map((t) => t.post), [false, false]);
});

console.log("手本の合わせ");
it("返事のまとまりの文の送信の1秒後の手本を使う・まとまりの外・個人情報で伏せた手本・line_reply 以外は使わない", () => {
  const burst = [{ at: at(5) }];
  eq(exampleForBurst(burst, [ex("a", 5, "下書き")])?.id, "a");
  eq(exampleForBurst(burst, [ex("b", 40, "後の連絡の下書き")]), null);
  eq(exampleForBurst(burst, [ex("p", 5, "下書き", { pii_redacted_at: at(6) })]), null);
  eq(exampleForBurst(burst, [ex("x", 5, "下書き", { entry_source: "aix_action" })]), null);
  eq(exampleForBurst(burst, [ex("s", 5, "__SHOWN__")]), null);
});
it("実物 8/10 583171e6: 前の番の御見積書の約束が残ったままの下書きは古い（使わない）", () => {
  const exs = [ex("e1", 29, ESTIMATE), ex("e2", 1545, ESTIMATE)];
  eq(isStaleExampleDraft(exs[1], at(651), exs), true);
  eq(isStaleExampleDraft(exs[0], at(20), exs), false);
  const msgs = [cust(20, "こちら初期費用等詳細お願い致します。"), staff(29, ESTIMATE), cust(651, "エリアこのままで家賃10〜11で2LDKで探せますか？"),
    staff(1545, "かしこまりました！！\nJR野江まで電車20分圏内のエリア全域から家賃11万円以内で2LDKのお部屋探させていただきます😊！！")];
  const turns = pastTurnsOf(msgs, [], RULES);
  const plan = planBackfillTurn({ conversationId: "c1", turn: turns[1], msgs, presses: [], examples: exs, decisions: [], nowMs: NOW });
  eq("skip" in plan ? plan.skip : "planned", "no_draft_no_brain");
});

console.log("計画と判定（cron と同じ evalWatchTurn）");
const dec = (min: number, action: string | null, mode: string): BfDecision =>
  ({ id: `d${min}`, created_at: at(min), analyzed_msg_ts: at(0), intent: "question", suggested_action: action, suggested_reply_mode: mode, conversation_status: "proposing" });
it("手本の下書き＝送った文 → same・印の元は ai_reply_examples・場面は手本の customer_intent・evaluated_at と版が入る", () => {
  const msgs = [cust(0, "初期費用いくらかかりますか？"), staff(5, ESTIMATE)];
  const turn = pastTurnsOf(msgs, [], RULES)[0];
  const plan = planBackfillTurn({ conversationId: "c1", turn, msgs, presses: [], examples: [ex("e", 5, ESTIMATE, { customer_intent: "question" })], decisions: [], nowMs: NOW });
  if ("skip" in plan) throw new Error(plan.skip);
  const ev = evalWatchTurn(plan.input, { msgs, presses: [], decisions: [], nowMs: NOW, intentFallback: plan.intentFallback });
  eq([plan.source, plan.sceneSrc, ev.judgement.verdict, ev.scene.key, ev.patch.judge_version, ev.judgement.detail.final, typeof ev.patch.evaluated_at], ["ai_reply_examples", "example_intent", "same", "返信:意図:question", JUDGE_VERSION, true, "string"]);
});
it("ブレインが AIX・スタッフが同じ AIX を押した → 下書きが無くても same（ブレインの記録だけで決まる）", () => {
  const msgs = [cust(0, "お願いします！"), staff(30, "[画像]")];
  const presses = [{ aix_type: "estimate_sheet", created_at: at(6) }];
  const turn = pastTurnsOf(msgs, presses, RULES)[0];
  const plan = planBackfillTurn({ conversationId: "c1", turn, msgs, presses, examples: [], decisions: [dec(2, "estimate_sheet", "aix")], nowMs: NOW });
  if ("skip" in plan) throw new Error(plan.skip);
  const ev = evalWatchTurn(plan.input, { msgs, presses, decisions: [dec(2, "estimate_sheet", "aix")], nowMs: NOW });
  const g = guardBackfillJudgement(ev.judgement, { hasDraft: false, hasBrain: true });
  eq([plan.source, plan.input.brain_versions, ev.scene.key, g.verdict, g.bfNa], ["brain_decision_logs", 1, "AIX:estimate_sheet", "same", null]);
});
it("下書きの欄が空の手本: snapshot があり draftHead も空なら「下書きは無かった」・draftHead があれば分からない（画面が AIX の時に隠した）", () => {
  const msgs = [cust(0, "何時にどこに行ったらいいですか？"), staff(5, "明日16:00に現地エントランスお待ち合わせで何卒よろしくお願い致します😌！！")];
  const turn = pastTurnsOf(msgs, [], RULES)[0];
  const decs = [dec(2, "meeting_place", "aix")];
  const absent = planBackfillTurn({ conversationId: "c1", turn, msgs, presses: [], examples: [ex("n", 5, null, { has_snapshot: true, draft_head: null })], decisions: decs, nowMs: NOW });
  const hidden = planBackfillTurn({ conversationId: "c1", turn, msgs, presses: [], examples: [ex("h", 5, null, { has_snapshot: true, draft_head: "明日16:00に…" })], decisions: decs, nowMs: NOW });
  const noSnap = planBackfillTurn({ conversationId: "c1", turn, msgs, presses: [], examples: [ex("s", 5, null, { has_snapshot: false })], decisions: decs, nowMs: NOW });
  if ("skip" in absent || "skip" in hidden || "skip" in noSnap) throw new Error("skip");
  eq([absent.draftKnownAbsent, hidden.draftKnownAbsent, noSnap.draftKnownAbsent, absent.example], [true, false, false, null]);
  const ev = evalWatchTurn(absent.input, { msgs, presses: [], decisions: decs, nowMs: NOW });
  eq([ev.judgement.detail.reason, guardBackfillJudgement(ev.judgement, { hasDraft: absent.draftKnownAbsent, hasBrain: true }).verdict, guardBackfillJudgement(ev.judgement, { hasDraft: false, hasBrain: true }).verdict], ["aix_but_text", "different", "na"]);
});
it("スタッフの最初の行動の後のブレインの判断は寄せない", () => {
  const msgs = [cust(0), staff(5, "はい")];
  const turn = pastTurnsOf(msgs, [], RULES)[0];
  const plan = planBackfillTurn({ conversationId: "c1", turn, msgs, presses: [], examples: [], decisions: [dec(9, "estimate_sheet", "aix")], nowMs: NOW });
  eq("skip" in plan ? plan.skip : "planned", "no_draft_no_brain");
});

console.log("材料が無い所は na（guardBackfillJudgement）");
const J = (verdict: "same" | "different" | "partial", reason: string) => ({ verdict, detail: { v: JUDGE_VERSION, path: "AIX" as const, reason, final: true } });
it("下書きが無い: AIX の押下で決まる番だけ残す・AI は AIX でスタッフは手打ちは na（元は bf_raw）", () => {
  eq(guardBackfillJudgement(J("same", "aix_same"), { hasDraft: false, hasBrain: true }).verdict, "same");
  eq(guardBackfillJudgement(J("different", "aix_other"), { hasDraft: false, hasBrain: true }).verdict, "different");
  const g = guardBackfillJudgement(J("different", "aix_but_text"), { hasDraft: false, hasBrain: true });
  eq([g.verdict, g.bfNa, (g.detail as unknown as { bf_raw: unknown }).bf_raw], ["na", "no_draft", { verdict: "different", reason: "aix_but_text" }]);
});
it("ブレインが無い（9/05 より前）: スタッフが AIX を押した番は na・文の判定は残す", () => {
  eq(guardBackfillJudgement(J("different", "text_but_aix"), { hasDraft: true, hasBrain: false }).bfNa, "no_brain");
  eq(guardBackfillJudgement(J("partial", "acts_extra"), { hasDraft: true, hasBrain: false }).verdict, "partial");
});

console.log("集計");
const row = (iso: string, verdict: StatTurn["verdict"], scene: string, backfill?: string): StatTurn =>
  ({ conversation_id: "c", customer_turn_at: iso, scene_key: scene, verdict, verdict_detail: { v: "x", path: "返信", reason: "exact", final: true, ...(backfill ? { backfill } : {}) } as StatTurn["verdict_detail"] });
it("sceneStats（解禁・停止の線）は埋め戻しを数えない", () => {
  const now = Date.parse("2026-10-08T12:00:00Z");
  const s = sceneStats([row("2026-09-20T00:00:00Z", "different", "返信:質問", "ai_reply_examples"), row("2026-10-05T00:00:00Z", "same", "返信:質問")], now);
  eq([s[0].cur.n, s[0].cur.different, s[0].last14Different], [1, 0, 0]);
});
it("sceneStatsByMonth: 日本時間の月・na は数えない・全体と道の全体・group で分ける", () => {
  const rs = sceneStatsByMonth([
    row("2026-08-31T15:30:00Z", "same", "返信:質問", "ai_reply_examples"), // JST 9/1
    row("2026-09-02T00:00:00Z", "different", "返信:質問", "ai_reply_examples"),
    row("2026-09-02T00:00:00Z", "na", "返信:質問", "ai_reply_examples"),
    row("2026-10-02T00:00:00Z", "same", "AIX:estimate_sheet"),
    row("2026-10-02T00:00:00Z", "same", "対象外:申込以降"),
  ], { group: (t) => (isBackfillTurn(t) ? "埋め戻し" : "控え") });
  const get = (m: string, s: string) => rs.find((r) => r.month === m && r.scene === s);
  eq([get("2026-09", "返信:質問")?.win.n, get("2026-09", "返信:質問")?.win.rate, get("2026-09", "返信:質問")?.group], [2, 0.5, "埋め戻し"]);
  eq([get("2026-10", "AIX（全体）")?.win.n, get("2026-10", "（全体）")?.win.n, get("2026-10", "（全体）")?.group], [1, 1, "控え"]);
  eq(jstMonthOf("2026-08-31T15:30:00Z"), "2026-09");
});
it("自動返信の関所（watchAixMatchRates）は埋め戻しを数えない", () => {
  const r = watchAixMatchRates([{ brain_action: "estimate_sheet", aix_verdict: "other", backfill: "brain_decision_logs" }, { brain_action: "estimate_sheet", aix_verdict: "same", backfill: null }]);
  eq(r.estimate_sheet, { same: 1, n: 1, rate: 1 });
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
