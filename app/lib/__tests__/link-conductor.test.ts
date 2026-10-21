// つなぎのブレイン 段3 司令塔（link-conductor.ts）。LLM なし・DB なし。文は型だけ（名前・物件名は作り物）
// 実行: npx tsx app/lib/__tests__/link-conductor.test.ts
import { buildCustomerHub, hubContradictions, type HubInput, type HubAixItem, type HubCalendarEvent } from "../customer-hub";
import {
  conductCustomer, renderConductorBrainNote, conductorNoteAix, flashLabelOf, conductorTodoOrder, countDecisions, isStaffOnlyAction, tieBreakPrompt, parseTieBreak,
  linkConductorEnabled, linkConductorBrainEnabled, linkConductorTodoEnabled, linkConductorExamEnabled, RECOMMENDED, HESITATE_GAP,
  type ConductorDecision,
} from "../link-conductor";
import { linkBreakToWatchRow, LINK_EXAM_BREAKS } from "../../../scripts/lib/exam-question-candidates";
import { autoAnswerOf } from "../../../scripts/lib/brain-exam-watch";

let passed = 0, failed = 0;
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function eq<T>(a: T, b: T, label = "") { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${label} expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); }
function ok(v: unknown, label = "") { if (!v) throw new Error(`${label} expected truthy`); }

const H = 3600_000;
const T0 = Date.parse("2026-10-10T01:00:00.000Z");
const iso = (h: number) => new Date(T0 + h * H).toISOString();
const NOW = T0 + 5 * H;
const CID = "abcdef12-0000-0000-0000-000000000000";
type Msg = { sender: string; text: string; h: number };
const input = (msgs: Msg[], over: Partial<HubInput> = {}, status = "proposing", nowMs = NOW): HubInput => ({
  nowMs,
  conv: { id: CID, customer_name: "山田 花子", account: null, status, is_post_apply: false, status_manual_back_at: null },
  state: { now: nowMs, status, messages: msgs.map((m) => ({ sender: m.sender, text: m.text, createdAt: iso(m.h) })), aixRows: [], recordedFacts: [], viewingHistory: [], sentProperties: [], lineTasks: [] },
  aixItems: [], pickups: [], calendarEvents: [], memoItems: [], reactions: null, reapply: null, ...over,
});
const decide = (inp: HubInput, o: Parameters<typeof conductCustomer>[3] = {}) => { const hub = buildCustomerHub(inp); return conductCustomer(hub, hubContradictions(hub, inp), inp, o); };
const PARKING_PROMISE = "かしこまりました！！\n駐車場について管理会社に確認させて頂きます😊！！";
const PICKUP_PROMISE = "かしこまりました！！\nご条件に合うお部屋ピックアップ出来次第お送りさせて頂きます😌！！";

console.log("切替（全部 既定 off）");
it("4つの切替は既定 off・on で入る", () => {
  for (const f of [linkConductorBrainEnabled, linkConductorTodoEnabled]) eq(f({}), false);
  for (const f of [linkConductorEnabled, linkConductorExamEnabled]) eq(f({}), true); // 2026-10-21 数えるだけ・候補だけは既定 on
  eq(linkConductorExamEnabled({ LINK_CONDUCTOR_EXAM: "off" }), false);
  eq(linkConductorEnabled({ LINK_CONDUCTOR: "on" }), true); eq(linkConductorBrainEnabled({ LINK_CONDUCTOR_BRAIN: "ON" }), true);
  eq(linkConductorTodoEnabled({ LINK_CONDUCTOR_TODO: "on" }), true); eq(linkConductorExamEnabled({ LINK_CONDUCTOR_EXAM: "on" }), true);
  eq(linkConductorEnabled({ LINK_CONDUCTOR: "off" }), false);
});
it("当てたオススメは5つ書いてある", () => eq(Object.keys(RECOMMENDED).length, 5));

