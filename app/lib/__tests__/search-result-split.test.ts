// 2026-10-13 竹内さん（KAORI）「左右にボタンを分ける。物件あった場合（複数＝物件ピックアップ・1件＝物件オススメ）／物件なかった場合（全力サポート）」（search-result-split.ts）
// 実行: npx tsx app/lib/__tests__/search-result-split.test.ts
import { searchSplitView, isSearchSplitTurn, applySearchSplit, searchSplitServerEnabled, splitReplyToAix, splitMaterialLine, searchSplitNote, zenryokuShown, zenryokuCandidateMaterial, zenryokuCandidateTurn, llmAixRestorable, OTHER_PROPERTY_ASK_RE } from "../search-result-split";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function eq<T>(a: T, b: T, label = "") { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${label} expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); }

console.log("■ 画面: 出す・出さないはブレインの一手だけ");
it("一手が物件ピックアップした・物件オススメ・物件を探す・全力サポート → 左右の形", () => {
  for (const a of ["property_send", "property_recommendation", "property_search", "zenryoku_support"]) eq(isSearchSplitTurn({ brainAction: a }), true, a);
});
it("それ以外の AIX・AIX なし → 今まで通り", () => {
  for (const a of ["estimate_sheet", "property_check_result", "viewing_invite", "", null]) eq(isSearchSplitTurn({ brainAction: a }), false, String(a));
});
it("2択（AIX か返信か）の番は別のカードのまま", () => eq(isSearchSplitTurn({ brainAction: "property_send", twoChoiceMode: true }), false));
it("NEXT_PUBLIC_SEARCH_SPLIT_CHOICE=off（off: true）→ 今まで通り", () => eq(searchSplitView({ brainAction: "property_send", off: true }), null));

console.log("■ 画面: 並びは一手に関係なく固定（左上ピックアップ・左下オススメ・右全力サポート）");
it("KAORI の形（旧は一手＝全力サポート・2つ目＝物件ピックアップ）→ 左に物件ピックアップ・物件オススメ、右に全力サポート", () => {
  const v = searchSplitView({ brainAction: "zenryoku_support", altActions: ["property_send"] })!;
  eq(v.foundHeading, "物件あった場合"); eq(v.notFoundHeading, "物件なかった場合");
  eq(v.found.map((b) => b.action), ["property_send", "property_recommendation"]);
  eq(v.found.map((b) => b.sub), ["複数あった時", "1件の時"]);
  eq(v.notFound?.action, "zenryoku_support"); eq(v.notFound?.isBrain, true);
  eq(v.others, []);
});
it("一手が物件オススメでも同じ位置（色・位置で押し間違えない）", () => {
  const v = searchSplitView({ brainAction: "property_recommendation", altActions: ["zenryoku_support"] })!;
  eq(v.found.map((b) => b.action), ["property_send", "property_recommendation"]);
  eq(v.found[1].isBrain, true); eq(v.found[0].isBrain, false);
});
it("物件を探す（Chrome拡張で検索）→ 物件ピックアップが一手扱い", () => eq(searchSplitView({ brainAction: "property_search" })!.found[0].isBrain, true));
it("3つ以外の2つ目の AIX（見積書）は下に残す・重複は1つ", () => {
  eq(searchSplitView({ brainAction: "property_send", altActions: ["property_recommendation", "estimate_sheet", "zenryoku_support", "estimate_sheet"] })!.others, ["estimate_sheet"]);
});

console.log("■ サーバー: 出し切りで一手を【全力サポート】に書き換えない");
it("出し切り・一手が物件ピックアップした → 一手はそのまま・全力サポートを2つ目に", () => {
  eq(applySearchSplit({ finalAix: "property_send", fromReply: false, altActions: ["property_recommendation"], exhausted: true, postApply: false, zenryokuCandidate: true }),
    { applies: true, finalAix: "property_send", altActions: ["property_recommendation", "zenryoku_support"], toAix: false });
});
it("出し切り・2段のピックアップの約束（返信）→ AIX の番にし、一手は LLM の物件の AIX（物件オススメ）", () => {
  const r = applySearchSplit({ finalAix: null, fromReply: true, llmAix: "property_recommendation", altActions: undefined, exhausted: true, postApply: false, zenryokuCandidate: true });
  eq(r, { applies: true, finalAix: "property_recommendation", altActions: ["zenryoku_support"], toAix: true });
});
it("出し切り・返信で LLM の AIX が物件でない → 物件ピックアップ（全力サポートには決め打ちしない）", () => {
  eq(applySearchSplit({ finalAix: null, fromReply: true, llmAix: "estimate_sheet", altActions: undefined, exhausted: true, postApply: false }).finalAix, "property_send");
});
it("出し切りでない・申込以降・SEARCH_SPLIT_CHOICE=off → 何もしない（呼ぶ側が旧の動き）", () => {
  eq(applySearchSplit({ finalAix: "property_send", fromReply: false, altActions: undefined, exhausted: false, postApply: false }).applies, false);
  eq(applySearchSplit({ finalAix: "property_send", fromReply: false, altActions: undefined, exhausted: true, postApply: true }).applies, false);
  eq(applySearchSplit({ finalAix: "property_send", fromReply: false, altActions: undefined, exhausted: true, postApply: false, env: { SEARCH_SPLIT_CHOICE: "off" } }).applies, false);
  eq(searchSplitServerEnabled({}), true); eq(searchSplitServerEnabled({ SEARCH_SPLIT_CHOICE: "OFF" }), false);
});
it("返信のままの番（fromReply=false で一手なし）は触らない", () => {
  eq(applySearchSplit({ finalAix: null, fromReply: false, altActions: undefined, exhausted: true, postApply: false }).applies, false);
});

