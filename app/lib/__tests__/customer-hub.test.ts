// つなぎのブレイン 段2 お客様ごとの共通の状態（customer-hub.ts）。LLM なし・DB なし。文は型だけ（名前・物件名は作り物）
// 実行: npx tsx app/lib/__tests__/customer-hub.test.ts
import { buildCustomerHub, hubContradictions, renderCustomerHub, linkHubEnabled, type HubInput, type HubCalendarEvent, type HubAixItem } from "../customer-hub";
import { compactLinkSummary, watchLinks } from "../link-brain-watch";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function eq<T>(a: T, b: T, label = "") { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${label} expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); }
function ok(v: unknown, label = "") { if (!v) throw new Error(`${label} expected truthy`); }

const H = 3600_000;
const T0 = Date.parse("2026-10-10T01:00:00.000Z");
const iso = (h: number) => new Date(T0 + h * H).toISOString();
const NOW = T0 + 5 * H;
type Msg = { sender: string; text: string; h: number };
const input = (msgs: Msg[], over: Partial<HubInput> = {}, status = "proposing"): HubInput => ({
  nowMs: NOW,
  conv: { id: "abcdef12-0000-0000-0000-000000000000", customer_name: "山田 花子", account: null, status, is_post_apply: false, status_manual_back_at: null },
  state: {
    now: NOW, status, messages: msgs.map((m) => ({ sender: m.sender, text: m.text, createdAt: iso(m.h) })),
    aixRows: [], recordedFacts: [], viewingHistory: [], sentProperties: [], lineTasks: [],
  },
  aixItems: [], pickups: [], calendarEvents: [], memoItems: [], reactions: null, reapply: null, ...over,
});
const PARKING_PROMISE = "かしこまりました！！\n駐車場について管理会社に確認させて頂きます😊！！";
const PICKUP_PROMISE = "かしこまりました！！\nご条件に合うお部屋ピックアップ出来次第お送りさせて頂きます😌！！";

console.log("切替");
it("LINK_HUB は既定 off・on で読む", () => { eq(linkHubEnabled({}), false); eq(linkHubEnabled({ LINK_HUB: "on" }), true); eq(linkHubEnabled({ LINK_HUB: "off" }), false); });
it("見張りのまとめは hub が無ければ今までと同じ形・あれば数だけ足す", () => {
  const s0 = watchLinks([], { fromMs: T0, toMs: NOW, nowMs: NOW });
  eq("hub" in compactLinkSummary(s0), false);
  const c = compactLinkSummary({ ...s0, hub: { conversations: 1, withContradiction: 0, byType: {}, actors: { brain: 1 } } });
  ok("hub" in c);
});

console.log("約束・次の一手・誰が動く");
it("駐車場の確認の約束（未完）→ ピッカー鍵つきの約束・次の一手は AIX・動くのは AIX（こちらが最後）", () => {
  const h = buildCustomerHub(input([{ sender: "customer", text: "駐車場ありますか？", h: 0 }, { sender: "staff", text: PARKING_PROMISE, h: 0.1 }]));
  const q = h.promises.find((p) => p.source === "queue");
  ok(q, "queue");
  eq(q!.kind, "confirm"); eq(q!.pickerKey, "mgmt_parking"); eq(q!.action, "property_check_result");
  eq(h.nextActions[0].source, "promise_queue"); eq(h.nextActions[0].checkPattern, "mgmt_parking");
  eq(h.actor.who, "aix");
});
it("お客様の番（未返信）が残る → 動くのはブレイン", () => {
  const h = buildCustomerHub(input([{ sender: "staff", text: PARKING_PROMISE, h: 0 }, { sender: "customer", text: "ありがとうございます、お願いします", h: 1 }]));
  eq(h.actor.who, "brain");
  ok(h.actor.dueAt);
});
it("何も開いていない → なし", () => {
  const h = buildCustomerHub(input([{ sender: "customer", text: "はじめまして", h: 0 }, { sender: "staff", text: "お問い合わせありがとうございます！！", h: 0.1 }], {}, "first_reply"));
  eq(h.promises.filter((p) => p.source === "queue").length, 0);
  ok(["none", "staff", "brain"].includes(h.actor.who));
});
it("要対応（aix_action_items pending）は次の一手の候補に入る", () => {
  const item: HubAixItem = { id: "x", conversation_id: "abcdef12-0000-0000-0000-000000000000", customer_name: null, action: "estimate_sheet", check_pattern: null, status: "pending", created_at: iso(1), done_at: null, done_aix_type: null, resolution_note: null };
  const h = buildCustomerHub(input([{ sender: "customer", text: "お見積りください", h: 0 }, { sender: "staff", text: "お作り致します！！", h: 0.5 }], { aixItems: [item] }));
  ok(h.nextActions.some((a) => a.source === "aix_item" && a.action === "estimate_sheet"));
});