console.log("次の一手");
it("お客様の番（未返信）→ 送る（ブレインの返信）・自信は高い", () => {
  const d = decide(input([{ sender: "staff", text: "お問い合わせありがとうございます！！", h: 0 }, { sender: "customer", text: "内覧はいつできますか？", h: 1 }]));
  eq(d.kind, "send"); eq(d.by, "brain"); eq(d.action, null); ok(d.confidence >= 0.7, `conf ${d.confidence}`);
});
it("駐車場の確認の約束（こちらが最後）→ スタッフに確かめる AIX（mgmt_parking）・スタッフしか分からない事", () => {
  const d = decide(input([{ sender: "customer", text: "駐車場ありますか？", h: 0 }, { sender: "staff", text: PARKING_PROMISE, h: 0.1 }]));
  eq(d.kind, "ask_staff"); eq(d.action, "property_check_result"); eq(d.checkPattern, "mgmt_parking"); eq(d.staffOnly, true);
  ok(/AIX で送る/.test(d.why), d.why);
});
it("約束と同じ要対応（pending）は1つにまとまる", () => {
  const item: HubAixItem = { id: "x", conversation_id: CID, customer_name: null, action: "property_check_result", check_pattern: "mgmt_parking", status: "pending", created_at: iso(0.2), done_at: null, done_aix_type: null, resolution_note: null };
  const d = decide(input([{ sender: "customer", text: "駐車場ありますか？", h: 0 }, { sender: "staff", text: PARKING_PROMISE, h: 0.1 }], { aixItems: [item] }));
  eq(d.kind, "ask_staff");
  eq(d.alternatives.filter((a) => a.action === "property_check_result" && a.checkPattern === "mgmt_parking").length, 0, "重なり");
});
it("お客様の番＋開いた確認の約束 → 1位は返信・ブレインの材料は下書きに書かない旨だけ（残る一手は出さない）", () => {
  const d = decide(input([{ sender: "customer", text: "駐車場ありますか？", h: 0 }, { sender: "staff", text: PARKING_PROMISE, h: 0.1 }, { sender: "customer", text: "あと初期費用はどれくらいですか？", h: 1 }]));
  eq(d.kind, "send"); eq(d.by, "brain");
  const note = renderConductorBrainNote(d, "山田 花子");
  ok(!/返信の後に残る一手/.test(note), "約束由来・スタッフしか分からない残る一手は一手として出さない（不要な AIX に寄せない）");
  ok(/下書きに答えを書かない/.test(note), note);
  ok(!/山田/.test(note), "名前を伏せる");
});
it("お客様の番だけ（開いた物なし）→ ブレインの材料は空（今のブレインと同じ）", () => {
  const d = decide(input([{ sender: "customer", text: "こんにちは", h: 1 }]));
  eq(renderConductorBrainNote(d), "");
});
it("ピックアップの約束・物件が揃った → 送る（物件の AIX）", () => {
  const d = decide(input([{ sender: "staff", text: PICKUP_PROMISE, h: 0 }], { pickups: [{ created_at: iso(2), sent_at: null, status: "pending", verdict: "pass" }] }));
  eq(d.kind, "send"); eq(d.by, "aix"); eq(d.action, "property_send"); eq(d.staffOnly, false);
});
it("ピックアップの約束・物件がまだ → 待つ", () => {
  const d = decide(input([{ sender: "staff", text: PICKUP_PROMISE, h: 0 }]));
  eq(d.kind, "wait");
});
it("申込以降・見送り → 待つ（つなぎの対象外）", () => {
  const inp = input([{ sender: "customer", text: "よろしくお願いします", h: 1 }]);
  inp.conv.is_post_apply = true;
  eq(decide(inp).kind, "wait");
});
it("今日の内覧 → やることリスト", () => {
  const inp = input([{ sender: "staff", text: "当日よろしくお願い致します！！", h: 0 }], {}, "viewing_scheduled");
  inp.state.viewingHistory = [{ scheduled_date: new Date(NOW + 9 * H).toISOString().slice(0, 10), scheduled_time: "18:00", status: "scheduled", property_name: "テスト荘" } as never];
  const d = decide(inp);
  ok(d.kind === "todo" || d.alternatives.some((a) => a.reader === "schedule"), JSON.stringify(d));
});

