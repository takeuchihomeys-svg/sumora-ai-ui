// 2026-09-27 AIX のボタンのズレ（竹内さん「表示されるタイミングとかもズレや問題、違うのが出たりする場合そこのズレも修正する」）
// 実行: npx tsx app/lib/__tests__/aix-button-view.test.ts（自己完結ハーネス。全 PASS で exit 0）
// 事例は本番の判断の形（scripts/audit-aix-button.ts の実例）をそのまま使う
import { resolveAixButtonView, resolveBrainAixAction, isAixListBadge, aixDismissKey, brainDecisionKey, summarizeAixButtonView, type AixViewMessage, type AixViewMeta } from "../aix-button-view";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return { toBe(exp: T) { if (JSON.stringify(actual) !== JSON.stringify(exp)) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); } };
}

const C1 = "2026-09-27T01:42:00.000Z";           // お客様の発言
const C2 = "2026-09-27T01:44:00.000Z";           // 次のお客様の発言
const cust = (t: string): AixViewMessage => ({ sender: "customer", rawCreatedAt: t });
const staff = (t: string, isAix = false): AixViewMessage => ({ sender: "staff", rawCreatedAt: t, isAix });
const brain = (action: string, extra: Partial<AixViewMeta> = {}): AixViewMeta =>
  ({ action, note: "募集状況を確認して報告", reply_mode: action ? "aix" : "auto_reply", analyzed_msg_ts: C1, source: "brain_fresh", ...extra });

console.log("■ 旧の動きを変えない所（legacy と同じ）");
it("新しい判断の AIX（物件確認した）→ カード・点滅・✓確認した・一覧のバッジ", () => {
  for (const legacy of [true, false]) {
    const v = resolveAixButtonView({ meta: brain("property_check_result"), messages: [cust(C1)], legacy });
    expect(v.card?.action).toBe("property_check_result");
    expect(v.pulse).toBe("property_check_result");
    expect(v.checkShortcut).toBe(true);
    expect(v.listBadge).toBe(true);
  }
});
it("見積書送る → 見積書の帯（P4.5）が先・カードは出ない", () => {
  const v = resolveAixButtonView({ meta: brain("estimate_sheet"), messages: [cust(C1)] });
  expect(v.earlyBanner).toBe("estimate_sheet"); expect(v.card).toBe(null); expect(v.pulse).toBe("estimate_sheet");
});
it("ブレインが AIX なし → 何も出ない（バナー・点滅・バッジなし）", () => {
  const v = resolveAixButtonView({ meta: brain(""), messages: [cust(C1)] });
  expect(summarizeAixButtonView(v)).toBe({ shown: null, channel: "none" }); expect(v.listBadge).toBe(false);
});
it("古い判断（見た発言より新しいお客様の発言がある）→ 帯・カードは出ない", () => {
  const v = resolveAixButtonView({ meta: brain("property_check_result"), messages: [cust(C1), cust(C2)] });
  expect(v.card).toBe(null); expect(v.earlyBanner).toBe(null); expect(v.brainAixAction).toBe(null);
});
it("内覧日調整は最後がスタッフの時は出さない（物件送付直後の残り）", () => {
  const v = resolveAixButtonView({ meta: brain("viewing_invite"), messages: [cust(C1), staff(C2)], lastSender: "staff" });
  expect(v.earlyBanner).toBe(null); expect(v.card).toBe(null);
});
it("AIX のフロー中は点滅・帯を出さない", () => {
  const v = resolveAixButtonView({ meta: brain("meeting_place"), messages: [cust(C1)], activeAixFlow: "meeting_place" });
  expect(v.pulse).toBe(null); expect(v.earlyBanner).toBe("meeting_place_meta");
});

