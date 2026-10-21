// つなぎのブレイン 段1の見張り（link-brain-watch.ts）。LLM なし・DB なし。文は実物の型（名前・物件名は伏せた）
// 実行: npx tsx app/lib/__tests__/link-brain-watch.test.ts
import {
  watchConversation, watchLinks, reactionTokensOf, pickupReadyAt, promiseWordsOf, compactLinkSummary, renderLinkSummary,
  linkBrainTodoEnabled, linkBrainWatchEnabled, type LinkConvInput, type LinkWindow, type LinkVerdict,
} from "../link-brain-watch";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function eq<T>(a: T, b: T, label = "") { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${label} expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); }

const H = 3600_000;
const T0 = Date.parse("2026-10-10T01:00:00.000Z");
const iso = (h: number) => new Date(T0 + h * H).toISOString();
const NOW = T0 + 10 * 24 * H;
const W: LinkWindow = { fromMs: T0 - 2 * 24 * H, toMs: NOW, nowMs: NOW };
const base = (over: Partial<LinkConvInput> = {}): LinkConvInput => ({
  conv: { id: "abcdef12-0000-0000-0000-000000000000", customer_name: "山田 花子", status: "proposing", status_manual_back_at: null },
  messages: [], aixLogs: [], facts: [], turns: [], aixItems: [], pickups: [], judgments: [], memoItems: [], ...over,
});
const of = (vs: LinkVerdict[], link: string) => vs.filter((v) => v.link === link);

console.log("切替");
it("LINK_BRAIN_TODO は既定 off・on で入る", () => { eq(linkBrainTodoEnabled({}), false); eq(linkBrainTodoEnabled({ LINK_BRAIN_TODO: "on" }), true); });
it("LINK_BRAIN_WATCH は既定 on・off で止まる", () => { eq(linkBrainWatchEnabled({}), true); eq(linkBrainWatchEnabled({ LINK_BRAIN_WATCH: "off" }), false); });

console.log("①約束→ピッカー");
// 「駐車場の空き状況確認」は募集状況の確認（check・ピッカー無し）に読まれる＝ピッカーに結ぶ約束は「駐車場について管理会社に確認」の形
const PARKING_PROMISE = "かしこまりました！！\n駐車場について管理会社に確認させて頂きます😊！！";
it("駐車場の確認の約束を AIX【物件確認した→駐車場】で果たした＝ok", () => {
  const v = of(watchConversation(base({
    messages: [{ sender: "customer", text: "駐車場ありますか？", created_at: iso(-0.1) }, { sender: "staff", text: PARKING_PROMISE, created_at: iso(0) }],
    aixLogs: [{ aix_type: "property_check_result", check_pattern: "mgmt_parking", sent_at: iso(5), created_at: iso(5), generated_text: "駐車場空きございました！！" }],
  }), W), "promise_picker");
  eq(v.length, 1); eq(v[0].ok, true);
});
it("同じ約束を別のピッカー（設備）で返した＝picker_mismatch", () => {
  const v = of(watchConversation(base({
    messages: [{ sender: "staff", text: PARKING_PROMISE, created_at: iso(0) }],
    aixLogs: [{ aix_type: "property_check_result", check_pattern: "mgmt_equipment", sent_at: iso(5), created_at: iso(5) }],
  }), W), "promise_picker");
  eq(v[0]?.breakType, "picker_mismatch");
});
it("72時間果たしていない・要対応も無い＝unsent_not_queued（やることリストの候補）", () => {
  const v = of(watchConversation(base({ messages: [{ sender: "staff", text: PARKING_PROMISE, created_at: iso(0) }] }), W), "promise_picker");
  eq(v[0]?.breakType, "unsent_not_queued"); eq(v[0]?.todo?.action, "property_check_result");
});
it("要対応（約束の続き）が立っていれば unsent_queued・候補にしない", () => {
  const v = of(watchConversation(base({
    messages: [{ sender: "staff", text: PARKING_PROMISE, created_at: iso(0) }],
    aixItems: [{ action: "property_check_result", check_pattern: "mgmt_parking", status: "pending", created_at: iso(0.1), done_at: null, resolution_note: "rule:promise_queue 駐車場" }],
  }), W), "promise_picker");
  eq(v[0]?.breakType, "unsent_queued"); eq(v[0]?.todo, undefined);
});
it("まだ72時間たっていない約束は数えない（熟す前）", () => {
  const w: LinkWindow = { fromMs: T0 - H, toMs: T0 + 24 * H, nowMs: T0 + 24 * H };
  eq(of(watchConversation(base({ messages: [{ sender: "staff", text: PARKING_PROMISE, created_at: iso(0) }] }), w), "promise_picker").length, 0);
});