console.log("食い違いの決まり（オススメ1〜4）");
it("決定2: 要対応が開いたまま約束は果たした → 片付け close_item（書き込みはしない）", () => {
  const item: HubAixItem = { id: "x", conversation_id: CID, customer_name: null, action: "property_check_result", check_pattern: "mgmt_parking", status: "pending", created_at: iso(0.2), done_at: null, done_aix_type: null, resolution_note: null };
  const inp = input([{ sender: "customer", text: "駐車場ありますか？", h: 0 }, { sender: "staff", text: PARKING_PROMISE, h: 0.1 }, { sender: "staff", text: "駐車場は空きがございます！！", h: 2 }], { aixItems: [item] });
  inp.state.aixRows = [{ aix_type: "property_check_result", check_pattern: "mgmt_parking", sent_at: iso(2), created_at: iso(2), generated_text: "駐車場は空きがございます" } as never];
  const d = decide(inp);
  ok(d.housekeeping.some((h) => h.type === "close_item" && h.decision === 2), JSON.stringify(d.housekeeping));
  ok(d.appliedRecommendations.includes(2));
});
it("決定3: 内覧が決まった → ピックアップは保留（物件の AIX を出さない）", () => {
  const inp = input([{ sender: "staff", text: PICKUP_PROMISE, h: 0 }], { pickups: [{ created_at: iso(2), sent_at: null, status: "pending", verdict: "pass" }] });
  inp.state.viewingHistory = [{ scheduled_date: "2026-10-12", scheduled_time: "11:00", status: "scheduled", property_name: "テスト荘" } as never];
  const hub = buildCustomerHub(inp);
  const cs = hubContradictions(hub, inp);
  ok(cs.some((c) => c.type === "pickup_promise_vs_viewing"), "食い違い");
  const d = conductCustomer(hub, cs, inp);
  ok(d.housekeeping.some((h) => h.type === "pause_pickup"));
  ok(d.action !== "property_send" && !d.alternatives.some((a) => a.action === "property_send"), JSON.stringify(d));
  ok(/保留/.test(renderConductorBrainNote(d)));
});
it("決定1: status と段階が違う → 状態を確かめる（低い点・自動で直さない）", () => {
  const d = conductCustomer(buildCustomerHub(input([{ sender: "staff", text: "ありがとうございます！！", h: 0 }])), [{ type: "status_vs_stage", detail: "status=applying 段階=proposing" }], input([{ sender: "staff", text: "ありがとうございます！！", h: 0 }]));
  ok(d.housekeeping.some((h) => h.type === "fix_status" && h.decision === 1));
  ok(d.kind === "ask_staff" || d.alternatives.some((a) => a.label.includes("状態")));
});
it("決定4: カレンダーと記録の内覧が違う → 記録の直し（todo）", () => {
  const inp = input([{ sender: "staff", text: "ありがとうございます！！", h: 0 }]);
  const d = conductCustomer(buildCustomerHub(inp), [{ type: "calendar_viewing_vs_state", detail: "カレンダー 2026-10-12・状態 内覧なし" }], inp);
  ok(d.housekeeping.some((h) => h.type === "fix_viewing_record" && h.decision === 4));
  eq(d.kind, "todo");
});

it("お礼・了承だけのお客様の番 → 待つ", () => {
  const d = decide(input([{ sender: "staff", text: "お部屋お送りしました！！", h: 0 }, { sender: "customer", text: "ありがとうございます！", h: 1 }]));
  eq(d.kind, "wait");
});
it("期限を3日以上過ぎた要対応 → 送るでなく「まだ要るか確かめる」（やることリスト）", () => {
  const item: HubAixItem = { id: "x", conversation_id: CID, customer_name: null, action: "estimate_sheet", check_pattern: null, status: "pending", created_at: iso(0), done_at: null, done_aix_type: null, resolution_note: null };
  const d = decide(input([{ sender: "staff", text: "お作り致します！！", h: 0 }], { aixItems: [item] }, "proposing", T0 + 120 * H));
  eq(d.kind, "todo"); ok(/まだ要るか/.test(d.label), d.label);
});