console.log("■ A: 今の判断が AIX なしなら、控えの AIX に落ちない");
it("控え=物件確認した・今の判断=AIX なし（同じ発言）→ 旧は点滅、新は出さない", () => {
  const input = { meta: brain(""), kept: { action: "property_check_result", analyzed_msg_ts: C1 }, messages: [cust(C1), staff("2026-09-27T01:43:00.000Z")] };
  expect(resolveBrainAixAction({ ...input, legacy: true })).toBe("property_check_result");
  expect(resolveBrainAixAction(input)).toBe(null);
});

console.log("■ B: 控えは「どの発言への判断か」を持つ");
it("生成で届いた控え（analyzed_msg_ts なし）が次のお客様の発言の後も残る → 旧は出る、新は turn_ts で切る", () => {
  const kept = { action: "estimate_sheet", turn_ts: C1 };
  expect(resolveBrainAixAction({ meta: null, kept: { action: "estimate_sheet" }, messages: [cust(C1), cust(C2)], legacy: true })).toBe("estimate_sheet");
  expect(resolveBrainAixAction({ meta: null, kept, messages: [cust(C1), cust(C2)] })).toBe(null);
  expect(resolveBrainAixAction({ meta: null, kept, messages: [cust(C1)] })).toBe("estimate_sheet");
});
it("発言の時刻が分からない控えは使わない", () => {
  expect(resolveBrainAixAction({ meta: null, kept: { action: "estimate_sheet" }, messages: [cust(C1)] })).toBe(null);
});

console.log("■ C: 判断の後に AIX を送ったら控えは使わない");
it("控え=物件確認した → AIX を送った → 旧は点滅・✓確認したが残る、新は消える", () => {
  const msgs = [cust(C1), staff("2026-09-27T01:50:00.000Z", true)];
  const kept = { action: "property_check_result", analyzed_msg_ts: C1 };
  expect(resolveAixButtonView({ meta: null, kept, messages: msgs, lastSender: "staff", legacy: true }).checkShortcut).toBe(true);
  expect(resolveAixButtonView({ meta: null, kept, messages: msgs, lastSender: "staff" }).checkShortcut).toBe(false);
});
it("通常の返信を送った後は控えを残す（下書き送信後も指示を出す・旧と同じ）", () => {
  const msgs = [cust(C1), staff("2026-09-27T01:50:00.000Z", false)];
  expect(resolveAixButtonView({ meta: null, kept: { action: "property_check_result", analyzed_msg_ts: C1 }, messages: msgs, lastSender: "staff" }).checkShortcut).toBe(true);
});

console.log("■ D: 一覧のバッジは鮮度を見る（分析中に届いた2通目）");
it("YUYA 09-16 22:07 型: 判断は1通目・2通目が後 → 旧はバッジ、新は出さない", () => {
  const c = { meta: brain("viewing_invite"), lastSender: "customer", messages: [cust(C1), cust(C2)] };
  expect(isAixListBadge(c, true)).toBe(true);
  expect(isAixListBadge(c)).toBe(false);
});
it("メッセージが未読み込みの行は旧と同じ（バッジを出す）", () => {
  expect(isAixListBadge({ meta: brain("viewing_invite"), lastSender: "customer", messages: [] })).toBe(true);
});
it("スタッフの宣言（promise:）は最後がスタッフでもバッジ", () => {
  expect(isAixListBadge({ meta: brain("estimate_sheet", { decision_source: "promise:estimate" }), lastSender: "staff", messages: [cust(C1), staff(C2)] })).toBe(true);
});