console.log("■ 10/13 レビュー（重要2）: 返信を AIX に移すのは明示の印の時だけ・材料は答えを書かない");
it("strong → gate に任せる（gate が false＝BRAIN_DEMOTE_SEARCH_EXHAUSTED=on なら移さない）", () => {
  let rec = 0;
  eq(splitReplyToAix({ strength: "strong", gate: () => true, record: () => { rec++; } }), true);
  eq(splitReplyToAix({ strength: "strong", gate: () => false, record: () => { rec++; } }), false);
  eq(rec, 0);
});
it("weak（送付だけ）→ 移さず記録だけ", () => {
  let rec = 0, gated = 0;
  eq(splitReplyToAix({ strength: "weak", gate: () => { gated++; return true; }, record: () => { rec++; } }), false);
  eq([rec, gated], [1, 0]);
});
it("材料の1行: 印が無ければ空・strong と weak で言い方が違う・左右の形の事実を入れ、答え（どちらにせよ）を書かない", () => {
  eq(splitMaterialLine({ exhausted: false, markerAt: null }), "");
  const s = splitMaterialLine({ exhausted: true, markerAt: "2026-10-12T03:00:00Z", strength: "strong", markerText: "全てピックアップさせて頂きました" });
  eq(/出し切ったと言った印/.test(s) && /物件なかった場合＝AIX【全力サポート】/.test(s) && /あなたが決める/.test(s), true);
  eq(/が主/.test(s), false);
  const w = splitMaterialLine({ exhausted: true, markerAt: "2026-10-12T03:00:00Z", strength: "weak", markerText: "ピックアップさせて頂きました" });
  eq(/1回送っただけ/.test(w), true);
});

console.log("■ 10/13 竹内さんの決定（B）: 右（全力サポート）はブレインが候補にした時だけ・新規は左だけ");
it("新規（一手が物件ピックアップ・2つ目に全力サポートなし）→ 左だけ（notFound=null）", () => {
  const v = searchSplitView({ brainAction: "property_send", altActions: ["property_recommendation"] })!;
  eq(v.notFound, null); eq(v.found.length, 2);
  eq(searchSplitNote({ brainAction: "property_send", altActions: [] }).includes("全力サポート"), false);
});
it("新着・他にあるか（ブレインが2つ目に全力サポート）→ 右も出す", () => {
  eq(searchSplitView({ brainAction: "property_recommendation", altActions: ["zenryoku_support"] })!.notFound?.action, "zenryoku_support");
  eq(searchSplitNote({ brainAction: "property_send", altActions: ["zenryoku_support"] }).includes("全力サポート"), true);
});
it("一手が全力サポート → 右も出す（左も並ぶ）", () => eq(zenryokuShown({ brainAction: "zenryoku_support" }), true));
it("出し切りでもブレインが候補にしていない → 全力サポートを足さない", () => {
  eq(applySearchSplit({ finalAix: "property_send", fromReply: false, altActions: undefined, exhausted: true, postApply: false }).altActions, []);
});
it("2段の規則が LLM の物件の AIX を約束に書き換えた番 → ブレインの答えに戻す（印の強さに関係なく）", () => {
  let gated = 0, rec = 0;
  eq(splitReplyToAix({ strength: "weak", llmAixIsProperty: true, gate: () => { gated++; return false; }, record: () => { rec++; } }), true);
  eq([gated, rec], [0, 0]);
});
it("候補の材料: 新規・他にあるか・答えを書かない", () => {
  const n = zenryokuCandidateMaterial({ sentPropertyCount: 0, lastSentAt: null, exhaustLine: "", customerText: "梅田で1LDK探してます" });
  eq(/まだ物件を送っていない（新規）/.test(n) && /ほかの物件・新着を聞いている: いいえ/.test(n) && /zenryoku_candidate/.test(n), true);
  const o = zenryokuCandidateMaterial({ sentPropertyCount: 5, lastSentAt: "2026-10-10T00:00:00Z", exhaustLine: "", customerText: "他にもありますか？" });
  eq(/前に物件を送っている（5件・最後 2026-10-10）/.test(o) && /聞いている: はい/.test(o), true);
  eq(OTHER_PROPERTY_ASK_RE.test("他まだありますか"), true);
  eq(OTHER_PROPERTY_ASK_RE.test("新着出たら教えてください"), true);
  eq(OTHER_PROPERTY_ASK_RE.test("ありがとうございます"), false);
});