console.log("迷い（オススメ5）と flash");
it("点が近く種類が違う → 迷い・flash が選べる（札と段階だけを渡す）", () => {
  const ev: HubCalendarEvent = { id: 1, conversation_id: CID, customer_name: null, event_type: "property_send", start_at: iso(-30), created_at: iso(-40), notes: "【必ず】【連絡日 2026-10-12】再開のご連絡", is_done: false };
  const inp = input([{ sender: "customer", text: "駐車場ありますか？", h: 0 }, { sender: "staff", text: PARKING_PROMISE, h: 0.1 }], { calendarEvents: [ev] }, "proposing", T0 + 74 * H);
  let seen: string | null = null;
  const d = decide(inp, { tieBreaker: (q) => { seen = JSON.stringify(q); return q.candidates.length - 1; } });
  eq(d.hesitant, true); ok(seen, "flash を呼んだ"); ok(!/山田/.test(seen!), "名前を渡さない"); eq(d.reader, "flash");
});
it("審査の事情がある会話は flash に聞かない", () => {
  const inp = input([{ sender: "customer", text: "実は自己破産したことがあるのですが審査通りますか", h: 0 }, { sender: "staff", text: PARKING_PROMISE, h: 0.1 }]);
  let called = false;
  const d = decide(inp, { tieBreaker: () => { called = true; return 0; } });
  eq(called, false); eq(d.claudeOnly, true);
});
it("2番手で申込中（並行で探す）の会話は申込以降で止めない・flash に聞かない（Claude だけ）", () => {
  const m = [{ sender: "staff", text: PARKING_PROMISE, h: 0 }, { sender: "customer", text: "ほかのお部屋も見たいです", h: 1 }];
  const par = decide(input(m, { parallelSecond: true }, "applying"), { tieBreaker: () => 0 });
  ok(par.reader !== "closed", JSON.stringify(par)); eq(par.claudeOnly, true); ok(par.reader !== "flash", "flash に聞いた");
  const notPar = decide(input(m, { parallelSecond: false }, "applying"));
  eq(notPar.reader, "closed");
  // 読めない時は今まで通り止める（Claude だけ）
  const unk = decide(input(m, { parallelSecond: null }, "applying"));
  eq(unk.reader, "closed"); eq(unk.claudeOnly, true);
});
it("迷いの線は点の差 < HESITATE_GAP", () => ok(HESITATE_GAP > 0));
it("flash の返事の読み: 範囲外・壊れは null", () => {
  eq(parseTieBreak('{"i": 1, "why": "x"}', 3), 1); eq(parseTieBreak('{"i": 5}', 3), null); eq(parseTieBreak("わからない", 3), null);
  const p = tieBreakPrompt({ stageLabel: "提案中", candidates: [{ i: 0, kind: "send", label: "約束 090-1234-5678", score: 10 }] });
  ok(!/1234/.test(p.user), "長い数字を伏せる");
});

console.log("配る先");
it("スタッフしか分からない AIX の見分け", () => {
  eq(isStaffOnlyAction("property_check_result"), true); eq(isStaffOnlyAction("estimate_sheet"), true);
  eq(isStaffOnlyAction("property_send"), false); eq(isStaffOnlyAction("viewing_invite", "mgmt_pet"), true); eq(isStaffOnlyAction(null), false);
});
it("やることリストの順: 同じ組で点が近い時だけ司令塔の急ぎで入れ替える（足し引きしない）", () => {
  const dec = (kind: ConductorDecision["kind"], c = 0.8) => ({ kind, confidence: c } as ConductorDecision);
  const m = new Map([["a", dec("wait")], ["b", dec("ask_staff")], ["c", dec("send")]]);
  const ord = conductorTodoOrder(m)([{ conversationId: "a", group: 3, score: 50 }, { conversationId: "b", group: 3, score: 48 }, { conversationId: "c", group: 4, score: 49 }]);
  eq(ord.map((x) => x.conversationId), ["b", "a", "c"]);
  const far = conductorTodoOrder(m)([{ conversationId: "a", group: 3, score: 80 }, { conversationId: "b", group: 3, score: 48 }]);
  eq(far.map((x) => x.conversationId), ["a", "b"]);
});
it("数え: 種類・迷い・片付け", () => {
  const c = countDecisions([decide(input([{ sender: "customer", text: "こんにちは", h: 1 }])), decide(input([{ sender: "customer", text: "駐車場ありますか？", h: 0 }, { sender: "staff", text: PARKING_PROMISE, h: 0.1 }]))]);
  eq(c.conversations, 2); eq(c.byKind.send, 1); eq(c.byKind.ask_staff, 1); eq(c.staffOnly, 1);
});