console.log("②約束の結果→ブレイン");
const PICKUP_PROMISE = "かしこまりました！！\nご条件に合うお部屋ピックアップ出来次第お送りさせて頂きます😌！！";
const turn = (h: number, brain: string, staffAix: string[] = []) => ({ customer_turn_at: iso(h), brain_action: brain, brain_check_pattern: null, brain_at: iso(h + 0.01), staff_first_at: iso(h + 0.1), staff_aix: staffAix.map((a) => ({ at: iso(h + 0.1), burst: true, aix_type: a })), staff_texts: [] });
it("送れる物件（pass・未送付）が揃った番にブレインが返信＝pickup_ready_brain_other", () => {
  const v = of(watchConversation(base({
    messages: [{ sender: "staff", text: PICKUP_PROMISE, created_at: iso(0) }, { sender: "customer", text: "よろしくお願いします", created_at: iso(3) }],
    pickups: [{ created_at: iso(2), sent_at: null, status: "pending", verdict: "pass" }],
    turns: [turn(3, "")],
  }), W), "result_brain");
  eq(v[0]?.breakType, "pickup_ready_brain_other");
});
it("同じ番でブレインが物件ピックアップ＝ok", () => {
  const v = of(watchConversation(base({
    messages: [{ sender: "staff", text: PICKUP_PROMISE, created_at: iso(0) }],
    pickups: [{ created_at: iso(2), sent_at: null, status: "pending", verdict: "pass" }],
    turns: [turn(3, "property_send")],
  }), W), "result_brain");
  eq(v[0]?.ok, true);
});
it("保留（hold）だけ・送付済みは揃ったと見ない", () => {
  eq(pickupReadyAt([{ created_at: iso(0), sent_at: null, status: "pending", verdict: "hold" }], T0 + H), false);
  eq(pickupReadyAt([{ created_at: iso(0), sent_at: iso(0.5), status: "sent", verdict: "pass" }], T0 + H), false);
  eq(pickupReadyAt([{ created_at: iso(0), sent_at: null, status: "pending", verdict: "pass" }], T0 + H), true);
});

console.log("③反応→物件の条件");
it("外す地域・広さを拾う／条件の語（保証人・礼金）は地域にしない", () => {
  eq(reactionTokensOf("肥後橋は外して頂きたいです。リビング10帖以上がいいです"), [{ kind: "exclude", token: "肥後橋" }, { kind: "size", token: "10帖" }]);
  eq(reactionTokensOf("保証人は無しでお願いします"), []);
  eq(reactionTokensOf("礼金なしでお願いします"), []);
});
it("物件を送った後の『肥後橋は外して』が後の検索に残る＝ignored_in_search", () => {
  const v = of(watchConversation(base({
    facts: [{ kind: "properties_sent", status: "done", sent_at: iso(0) }],
    messages: [{ sender: "customer", text: "肥後橋は外してください", created_at: iso(1) }],
    pickups: [{ created_at: iso(30), sent_at: null, status: "pending", verdict: "pass", search_conditions: { filled: { stations: ["肥後橋", "本町"] } } }],
  }), W), "reaction_condition");
  eq(v[0]?.breakType, "ignored_in_search");
});
it("メモに入っていれば ok・どこにも無ければ not_recorded", () => {
  const msgs = [{ sender: "customer", text: "リビング10帖以上がいいです", created_at: iso(1) }];
  const facts = [{ kind: "properties_sent", status: "done", sent_at: iso(0) }];
  eq(of(watchConversation(base({ facts, messages: msgs, memoItems: [{ text: "リビング10帖以上を希望" }] }), W), "reaction_condition")[0]?.ok, true);
  eq(of(watchConversation(base({ facts, messages: msgs }), W), "reaction_condition")[0]?.breakType, "not_recorded");
});

console.log("④ブレイン→2通目");
it("約束の語", () => eq(promiseWordsOf({ object: "駐車場", checkPattern: "mgmt_parking" }), ["駐車場", "バイク置き場"]));
it("駐車場の約束を果たした AIX の本文に『駐車場』が無い＝second_lacks_promise", () => {
  const v = of(watchConversation(base({
    messages: [{ sender: "staff", text: PARKING_PROMISE, created_at: iso(0) }],
    aixLogs: [{ aix_type: "property_check_result", check_pattern: "mgmt_parking", sent_at: iso(5), created_at: iso(5), generated_text: "確認させて頂きました！！ご検討よろしくお願いいたします😊" }],
  }), W), "brain_second");
  eq(v[0]?.breakType, "second_lacks_promise");
});