console.log("予定・物件・印");
it("連絡日の予定（calendar）→ 約束（contact）と予定に入る", () => {
  const ev: HubCalendarEvent = { id: 1, conversation_id: "abcdef12-0000-0000-0000-000000000000", customer_name: null, event_type: "property_send", start_at: iso(48), created_at: iso(0), notes: "【必ず】【連絡日 2026-10-12】お部屋探しの再開のご連絡", is_done: false };
  const h = buildCustomerHub(input([{ sender: "staff", text: "また12日にご連絡させて頂きます！！", h: 0 }], { calendarEvents: [ev] }));
  ok(h.promises.some((p) => p.source === "contact"), "contact");
  ok(h.schedule.some((x) => x.kind === "contact"), "schedule");
});
it("送れる物件（pass・未送付・新しい）→ pickupReady・ピックアップの約束があれば property_send の候補", () => {
  const h = buildCustomerHub(input([{ sender: "staff", text: PICKUP_PROMISE, h: 0 }], { pickups: [{ created_at: iso(2), sent_at: null, status: "pending", verdict: "pass" }] }));
  eq(h.properties.pickupReady, true); eq(h.properties.pickupsPending, 1);
  ok(h.nextActions.some((a) => a.source === "pickup_ready"));
});
it("審査の事情（お客様の発言）→ claudeOnly", () => {
  const h = buildCustomerHub(input([{ sender: "customer", text: "実は自己破産したことがあるのですが審査通りますか", h: 0 }]));
  ok(h.flags.screeningSensitive, "sensitive"); eq(h.flags.claudeOnly, true);
});
it("2番手を伝えた後（申込前）→ rankWaiting", () => {
  const h = buildCustomerHub(input([{ sender: "staff", text: "確認しましたところ、現在2番手でのお申込みとなります！！", h: 0 }]));
  eq(h.flags.rankWaiting, true);
});
it("申込歴あり（reapply）→ 印", () => {
  const h = buildCustomerHub(input([{ sender: "customer", text: "また探したいです", h: 0 }], { reapply: { reapply: true, returnedAt: iso(-24), pattern: "screening_denied", source: "staff" } }));
  eq(h.flags.reapply, true); ok(h.flags.reapplyPattern);
});

console.log("食い違い");
it("要対応が開いたまま、同じ約束はもう AIX で果たした＝aix_item_open_promise_done", () => {
  const item: HubAixItem = { id: "x", conversation_id: "abcdef12-0000-0000-0000-000000000000", customer_name: null, action: "property_check_result", check_pattern: "mgmt_parking", status: "pending", created_at: iso(0.2), done_at: null, done_aix_type: null, resolution_note: "rule:promise_queue" };
  const i = input([{ sender: "staff", text: PARKING_PROMISE, h: 0 }], { aixItems: [item] });
  i.state.aixRows = [{ aix_type: "property_check_result", check_pattern: "mgmt_parking", created_at: iso(3), sent_at: iso(3), generated_text: "駐車場空きございました！！" }];
  const h = buildCustomerHub(i);
  const c = hubContradictions(h, i);
  ok(c.some((x) => x.type === "aix_item_open_promise_done"), JSON.stringify(c));
});
it("約束した送信そのものが同じ時刻に done（物件送付の1通に次の約束）→【必ず】が開いていても食い違いにしない", () => {
  const cal: HubCalendarEvent = { id: 1, conversation_id: "abcdef12-0000-0000-0000-000000000000", customer_name: null, event_type: "property_send", start_at: iso(0.01), created_at: iso(0.01), notes: "【必ず】新着が出たら物件送付【新着待ち】", is_done: false };
  const i = input([{ sender: "staff", text: PICKUP_PROMISE, h: 0 }], { calendarEvents: [cal] });
  i.state.messages[0].isAix = true;
  i.state.aixRows = [{ aix_type: "property_send", check_pattern: null, created_at: iso(0), sent_at: iso(0), generated_text: PICKUP_PROMISE }];
  const c = hubContradictions(buildCustomerHub(i), i);
  ok(!c.some((x) => x.type === "calendar_open_promise_done"), JSON.stringify(c));
});
it("新着待ちでなく、約束も要対応も無ければ食い違いなし", () => {
  const i = input([{ sender: "customer", text: "こんにちは", h: 0 }, { sender: "staff", text: "こんにちは！！", h: 0.1 }]);
  eq(hubContradictions(buildCustomerHub(i), i).filter((x) => x.type !== "state_conflict").length, 0);
});
it("カレンダーの内覧があるのに状態に内覧が無い＝calendar_viewing_vs_state", () => {
  const ev: HubCalendarEvent = { id: 2, conversation_id: "abcdef12-0000-0000-0000-000000000000", customer_name: null, event_type: "viewing", start_at: iso(30), created_at: iso(0), notes: "物件: テストハイツ", is_done: false };
  const i = input([{ sender: "customer", text: "こんにちは", h: 0 }], { calendarEvents: [ev] });
  ok(hubContradictions(buildCustomerHub(i), i).some((x) => x.type === "calendar_viewing_vs_state"));
});
it("見送り（status=lost 相当の段階）なのに約束が開いている＝open_after_closed", () => {
  const i = input([{ sender: "staff", text: PARKING_PROMISE, h: 0 }, { sender: "customer", text: "他で決まりました、ありがとうございました", h: 1 }, { sender: "staff", text: "承知しました！！", h: 1.1 }], {}, "lost");
  const h = buildCustomerHub(i);
  eq(h.where.stage, "dropped"); ok(hubContradictions(h, i).some((x) => x.type === "open_after_closed"));
});

console.log("表示は伏せる");
it("名前を伏せる・食い違いを並べる", () => {
  const i = input([{ sender: "customer", text: "山田です。駐車場ありますか？", h: 0 }, { sender: "staff", text: `山田 花子様\n${PARKING_PROMISE}`, h: 0.1 }]);
  const h = buildCustomerHub(i);
  const t = renderCustomerHub(h, { customerName: "山田 花子", contradictions: hubContradictions(h, i) });
  ok(!t.includes("山田 花子"), t);
  ok(t.includes("今どこ"));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log(failures.join("\n")); process.exit(1); }
