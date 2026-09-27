// app/lib/brain-outcome.ts（判断の後の行動）と app/lib/automation-readiness.ts（自動化の度合いの表）の純関数
// 実行: npx tsx app/lib/__tests__/brain-outcome.test.ts（自己完結ハーネス。全 PASS で exit 0）
import {
  resolveBrainOutcomes, brainPredictionAt, immediateAixOutcome, immediateTextOutcome, matchReplyExample,
  type OutcomeDecision, type OutcomePress, type OutcomeStaffMessage, type OutcomeReplyExample,
} from "../brain-outcome";
import { judgeAix, judgeDrafts, aixCell, draftCell, nextCandidates, aixSentTextFor, jstWeek, READY_MIN_N } from "../automation-readiness";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function eq<T>(a: T, b: T, m = "") { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m} expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); }

const C = "conv-1";
const T = (hhmm: string, day = "2026-09-20") => `${day}T${hhmm}:00.000Z`;
const dec = (id: string, at: string, action: string | null): OutcomeDecision => ({ id, conversation_id: C, created_at: at, suggested_action: action });
const NOW = new Date("2026-09-25T00:00:00Z").getTime();

console.log("brain-outcome");

it("ブレインと同じ AIX → aix_followed／違う AIX → aix_different（旧は種類を見ずに aix_followed）", () => {
  const presses: OutcomePress[] = [{ conversation_id: C, aix_type: "property_check_result", created_at: T("10:05") }];
  const r1 = resolveBrainOutcomes({ decisions: [dec("a", T("10:00"), "property_check_result")], presses, staffMessages: [], replyExamples: [], nowMs: NOW });
  eq(r1[0].outcome, "aix_followed");
  const r2 = resolveBrainOutcomes({ decisions: [dec("a", T("10:00"), "estimate_sheet")], presses, staffMessages: [], replyExamples: [], nowMs: NOW });
  eq([r2[0].outcome, r2[0].pressedAix], ["aix_different", "property_check_result"]);
  // acknowledge_check は property_check_result と同じ
  const r3 = resolveBrainOutcomes({ decisions: [dec("a", T("10:00"), "acknowledge_check")], presses, staffMessages: [], replyExamples: [], nowMs: NOW });
  eq(r3[0].outcome, "aix_followed");
});

it("次の判断が先に来た（連投）→ superseded。行動は後の判断に付く（旧は前の判断が空のまま残った）", () => {
  const msgs: OutcomeStaffMessage[] = [{ conversation_id: C, created_at: T("10:20"), text: "かしこまりました！！", is_aix_generated: false }];
  const ex: OutcomeReplyExample[] = [{ conversation_id: C, sent_at: T("10:20"), sent_reply: "かしこまりました！！", ai_draft: "かしこまりました！！", entry_source: "line_reply" }];
  const r = resolveBrainOutcomes({ decisions: [dec("a", T("10:00"), null), dec("b", T("10:10"), null)], presses: [], staffMessages: msgs, replyExamples: ex, nowMs: NOW });
  eq(r.map((x) => x.outcome), ["superseded", "draft_followed"]);
});

it("下書きの手直し・書き直し・手打ち・記録なし", () => {
  const base = (draft: string | null, sent: string, withEx = true) => resolveBrainOutcomes({
    decisions: [dec("a", T("10:00"), null)], presses: [],
    staffMessages: [{ conversation_id: C, created_at: T("10:03"), text: sent, is_aix_generated: false }],
    replyExamples: withEx ? [{ conversation_id: C, sent_at: T("10:03"), sent_reply: sent, ai_draft: draft, entry_source: "line_reply" }] : [], nowMs: NOW,
  })[0].outcome;
  eq(base("はい😊！！\nお気をつけてお越しください！！", "かしこまりました！！\nお気をつけてお越しください😌！！"), "draft_modified");
  eq(base("はい😊！！\n9/19 12:00に現地にてお待ちしております！！", "はい😊！！　\n何卒よろしくお願い致します😌！！"), "draft_rewritten");
  eq(base(null, "大丈夫です！！"), "manual");
  eq(base(null, "大丈夫です！！", false), "reply_unknown");
});