console.log("■ 10/13 見直し: 戻すのは2段の規則の番だけ・材料は物件の番だけ・問いの網を絞る");
it("LLM の物件の AIX に戻すのは2段の規則（two_stage…pickup）の番だけ", () => {
  eq(llmAixRestorable({ twoStagePickup: true, llmAix: "property_send" }), true);
  eq(llmAixRestorable({ twoStagePickup: true, llmAix: "property_recommendation" }), true);
  eq(llmAixRestorable({ twoStagePickup: false, llmAix: "property_send" }), false); // 条件の言い直しへの返信（別の規則が消した）
  eq(llmAixRestorable({ twoStagePickup: true, llmAix: "estimate_sheet" }), false);
  eq(llmAixRestorable({ twoStagePickup: true, llmAix: null }), false);
});
it("条件の言い直しへの返信（戻せない）・送付だけの印 → 移さず記録だけ／強い印 → gate", () => {
  let rec = 0;
  eq(splitReplyToAix({ strength: "weak", llmAixIsProperty: llmAixRestorable({ twoStagePickup: false, llmAix: "property_send" }), gate: () => true, record: () => { rec++; } }), false);
  eq(rec, 1);
  eq(splitReplyToAix({ strength: "strong", llmAixIsProperty: llmAixRestorable({ twoStagePickup: false, llmAix: "property_send" }), gate: () => false, record: () => {} }), false);
});
it("他の物件の問いの網: 他の物件／他にも物件・お部屋／他（に）まだありますか／新着だけ", () => {
  for (const t of ["他の物件も見たいです", "他のお部屋ありますか", "他にも物件ありますか？", "ほかにいいお部屋あれば", "他まだありますか", "他にありますか？", "他にもありますか", "新着出たら教えてください"]) eq(OTHER_PROPERTY_ASK_RE.test(t), true, t);
  for (const t of ["他に質問はありません", "このお部屋まだありますか", "まだありますか？", "他に何か必要な書類はありますか", "ありがとうございます"]) eq(OTHER_PROPERTY_ASK_RE.test(t), false, t);
});
it("材料を渡す番: 条件の場面・場面の証拠が物件／全力サポート・他の物件の問い・今送れる候補あり（それ以外は渡さない）", () => {
  eq(zenryokuCandidateTurn({ scene: "conditions", sceneCandidate: null, customerText: "", pickupReady: null }), true);
  eq(zenryokuCandidateTurn({ scene: "question", sceneCandidate: "property_send", customerText: "", pickupReady: null }), true);
  eq(zenryokuCandidateTurn({ scene: "ack", sceneCandidate: null, customerText: "他にもありますか", pickupReady: null }), true);
  eq(zenryokuCandidateTurn({ scene: "ack", sceneCandidate: null, customerText: "ありがとうございます", pickupReady: true }), true);
  eq(zenryokuCandidateTurn({ scene: "apply", sceneCandidate: "estimate_sheet", customerText: "審査の書類を送りました", pickupReady: false }), false);
  eq(zenryokuCandidateTurn({ scene: "question", sceneCandidate: null, customerText: "他に質問はありません", pickupReady: null }), false);
});
it("材料に今送れる候補の有無を1行（答えは書かない）", () => {
  eq(/今送れる物件の候補（売上サポのピックアップ）がある/.test(zenryokuCandidateMaterial({ sentPropertyCount: 3, lastSentAt: null, exhaustLine: "", customerText: "", pickupReady: true })), true);
  eq(/は無い（探してみないと分からない）/.test(zenryokuCandidateMaterial({ sentPropertyCount: 3, lastSentAt: null, exhaustLine: "", customerText: "", pickupReady: false })), true);
  eq(/売上サポ/.test(zenryokuCandidateMaterial({ sentPropertyCount: 3, lastSentAt: null, exhaustLine: "", customerText: "" })), false);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log(f); process.exit(1); }
