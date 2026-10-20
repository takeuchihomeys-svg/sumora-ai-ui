// app/lib/__tests__/line-watch-scope.test.ts
// 実行: npx tsx app/lib/__tests__/line-watch-scope.test.ts（自己完結ハーネス。全 PASS で exit 0・LLM なし・DB なし）
import {
  postApplyAtTurn, findDuplicateTurns, mergeCapture, watchTurnExclusion, findCaptureStalls, businessSpans, captureStallLine,
  watchPostApplyScopeEnabled, watchStallAlertEnabled, watchStallCheckEnabled,
} from "../line-watch-scope";
import { sceneKeyOf } from "../line-watch-turn";
import { evalWatchTurn, type WatchTurnInput } from "../line-watch-turn-eval";
import { sceneStats, type StatTurn } from "../line-watch-daily";
import { watchAixMatchRates } from "../watch-aix-match";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function eq<T>(actual: T, exp: T) { if (JSON.stringify(actual) !== JSON.stringify(exp)) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); }

console.log("① 番の時点の申込以降（下書きの関所と同じ resolvePostApply）");
const tl = { applicationPushes: ["2026-10-10T03:00:00Z"], idDocuments: ["2026-10-12T05:00:00Z"], statusManualBackAt: null, deepseekCutoffAt: null };
it("申込へ押下の後の番 → 申込以降（status は提案中のまま）", () => eq(postApplyAtTurn("proposing", tl, "2026-10-11T00:00:00Z"), { postApply: true, reason: "application_push" }));
it("押下より前の番 → 申込前（後の押下・書類は見ない）", () => eq(postApplyAtTurn("proposing", tl, "2026-10-09T00:00:00Z").postApply, false));
it("書類が届いた後 → 理由は id_document", () => eq(postApplyAtTurn("proposing", tl, "2026-10-13T00:00:00Z").reason, "id_document"));
it("押下の後に戻した（否決→提案中）の後の番 → 申込前", () => eq(postApplyAtTurn("proposing", { ...tl, idDocuments: [], deepseekCutoffAt: "2026-10-11T00:00:00Z" }, "2026-10-12T00:00:00Z").postApply, false));
it("戻した時刻が番より後なら見ない（その番の時点ではまだ申込以降）", () => eq(postApplyAtTurn("proposing", { ...tl, idDocuments: [], deepseekCutoffAt: "2026-10-15T00:00:00Z" }, "2026-10-12T00:00:00Z").postApply, true));
it("status が申込以降なら記録なしでも申込以降", () => eq(postApplyAtTurn("screening", { applicationPushes: [], idDocuments: [] }, "2026-10-12T00:00:00Z"), { postApply: true, reason: "status" }));
it("記録が無い（読めない）時は status だけ", () => eq(postApplyAtTurn("proposing", null, "2026-10-12T00:00:00Z").postApply, false));
it("sceneKeyOf: postApply=true は対象外・未指定は今まで通り", () => {
  eq(sceneKeyOf({ convStatus: "proposing", tpoLabel: null, postApply: true }).key, "対象外:申込以降");
  eq(sceneKeyOf({ convStatus: "proposing", tpoLabel: null }).path, "返信");
});
it("スイッチ: 既定 on・off で止まる／止まり の LINE は既定 off・記録は既定 on", () => {
  eq([watchPostApplyScopeEnabled({}), watchPostApplyScopeEnabled({ LINE_WATCH_POSTAPPLY_SCOPE: "off" })], [true, false]);
  eq([watchStallAlertEnabled({}), watchStallAlertEnabled({ LINE_WATCH_STALL_ALERT: "on" }), watchStallAlertEnabled({ LINE_WATCH_STALL_ALERT: "off" })], [true, true, false]);
  eq([watchStallCheckEnabled({}), watchStallCheckEnabled({ LINE_WATCH_STALL_CHECK: "off" })], [true, false]);
});