console.log("■ E: 2択・2つ目の AIX は単独の帯で隠さない");
it("慶次 型: 2択×物件ピックアップ → 旧は物件ピックアップの帯＋AIX ボタンが隠れる、新は2択のカード", () => {
  const meta = brain("property_send", { two_choice_mode: true, reply_direction_label: "検討見守り" });
  const old = resolveAixButtonView({ meta, messages: [cust(C1)], legacy: true });
  expect(old.earlyBanner).toBe("property_send"); expect(old.aixMenuButtonHidden).toBe(true);
  const now = resolveAixButtonView({ meta, messages: [cust(C1)] });
  expect(now.earlyBanner).toBe(null); expect(now.card?.kind).toBe("two_choice"); expect(now.aixMenuButtonHidden).toBe(true);
  expect(summarizeAixButtonView(now).shown).toBe("two_choice:property_send");
});
it("朱莉 型: 物件ピックアップ＋2つ目 物件オススメ → 旧は帯（2つ目なし）、新はカードに2つ", () => {
  const meta = brain("property_send", { alt_actions: ["property_recommendation"], decision_source: "rule:closed_ack_wait" });
  expect(resolveAixButtonView({ meta, messages: [cust(C1)], legacy: true }).earlyBanner).toBe("property_send");
  const now = resolveAixButtonView({ meta, messages: [cust(C1)] });
  expect(now.card?.altActions).toBe(["property_recommendation"]); expect(now.earlyBanner).toBe(null);
});
it("2つ目が無い物件ピックアップは今まで通り帯", () => {
  expect(resolveAixButtonView({ meta: brain("property_send"), messages: [cust(C1)] }).earlyBanner).toBe("property_send");
});

console.log("■ F: note が空でもカードを出す・AIX ボタンを隠すのはカードを出している時だけ");
it("AIX あり・note 空 → 旧は何も出ない、新はカード", () => {
  const meta = brain("phone_call", { note: "" });
  expect(resolveAixButtonView({ meta, messages: [cust(C1)], legacy: true }).card).toBe(null);
  expect(resolveAixButtonView({ meta, messages: [cust(C1)] }).card?.action).toBe("phone_call");
});
it("2択が古い判断 → 旧は AIX ボタンを隠す（押す道が無い）、新は隠さない", () => {
  const meta = brain("property_recommendation", { two_choice_mode: true });
  expect(resolveAixButtonView({ meta, messages: [cust(C1), cust(C2)], legacy: true }).aixMenuButtonHidden).toBe(true);
  expect(resolveAixButtonView({ meta, messages: [cust(C1), cust(C2)] }).aixMenuButtonHidden).toBe(false);
});

console.log("■ G: 却下の鍵は会話＋判断");
it("同じ会話でも次の発言の判断は別の鍵", () => {
  const a = aixDismissKey("conv", brain("estimate_sheet")), b = aixDismissKey("conv", brain("estimate_sheet", { analyzed_msg_ts: C2 }));
  expect(a === b).toBe(false);
  expect(aixDismissKey("conv", brain("estimate_sheet"), true)).toBe("conv");
});
it("同じ発言でも AIX の種類・2択が変われば別の判断（スタッフの宣言での出し直し）", () => {
  expect(brainDecisionKey(brain("")) === brainDecisionKey(brain("property_send"))).toBe(false);
  expect(brainDecisionKey(brain("property_send")) === brainDecisionKey(brain("property_send", { two_choice_mode: true }))).toBe(false);
});
it("却下した判断のカード・帯は出ない", () => {
  const v = resolveAixButtonView({ meta: brain("estimate_sheet"), messages: [cust(C1)], dismissed: { estimateSheet: true, brainHint: true } });
  expect(v.earlyBanner).toBe(null); expect(v.card).toBe(null); expect(v.pulse).toBe("estimate_sheet");
});

console.log("■ H: メニューのおすすめ枠はブレインの今の判断だけ");
it("古い判断の見積書 → 旧は光る、新は光らない", () => {
  const meta = brain("estimate_sheet");
  expect(resolveAixButtonView({ meta, messages: [cust(C1), cust(C2)], legacy: true }).menuHighlight).toBe("estimate_sheet");
  expect(resolveAixButtonView({ meta, messages: [cust(C1), cust(C2)] }).menuHighlight).toBe(null);
});
it("今の判断の物件オススメ → 新は光る（旧は光らなかった種類）", () => {
  expect(resolveAixButtonView({ meta: brain("property_recommendation"), messages: [cust(C1)] }).menuHighlight).toBe("property_recommendation");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log(failures.join("\n")); process.exit(1); }