it("お客様の番＋開いた要対応（内覧の誘い）→ 返信の後に残る一手として出す", () => {
  const item: HubAixItem = { id: "v", conversation_id: CID, customer_name: null, action: "viewing_invite", check_pattern: null, status: "pending", created_at: iso(0.5), done_at: null, done_aix_type: null, resolution_note: null };
  const d = decide(input([{ sender: "staff", text: "こんにちは", h: 0 }, { sender: "customer", text: "ありがとうございます、見てみます", h: 1 }, { sender: "customer", text: "週末は空いてますか？", h: 1.1 }], { aixItems: [item] }));
  eq(d.kind, "send"); eq(d.by, "brain");
  const n = conductorNoteAix(d); ok(n && !n.protectOnly && n.action === "viewing_invite", JSON.stringify(n));
  ok(/返信の後に残る一手は AIX【viewing_invite】/.test(renderConductorBrainNote(d)));
});
it("お客様の番＋開いた要対応（物件送付）→ 残る一手に出さない（物件が揃った時は1位で出る）", () => {
  const item: HubAixItem = { id: "p", conversation_id: CID, customer_name: null, action: "property_send", check_pattern: null, status: "pending", created_at: iso(0.5), done_at: null, done_aix_type: null, resolution_note: null };
  const d = decide(input([{ sender: "staff", text: "こんにちは", h: 0 }, { sender: "customer", text: "週末は空いてますか？", h: 1 }], { aixItems: [item] }));
  eq(d.kind, "send"); eq(conductorNoteAix(d), null); eq(renderConductorBrainNote(d), "");
});
it("flash の札: 約束の札は自由な文（カレンダーの題・物件名）を渡さない", () => {
  const l = flashLabelOf({ kind: "send", by: "aix", action: "property_send", checkPattern: null, label: "約束: 【必ず】山田様 サンハイツ101 送付", score: 80, certainty: 0.8, reader: "promise", why: "x", dueAt: iso(-1) }, NOW);
  ok(!/山田|サンハイツ/.test(l), l); ok(/期限過ぎ/.test(l), l);
});

console.log("試験の連携（8c3bf572）");
it("ブレインの番の切れだけ問題になる・正解はスタッフの押した AIX", () => {
  eq(linkBreakToWatchRow("unsent_not_queued", { brain_action: null }), null);
  ok(Object.keys(LINK_EXAM_BREAKS).includes("check_result_brain_other"));
  const row = linkBreakToWatchRow("check_result_brain_other", { brain_action: null, brain_check_pattern: null, staff_aix: [{ aix_type: "property_check_result", check_pattern: "available", burst: true }] });
  ok(row); eq(row!.verdict_detail.reason, "text_but_aix");
  const a = autoAnswerOf(row!);
  ok(a); eq(a!.accept[0], "AIX:property_check_result/available"); eq(a!.mustNot, ["返信"]);
  const row2 = linkBreakToWatchRow("pickup_ready_brain_other", { brain_action: "acknowledge_check", brain_check_pattern: null, staff_aix: [{ aix_type: "property_send", check_pattern: null, burst: true }] });
  eq(row2!.verdict_detail.reason, "aix_other"); eq(autoAnswerOf(row2!)!.mustNot, ["AIX:acknowledge_check"]);
});

console.log(`\nlink-conductor: ${passed} PASS / ${failed} FAIL`);
if (failed) process.exit(1);