it("AIX の文（is_aix_generated）は手打ちに数えない・24時間何もしない → no_action・窓が開いている → null", () => {
  const r = resolveBrainOutcomes({
    decisions: [dec("a", T("10:00"), "property_send")], presses: [],
    staffMessages: [{ conversation_id: C, created_at: T("10:05"), text: "ピックアップさせて頂きました！！", is_aix_generated: true }],
    replyExamples: [], nowMs: NOW,
  });
  eq(r[0].outcome, "no_action");
  const open = resolveBrainOutcomes({ decisions: [dec("a", T("10:00"), null)], presses: [], staffMessages: [], replyExamples: [], nowMs: new Date(T("12:00")).getTime() });
  eq(open[0].outcome, null);
});

it("画像だけの送信は manual", () => {
  const r = resolveBrainOutcomes({ decisions: [dec("a", T("10:00"), null)], presses: [], staffMessages: [{ conversation_id: C, created_at: T("10:02"), text: "[画像]" }], replyExamples: [], nowMs: NOW });
  eq(r[0].outcome, "manual");
});

it("押した時点のブレインの予想（48時間以内の一番新しい判断・AIX なしは none・無ければ null）", () => {
  const ds = [{ created_at: T("09:00"), suggested_action: "estimate_sheet" }, { created_at: T("10:00"), suggested_action: null }];
  eq(brainPredictionAt(ds, T("09:30")), "estimate_sheet");
  eq(brainPredictionAt(ds, T("10:30")), "none");
  eq(brainPredictionAt(ds, T("08:00")), null);
  eq(brainPredictionAt(ds, T("10:30", "2026-09-23")), null);
});

it("画面の仮の outcome（種類を比べる・控えが空なら書かない）", () => {
  eq(immediateAixOutcome("property_send", "property_send"), "aix_followed");
  eq(immediateAixOutcome("property_send", "property_recommendation"), "aix_different");
  eq(immediateAixOutcome(null, "estimate_sheet"), "aix_different");
  eq(immediateAixOutcome("estimate_sheet", null), null);
  eq(immediateTextOutcome({ draftIsAi: true, originalDraft: "", sentText: "はい" }), null);
  eq(immediateTextOutcome({ draftIsAi: true, originalDraft: "はい！！", sentText: "はい！！" }), "draft_followed");
  eq(immediateTextOutcome({ draftIsAi: true, originalDraft: "はい！！", sentText: "かしこまりました！！" }), "draft_modified");
  eq(immediateTextOutcome({ draftIsAi: false, originalDraft: "はい！！", sentText: "はい！！" }), "manual");
});

it("下書きの記録を結ぶ（分割送信でまとめた記録は含む／含まれるで結ぶ・5分を超えたら結ばない）", () => {
  const m: OutcomeStaffMessage = { conversation_id: C, created_at: T("10:03"), text: "お気をつけてお越しください！！" };
  eq(!!matchReplyExample(m, [{ conversation_id: C, sent_at: T("10:04"), sent_reply: "かしこまりました！！\nお気をつけてお越しください！！", ai_draft: "x" }]), true);
  eq(!!matchReplyExample(m, [{ conversation_id: C, sent_at: T("10:09"), sent_reply: "お気をつけてお越しください！！", ai_draft: "x" }]), false);
});

console.log("automation-readiness");

