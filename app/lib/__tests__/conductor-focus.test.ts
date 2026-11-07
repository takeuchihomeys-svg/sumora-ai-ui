// 実行: npx tsx app/lib/__tests__/conductor-focus.test.ts
import {
  conductorFocusMode, focusOfAix, focusOfReplyText, focusOfTakeuchiTurn, stageAt, openPromiseAt, sentAt, turnSituationTextV2,
  nearestFocus, sceneMajorityFocus, focusDigest, parseFocusRead, nearFocusLine, conductorFocusMeta, focusReadDigest, focusConflict,
  FOCUS_INTAKE_RULES, FOCUS_INTAKE_FIELD, FOCUS_KINDS, FOCUS_ORDER, focusOrder, orderDigest, laterOverrode, relationKeep, relationKeepCandidate, keepShareOf, focusOnForScene, focusBrainLine, focusHumanOnlyMiss, type HistMsg,
} from "../conductor-focus";
import { turnSendsForShape, isShapeAttachment } from "../conductor-turn-vectors";
import { shapeOfSends } from "../two-message-plan";
let passed = 0, failed = 0;
function it(name: string, fn: () => void) { try { fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); } }
function ok(v: unknown, label = "") { if (!v) throw new Error(`${label} expected truthy`); }
const eq = (a: unknown, b: unknown) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${JSON.stringify(a)} !== ${JSON.stringify(b)}`); };
const at = (d: number) => new Date(Date.parse("2026-11-01T00:00:00Z") + d * 86_400_000).toISOString();
const h = (sender: string, text: string, d: number, aixType: string | null = null): HistMsg => ({ sender, text, created_at: at(d), aixType });

it("既定 shadow（11/06 統括役）・off で止める・shadow/on は記録だけ", () => { eq(conductorFocusMode({}), "shadow"); eq(conductorFocusMode({ CONDUCTOR_FOCUS: "off" }), "off"); eq(conductorFocusMode({ CONDUCTOR_FOCUS: "shadow" }), "shadow"); eq(conductorFocusMode({ CONDUCTOR_FOCUS: "on" }), "shadow"); });
it("AIX → 重点（確認の結果・見積書は果たす／物件は約束があれば果たす）", () => {
  eq(focusOfAix("property_check_result"), "promise_keep"); eq(focusOfAix("estimate_sheet"), "promise_keep");
  eq(focusOfAix("property_send"), "propose"); eq(focusOfAix("property_send", { openPromise: true }), "promise_keep");
  eq(focusOfAix("viewing_invite"), "close"); eq(focusOfAix("cost_breakdown"), "answer"); eq(focusOfAix("aix_unknown"), null);
});
it("返信の文 → 重点（竹内さんの実際の書き方）", () => {
  eq(focusOfReplyText("はい！！\nこちら床の色グレーとなります！！"), "answer");
  eq(focusOfReplyText("かしこまりました！！\n管理会社に確認させて頂きます！！"), "promise_make");
  eq(focusOfReplyText("ありがとうございます😊\n何卒よろしくお願い致します！！"), "relation");
  eq(focusOfReplyText("こちらのお部屋オススメです！！\nお気に召されましたらご内覧のご案内も可能です😊"), "close");
});
it("竹内さんの番: AIX は種類から・返信は文から", () => {
  eq(focusOfTakeuchiTurn({ route: "aix", aixType: "meeting_place", text: "" }), "close");
  eq(focusOfTakeuchiTurn({ route: "reply", aixType: null, text: "全力でサポートさせて頂きますのでご安心ください" }), "ease");
});
it("進みはその時点の AIX の歴から（今の会話の段階を使わない＝未来の値が入らない・穴 292）", () => {
  eq(stageAt([]), "初回");
  eq(stageAt([h("customer", "x", 0), h("staff", "はい", 0)]), "やり取りの始め");
  eq(stageAt([h("staff", "", 0, "property_send"), h("staff", "", 1, "estimate_sheet")]), "見積書の後");
  eq(stageAt([h("staff", "", 0, "viewing_invite"), h("staff", "", 1, "meeting_place")]), "内覧の確定の後");
});
it("開いている約束: 約束の文の後に果たす AIX が無い時だけ", () => {
  const p = [h("customer", "空いてますか", 0), h("staff", "かしこまりました！！\n管理会社に確認させて頂きます！！", 0)];
  ok(openPromiseAt(p)?.includes("確認させて頂きます"));
  eq(openPromiseAt([...p, h("staff", "", 1, "property_check_result")]), null);
  eq(openPromiseAt([h("staff", "ありがとうございます", 0)]), null);
});
it("送った物: 回数と何日前・見積書", () => {
  eq(sentAt([h("staff", "", 0, "property_send"), h("staff", "", 2, "property_recommendation"), h("staff", "", 3, "estimate_sheet")], Date.parse(at(5))), "物件 2回（最後 3日前）・見積書");
  eq(sentAt([], 0), "なし");
});
it("状況の文 v2: 6行・同じ関数で過去と今を作る", () => {
  const s = turnSituationTextV2({ scene: "question", hist: [h("customer", "x", 0), h("staff", "管理会社に確認させて頂きます", 0)], customerMasked: "空いてますか？", nowMs: Date.parse(at(1)) });
  eq(s.split("\n").length, 6); ok(s.includes("開いている約束: 管理会社に確認させて頂きます")); ok(s.includes("直前のこちら: 返信（promise）"));
});
it("近い番の重点: 束に足りる時だけ多数決・束の外は場面の値", () => {
  const n = [{ id: "a", focus: "promise_keep" as const, dist: 0.05 }, { id: "b", focus: "promise_keep" as const, dist: 0.08 }, { id: "c", focus: "answer" as const, dist: 0.1 }, { id: "d", focus: "answer" as const, dist: 0.5 }];
  const r = nearestFocus(n, { band: 0.12, minN: 3, sceneFocus: "relation" });
  eq(r?.focus, "promise_keep"); eq(r?.inBand, true); eq(r?.n, 3);
  const out = nearestFocus(n, { band: 0.06, minN: 3, sceneFocus: "relation" });
  eq(out?.focus, "relation"); eq(out?.inBand, false);
  eq(nearestFocus([], { band: 0.1, minN: 3, sceneFocus: null }), null);
  eq(sceneMajorityFocus(["answer", "relation", "answer"]), "answer"); eq(sceneMajorityFocus([]), null);
  ok(focusDigest({ focus: "answer", why: "聞かれた", near: r }).startsWith("answer|聞かれた|b:3:"));
});
it("入口の読み: 表・背景・重点・理由を読み、一覧に無い重点は捨てる", () => {
  const r = parseFocusRead({ focus_read: { surface: "空いているか", background: "前に送った物件が気に入っている", focus: "promise_keep", why: "確認の結果が手元にある" } }, { focus: "promise_keep", share: 0.8, n: 5, ids: [], inBand: true });
  eq(r?.focus, "promise_keep"); eq(r?.near, "束:promise_keep(5件・80%)");
  eq(parseFocusRead({ focus_read: { focus: "創作" } }), null); eq(parseFocusRead(null), null);
  eq(conductorFocusMeta(r)?.focus, "promise_keep"); eq(focusReadDigest(r), "promise_keep|束:promise_keep(5件・80%)");
});
it("近い番の1行と先頭の決まり（固定の文・7種類が全部入る）", () => {
  ok(nearFocusLine({ focus: "answer", share: 0.75, n: 4, ids: [], inBand: true }).includes("4番のうち 75%"));
  ok(nearFocusLine({ focus: "answer", share: 0, n: 1, ids: [], inBand: false }).includes("近い番は少ない"));
  eq(nearFocusLine(null), "");
  for (const k of FOCUS_KINDS) { ok(FOCUS_INTAKE_RULES.includes(k), k); ok(FOCUS_INTAKE_FIELD.includes(k), k); ok(FOCUS_ORDER[k].length > 0 && FOCUS_ORDER[k][0].stage === "rough", k); }
  ok(!/\d{4}-\d{2}-\d{2}/.test(FOCUS_INTAKE_RULES), "先頭に日時を入れない");
});
it("後半への受け渡し: はっきりした食い違いだけ", () => {
  ok(focusConflict("promise_keep", { aix: null })); ok(focusConflict("answer", { aix: "property_send" })); ok(focusConflict("ease", { aix: "application_push" }));
  eq(focusConflict("promise_keep", { aix: "property_check_result" }), null); eq(focusConflict("relation", { aix: "property_send" }), null);
});
it("順番の表: 1番目は大まかな判断・段は後ろに戻らない・場面の上書き・digest", () => {
  const rank = { rough: 0, detail: 1, compose: 2, verify: 3 } as const;
  for (const k of FOCUS_KINDS) { const st = FOCUS_ORDER[k].map((s) => rank[s.stage]); ok(st.every((v, i) => i === 0 || v >= st[i - 1]), k); }
  eq(orderDigest(focusOrder("cost", "answer")), "judge>estimate>combine>writer>check_ground");
  eq(orderDigest(focusOrder("ack", "promise_keep")), "judge>aix_desk>property_search>estimate>combine>second");
  eq(orderDigest(focusOrder(null, "promise_make")), "judge>compose>writer");
  ok(laterOverrode(FOCUS_ORDER.promise_keep, [{ role: "judge", value: "aix" }, { role: "aix_desk", value: "reply" }])?.includes("aix_desk"));
  eq(laterOverrode(FOCUS_ORDER.promise_keep, [{ role: "judge", value: "aix" }, { role: "aix_desk", value: "aix" }]), null);
});
it("combine は compose の段の先頭（答える・果たす・不安・決める・出す）・関係と約束だけの番には無い", () => {
  for (const k of ["answer", "promise_keep", "ease", "close", "propose"] as const) eq(FOCUS_ORDER[k].filter((x) => x.stage === "compose")[0]?.role, "combine");
  for (const k of ["relation", "promise_make"] as const) ok(!FOCUS_ORDER[k].some((x) => x.role === "combine"), k);
});
it("番の型: 最初の送信から次のお客様の手前まで・付き物（画像・URL だけ）は外す・作業員7 shapeOfSends", () => {
  const msgs = [
    { sender: "customer", text: "空いてますか", is_aix_generated: false },
    { sender: "staff", text: "", is_aix_generated: true },
    { sender: "staff", text: "[画像]", is_aix_generated: false },
    { sender: "staff", text: "https://example.com/room", is_aix_generated: false },
    { sender: "staff", text: "お気に召されましたらご案内させて頂きます", is_aix_generated: false },
    { sender: "customer", text: "ありがとうございます", is_aix_generated: false },
    { sender: "staff", text: "はい！！", is_aix_generated: false },
  ];
  eq(shapeOfSends(turnSendsForShape(msgs, 1)), "AT");
  eq(shapeOfSends(turnSendsForShape(msgs, 6)), "R");
  ok(isShapeAttachment("[画像]") && isShapeAttachment("  ") && !isShapeAttachment("はい"));
});
it("relation の継続の約束（案A・11/06 統括役の決め）: 条件の番は既定で添える・了承と検討は (b)(c) の時だけ・(a) は候補だけ・同じ日に2回目は添えない", () => {
  ok(relationKeep({ scene: "conditions" })); ok(!relationKeep({ scene: "conditions", keptToday: true }));
  ok(!relationKeep({ scene: "ack" }));
  // 作業員9 試験 q164: 直前に物件を送っただけでは添えない（竹内さんは了承の番で 9% だけ）
  ok(!relationKeep({ scene: "ack", lastStaffSentOrEnded: true })); ok(relationKeepCandidate({ scene: "ack", lastStaffSentOrEnded: true })); ok(!relationKeepCandidate({ scene: "ack", lastStaffSentOrEnded: true, openPromise: true }));
  ok(relationKeep({ scene: "ack", lastStaffSentOrEnded: true, nearKeepShare: 0.67 }));
  eq(keepShareOf([true, false, true]), 0.67); eq(keepShareOf([true, null, undefined]), null); eq(keepShareOf([false, false, false, true]), 0.25);
  ok(relationKeep({ scene: "considering", customerAskedNew: true })); ok(relationKeep({ scene: "ack", nearKeepShare: 0.6 })); ok(!relationKeep({ scene: "ack", nearKeepShare: 0.5 }));
  ok(!relationKeep({ scene: "question", customerAskedNew: true }));
  eq(orderDigest(focusOrder("ack", "relation", { keep: true })), "judge>compose>writer");
  eq(orderDigest(focusOrder("ack", "relation")), "judge>writer");
});
it("人だけが知る事で分かれる外れ（relation と promise_keep の取り違えだけ）", () => {
  ok(focusHumanOnlyMiss("relation", "promise_keep")); ok(focusHumanOnlyMiss("promise_keep", "relation"));
  ok(!focusHumanOnlyMiss("relation", "relation")); ok(!focusHumanOnlyMiss("promise_make", "close")); ok(!focusHumanOnlyMiss(null, "relation"));
});
it("段2: CONDUCTOR_FOCUS_TO_BRAIN=on の時だけブレインに重点の1行・場面で絞る・CONDUCTOR_FOCUS=off なら渡さない", () => {
  ok(!focusOnForScene("ack", {})); ok(!focusOnForScene("ack", { CONDUCTOR_FOCUS: "on" }), "CONDUCTOR_FOCUS=on は今まで通り shadow");
  ok(focusOnForScene("ack", { CONDUCTOR_FOCUS_TO_BRAIN: "on" })); ok(!focusOnForScene("ack", { CONDUCTOR_FOCUS_TO_BRAIN: "on", CONDUCTOR_FOCUS: "off" }));
  ok(focusOnForScene("question", { CONDUCTOR_FOCUS_TO_BRAIN: "on", CONDUCTOR_FOCUS_ON_SCENES: "question, cost" })); ok(!focusOnForScene("ack", { CONDUCTOR_FOCUS_TO_BRAIN: "on", CONDUCTOR_FOCUS_ON_SCENES: "question" }));
  const l = focusBrainLine({ focus: "promise_keep", surface: "了承", background: "確認の結果待ち", why: "" }); ok(l.includes("promise_keep") && l.includes("背景: 確認の結果待ち") && l.includes("AIX の決まりが先"), l);
  eq(focusBrainLine(null), ""); eq(focusBrainLine({ focus: "x" as never, surface: "", background: "", why: "" }), "");
});
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