console.log("evalWatchTurn に記録を渡す（毎晩の cron の形）");
const turnIn: WatchTurnInput = {
  conversation_id: "c1", customer_turn_at: "2026-10-11T01:00:00Z", conv_status: "proposing",
  draft_last: null, draft_last_at: null, draft_first: null, draft_first_at: null, draft_versions: 0, draft_sentinel: null,
  brain_action: null, brain_reply_mode: "reply", brain_versions: 1, tpo_label: null,
};
const msgs = [
  { sender: "customer", created_at: "2026-10-11T01:00:00Z", text: "書類送りました" },
  { sender: "staff", created_at: "2026-10-11T01:10:00Z", text: "ありがとうございます！確認いたします" },
];
it("押下の後の番は対象外（out_of_scope・根拠つき）＝「下書きなし」に数えない", () => {
  const ev = evalWatchTurn(turnIn, { msgs, presses: [], decisions: [], nowMs: Date.parse("2026-10-13T00:00:00Z"), postApplyTimeline: tl });
  eq([ev.scene.key, ev.judgement.verdict, ev.judgement.detail.reason, ev.judgement.detail.post_apply_reason], ["対象外:申込以降", "na", "out_of_scope", "application_push"]);
});
it("記録を渡さない（埋め戻し・画面）時は今まで通り返信の no_draft", () => {
  const ev = evalWatchTurn(turnIn, { msgs, presses: [], decisions: [], nowMs: Date.parse("2026-10-13T00:00:00Z") });
  eq([ev.scene.path, ev.judgement.detail.reason], ["返信", "no_draft"]);
});

console.log("④ 番の鍵が消えた重複行");
// 実物の形（10/20 96c140e4）: 06:07:27.5 の行の鍵の発言が無く、06:07:29.3 に鍵のある行がある
const rows = [
  { id: 6628, conversation_id: "c", customer_turn_at: "2026-10-20T06:07:27.529Z", customer_last_at: "2026-10-20T06:07:35.052Z" },
  { id: 6635, conversation_id: "c", customer_turn_at: "2026-10-20T06:07:29.277Z", customer_last_at: "2026-10-20T06:08:45.523Z" },
  { id: 6662, conversation_id: "c", customer_turn_at: "2026-10-20T07:41:21.559Z", customer_last_at: null },
  { id: 4420, conversation_id: "d", customer_turn_at: "2026-10-12T01:35:29.487Z", customer_last_at: null },
];
const cust = new Map([
  ["c", ["2026-10-20T06:07:29.277Z", "2026-10-20T06:08:45.523Z", "2026-10-20T07:41:21.559Z"]],
  ["d", ["2026-10-12T01:42:41.763Z"]],
]);
it("鍵の無い行 → 近くの鍵のある行に寄せる・近くに無い（取り消し等）は重複にしない", () => eq([...findDuplicateTurns(rows, cust)], [[6628, 6635]]));
it("会話の発言が読めない時は決めない", () => eq(findDuplicateTurns(rows, new Map()).size, 0));
it("mergeCapture: 本物の行の空の欄だけを埋める（下書きはまとめて）", () => {
  const r = mergeCapture({ draft_last: null, draft_versions: 0, brain_action: "x", brain_reply_mode: "aix" } as Record<string, unknown>, { draft_last: "案", draft_versions: 1, draft_last_at: "t", brain_action: "y" });
  eq([r.merged.draft_last, r.merged.draft_versions, r.merged.brain_action, r.filled], ["案", 1, "x", ["draft_last", "draft_last_at", "draft_versions"]]);
});