it("実物: 見積書送るの記録はカバーレターが別の送信とつながる → 送った文は messages の AIX の文から取り、生成文と似た文が無ければ生成文を使わず", () => {
  const draft = "かぁなさん\n\nかしこまりました！！\nポーラーベアー302号室の募集状況確認と最大限割引しました初期費用御見積書をご用意させて頂きます！！\nピックアップ出来次第お送りさせていただきます😊！！";
  const msgs = [
    { conversation_id: C, created_at: "2026-09-18T12:27:05Z", text: "[画像]", is_aix_generated: true },
    { conversation_id: C, created_at: "2026-09-18T12:27:05Z", text: "【ポーラーベアー 302号室】\n\n初期費用さらに\n🌟38,000円割引させて頂き\n初期費用：296,980円", is_aix_generated: true },
    { conversation_id: C, created_at: "2026-09-18T12:29:27Z", text: "かぁなさん\nポーラーベアー302号室最大限割引しました初期費用の御見積書となります！！", is_aix_generated: false },
  ];
  const js = judgeAix(
    [{ id: "x", conversation_id: C, created_at: "2026-09-18T12:27:07Z", aix_type: "estimate_sheet", was_edited: true }],
    [{ conversation_id: C, sent_at: "2026-09-18T12:27:06Z", entry_source: "aix_action", ai_draft: draft, sent_reply: draft + "\n別の送信" }],
    [], "2099-01-01T00:00:00Z", msgs);
  eq(js[0].edit?.kinds, ["dropped"]);
  eq(js[0].untouched, false);
});

it("AIX の文をつないだ物が生成文と同じ → そのまま", () => {
  const msgs = [
    { conversation_id: C, created_at: T("10:00"), text: "1通目", is_aix_generated: true },
    { conversation_id: C, created_at: T("10:00"), text: "2通目", is_aix_generated: true },
  ];
  eq(aixSentTextFor("1通目\n2通目", T("10:01"), msgs), "1通目\n2通目");
});

it("続けて押した2つ目の AIX（30分以内）は予想の一致に数えない・過去の行は判断から推定", () => {
  const rows = [
    { id: "1", conversation_id: C, created_at: T("10:00"), aix_type: "property_send", was_edited: false },
    { id: "2", conversation_id: C, created_at: T("10:10"), aix_type: "property_recommendation", was_edited: false },
  ];
  const js = judgeAix(rows, [], [{ id: "d", conversation_id: C, created_at: T("09:50"), suggested_action: "property_send" }], "2099-01-01T00:00:00Z");
  eq(js.map((j) => [j.matched, j.chained, j.predictedEstimated]), [[true, false, true], [null, true, true]]);
  const c = aixCell("property_send", js.slice(0, 1));
  eq([c.matchRate, c.untouchedRate], [1, 1]);
});

it("記録を始めた後の行は suggested_action を記録として使う", () => {
  const js = judgeAix([{ id: "1", conversation_id: C, created_at: T("10:00", "2026-09-29"), aix_type: "estimate_sheet", suggested_action: "none" }], [], [], "2026-09-28T00:00:00+09:00");
  eq([js[0].predicted, js[0].matched, js[0].predictedEstimated], ["none", false, false]);
});

it("下書き: 手打ちは下書きの率の分母に入れず、直す候補の件数には入れる・10件未満は届いたにしない", () => {
  const ex = (draft: string | null, sent: string) => ({ conversation_id: C, sent_at: T("10:00"), entry_source: "line_reply", conversation_state: "proposing", ai_draft: draft, sent_reply: sent });
  const js = judgeDrafts([ex("はい！！", "はい！！"), ex("はい！！", "かしこまりました！！"), ex(null, "手打ち")]);
  const c = draftCell("proposing", js);
  eq([c.untouchedRate, c.manualRate != null && Math.round(c.manualRate * 100), c.fixCount, c.reached], [0.5, 33, 2, false]);
  const big = judgeDrafts(Array.from({ length: READY_MIN_N }, () => ex("はい！！", "はい！！")));
  eq(draftCell("x", big).reached, true);
  const cand = nextCandidates([{ ...c, area: "下書き" }, { ...draftCell("x", big), area: "下書き" }]);
  eq(cand.map((x) => x.label), ["proposing"]);
});

it("JST の週（月曜始まり）", () => {
  eq(jstWeek("2026-09-27T14:59:00Z"), "2026-09-21"); // 9/27(日) 23:59 JST
  eq(jstWeek("2026-09-27T15:00:00Z"), "2026-09-28"); // 9/28(月) 0:00 JST
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { for (const f of failures) console.log(" - " + f); process.exit(1); }