console.log("⑤新着とピックアップ");
it("宣言の記録に印（watch）が無い＝kind_unrecorded・あれば ok", () => {
  const v = of(watchConversation(base({ facts: [
    { kind: "pickup_declared", status: "promised", sent_at: iso(0), detail: { sentence: "ピックアップ出来次第お送り" } },
    { kind: "pickup_declared", status: "promised", sent_at: iso(1), detail: { watch: true } },
  ] }), W), "pickup_vs_watch");
  eq(v.map((x) => x.breakType ?? "ok"), ["kind_unrecorded", "ok"]);
});
it("新着の約束を【物件ピックアップ】で果たした＝mislabeled", () => {
  const v = of(watchConversation(base({
    messages: [{ sender: "staff", text: "新着出次第お送りさせて頂きます！！", created_at: iso(0) }],
    aixLogs: [{ aix_type: "property_send", check_pattern: null, sent_at: iso(20), created_at: iso(20) }],
  }), W), "pickup_vs_watch").filter((x) => x.breakType !== "kind_unrecorded" && x.detail?.includes("約束"));
  eq(v[0]?.breakType, "mislabeled");
});

console.log("A1 すぐ AIX");
it("約束の無い番でスタッフがすぐ物件確認した・ブレインは返信＝brain_not_direct", () => {
  const v = of(watchConversation(base({ turns: [turn(3, "", ["property_check_result"])] }), W), "direct_aix");
  eq(v[0]?.breakType, "brain_not_direct");
});
it("スタッフがすぐの並びで約束を挟んだ番（2段）は A1 の番でない", () => {
  const t = { ...turn(3, "", ["property_check_result"]), staff_texts: [{ at: iso(3.05), text: "募集状況確認させて頂きます😊！！", burst: true }] };
  eq(of(watchConversation(base({ turns: [t] }), W), "direct_aix").length, 0);
});
it("ブレインが読んでいない番（brain_at なし）は数えない", () => {
  eq(of(watchConversation(base({ turns: [{ ...turn(3, "", ["property_check_result"]), brain_at: null }] }), W), "direct_aix").length, 0);
});

console.log("申込歴→メモ・要対応→スタッフ");
it("申込から戻した会話でメモに印が無い＝memo_missing・あれば ok", () => {
  const conv = { id: "c1", customer_name: null, status: "proposing", status_manual_back_at: iso(0) };
  eq(of(watchConversation(base({ conv }), W), "reapply_memo")[0]?.breakType, "memo_missing");
  eq(of(watchConversation(base({ conv, memoItems: [{ text: "申込歴あり（再探し）審査否決" }] }), W), "reapply_memo")[0]?.ok, true);
  eq(of(watchConversation(base({ conv: { ...conv, status: "applying" } }), W), "reapply_memo").length, 0);
});
it("要対応: 24時間内に済み＝ok・遅れ・残り・48時間で片付け・ブレインの取り下げは数えない", () => {
  const item = (o: Partial<LinkConvInput["aixItems"][number]>) => ({ action: "property_send", check_pattern: null, status: "done", created_at: iso(0), done_at: iso(2), resolution_note: null, dismissed_reason: null, ...o });
  const v = of(watchConversation(base({ aixItems: [
    item({}), item({ done_at: iso(30) }), item({ status: "pending", done_at: null }),
    item({ status: "dismissed", done_at: null, dismissed_reason: "stale_customer_turn" }), item({ status: "dismissed", done_at: null, dismissed_reason: "brain_no_aix" }),
  ] }), W), "staff_todo");
  eq(v.map((x) => x.breakType ?? "ok"), ["ok", "late_done", "stale_pending", "dismissed"]);
});

console.log("司令塔（数え・伏せ・まとめ）");
it("つなぎごとに数え、例の名前を伏せ、まとめに例の文を残さない", () => {
  const s = watchLinks([base({ messages: [{ sender: "staff", text: `山田 花子さん\n${PARKING_PROMISE}`, created_at: iso(0) }] })], W);
  eq(s.links.promise_picker.broken, 1);
  eq(s.links.promise_picker.byType, { unsent_not_queued: 1 });
  eq(s.links.promise_picker.examples[0].conv, "abcdef12");
  eq(s.todo.length, 1);
  const c = JSON.stringify(compactLinkSummary(s));
  if (c.includes("駐車場") || c.includes("山田")) throw new Error("まとめに文が残った");
  if (!renderLinkSummary(s, { examples: true }).includes("①約束→ピッカー")) throw new Error("表に名前が無い");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