console.log("③ 一致率の分母から外す番");
it("埋め戻し・申込以降・重複・古い下書き（返信の道だけ）", () => {
  eq([
    watchTurnExclusion({ verdict_detail: { backfill: "ai_reply_examples", path: "返信" } }),
    watchTurnExclusion({ scene_key: "対象外:申込以降", verdict_detail: {} }),
    watchTurnExclusion({ verdict_detail: { duplicate_of: 1, path: "返信" } }),
    watchTurnExclusion({ verdict_detail: { draft_src: "stale", path: "返信" } }),
    watchTurnExclusion({ verdict_detail: { draft_src: "stale", path: "AIX" } }),
    watchTurnExclusion({ verdict_detail: { draft_src: "last", path: "返信" } }),
  ], ["backfill", "out_of_scope", "duplicate_turn", "stale_draft", null, null]);
});
it("sceneStats: 古い下書きの番は n に入れず staleDraft に・重複行は数えない", () => {
  const now = Date.parse("2026-10-20T11:50:00Z");
  const t = (verdict: StatTurn["verdict"], d: Record<string, unknown>): StatTurn => ({ conversation_id: "c", customer_turn_at: "2026-10-19T03:00:00Z", scene_key: "返信:条件提示", verdict, verdict_detail: { v: "x", path: "返信", reason: "r", final: true, ...d } });
  const s = sceneStats([t("same", { draft_src: "last" }), t("different", { draft_src: "stale" }), t("different", { duplicate_of: 9 })], now)[0];
  eq([s.cur.n, s.cur.agree, s.cur.staleDraft], [1, 1, 1]);
});

console.log("② 控えの止まり");
const D = (h: number, m = 0) => new Date(Date.parse("2026-10-13T00:00:00+09:00") + h * 3600_000 + m * 60_000).toISOString();
it("営業時間は JST 10〜20 で毎日切る", () => {
  const sp = businessSpans(Date.parse(D(9)), Date.parse(D(24 + 11)));
  eq(sp.map(([a, b]) => [new Date(a).toISOString(), new Date(b).toISOString()]), [[D(10), D(20)], [D(34), D(35)]]);
});
it("判断はあるのに控えが2時間以上0件 → 止まり（10/13 の形）", () => {
  const decs = [11, 12, 13, 14, 15, 16].flatMap((h) => [D(h), D(h, 30)]);
  const st = findCaptureStalls({ captures: [D(10, 30), D(17)], decisions: [...decs, D(18)], fromMs: Date.parse(D(10)), toMs: Date.parse(D(20)) });
  eq(st.map((x) => [x.from, x.to, x.decisions]), [[D(10, 30), D(17), 12]]);
});
it("判断が少ない（静かな時間）・2時間未満は出さない／夜はまたがない", () => {
  eq(findCaptureStalls({ captures: [D(10), D(19)], decisions: [D(11), D(12), D(13), D(14), D(15), D(16)], fromMs: Date.parse(D(10)), toMs: Date.parse(D(20)) }).length, 0);
  eq(findCaptureStalls({ captures: [D(10), D(11, 50), D(13, 40)], decisions: [D(11), D(12), D(13)], fromMs: Date.parse(D(10)), toMs: Date.parse(D(14)) }).length, 0);
  eq(findCaptureStalls({ captures: [D(19, 30), D(24 + 10, 30)], decisions: [D(21), D(22), D(23), D(24 + 2)], fromMs: Date.parse(D(19)), toMs: Date.parse(D(24 + 11)) }).length, 0);
});
it("人が読む1行（止まりが無ければ空）", () => {
  eq(captureStallLine([]), "");
  const l = captureStallLine([{ from: D(10, 30), to: D(17), minutes: 390, decisions: 4 }]);
  if (!l.includes("10/13 10:30〜17:00") || !l.includes("判断4件")) throw new Error(l);
});

console.log("自動返信化の関所は今までの数え方（guard_aix_verdict を先に読む）");
it("guard があればそれで数える・none は数えない・無ければ aix_verdict", () => {
  const r = watchAixMatchRates([
    { brain_action: "application_push", aix_verdict: null, guard_aix_verdict: "not_pressed" }, // ①で対象外になった番 → 今まで通り分母に入る
    { brain_action: "application_push", aix_verdict: "same", guard_aix_verdict: "none" },       // ④で新しく数えられる番 → 今まで通り数えない
    { brain_action: "application_push", aix_verdict: "same" },
  ]);
  eq(r.application_push, { same: 1, n: 2, rate: 0.5 });
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log(failures.join("\n")); process.exit(1); }
