// AIX の番の数え直し（aix-turn-judgment）・端末の書き手（staff-writer.deviceWriterOfWindow）・ピックアップの約束への了承の道の1行（ACK_PICKUP_AIX_PATH）のテスト
// 2026-11-23 作業員A。実物の番の形（60日の竹内さん本人の番の監査 scripts/audit-aix-turn-judgment.ts で読んだ形）を、名前・物件名を伏せて使う
// 実行: npx tsx app/lib/__tests__/aix-turn-judgment.test.ts（全 PASS で exit 0）
import { aixBundle, turnClassOf, aixKindOfTurn, brainRouteOf, judgeTurn } from "../aix-turn-judgment";
import { deviceWriterOfWindow, watchWriterDeviceFirstOn } from "../staff-writer";
import { ackFormFacts, ackFormMaterialLine, ackConfirmAixPathLine, ackFormAixShareLine } from "../repeat-brain-align";
import { applyRule6OpenPromise, rule6OpenPromiseOn, RULE6_OPEN_PROMISE_EDIT } from "../brain-prompt-rules-1112";
import { readFileSync } from "node:fs";
import { join } from "node:path";

let passed = 0, failed = 0;
function it(name: string, fn: () => void) { try { fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); } }
function eq<T>(a: T, b: T) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); }
const T0 = Date.parse("2026-11-09T07:52:00Z");

console.log("aix-turn-judgment");
it("オススメとピックアップは1つの束・カタログの鍵はボタンだけ", () => { eq(aixBundle("property_recommendation"), "property"); eq(aixBundle("property_check_result/available"), "property_check_result"); eq(aixBundle(null), null); });
it("最初の一手が AIX → aix_first", () => eq(turnClassOf([{ at: T0, aix: true, aixKind: "property_send" }]), "aix_first"));
it("約束の返信の後 99分で AIX → two_stage（数え方の誤り①: AIX の番と数えない）", () => eq(turnClassOf([{ at: T0, aix: false }, { at: T0 + 99 * 60_000, aix: true, aixKind: "property_check_result" }]), "two_stage"));
it("返信の後 2分以内に AIX → quick", () => eq(turnClassOf([{ at: T0, aix: false }, { at: T0 + 60_000, aix: true }]), "quick"));
it("AIX を押さず中身を手で打った → hand_aix（数え方の誤り③）", () => eq(turnClassOf([{ at: T0, aix: false }], ["property_check_result/available"]), "hand_aix"));
it("手打ちの本来の AIX の種類", () => eq(aixKindOfTurn([{ at: T0, aix: false }], ["property_check_result/available"]), "property_check_result"));
it("2段の decision_source は two_stage", () => eq(brainRouteOf("reply", "property_check_result", "no_aix:rule:two_stage_promise(check_question)").route, "two_stage"));
it("2段の番でブレインが約束の返信 → 一致", () => eq(judgeTurn("two_stage", "property", { route: "two_stage", kind: null }), "一致"));
it("2段の番でブレインが同じ AIX を今 → 先後", () => eq(judgeTurn("two_stage", "property", { route: "aix", kind: "property" }), "先後"));
it("2d7548d5 の形: 了承の番に竹内さんは物件確認した・ブレインは2段 → AIXの番を返信", () => eq(judgeTurn("aix_first", "property_check_result", { route: "two_stage", kind: null }), "AIXの番を返信"));
it("17208 の形: 竹内さんは物件確認した・ブレインは見積書 → 種類違い", () => eq(judgeTurn("aix_first", "property_check_result", { route: "aix", kind: "estimate_sheet" }), "種類違い"));
it("返信だけの番でブレインが AIX → 返信の番をAIX", () => eq(judgeTurn("reply", null, { route: "aix", kind: "property" }), "返信の番をAIX"));

console.log("staff-writer.deviceWriterOfWindow");
const W = (sender: string, at: string, w: string | null, src: string | null = "device") => ({ sender, created_at: at, staff_writer: w, staff_writer_source: src });
it("従業員が押した AIX の番（癖では竹内さんと読む形）→ 端末で employee", () => eq(deviceWriterOfWindow([W("customer", "2026-11-16T00:12:00Z", null, null), W("staff", "2026-11-16T02:34:20Z", "employee"), W("staff", "2026-11-16T02:34:24Z", "employee")], "2026-11-16T00:12:00Z", null)?.writer, "employee"));
it("竹内さんだけ → takeuchi・source=device", () => eq(deviceWriterOfWindow([W("staff", "2026-11-16T02:00:00Z", "takeuchi")], "2026-11-16T01:00:00Z", null), { writer: "takeuchi", confidence: "sure", source: "device" }));
it("竹内さんと従業員が混ざる番は決めない", () => eq(deviceWriterOfWindow([W("staff", "2026-11-16T02:00:00Z", "takeuchi"), W("staff", "2026-11-16T02:05:00Z", "employee")], "2026-11-16T01:00:00Z", null), null));
it("記録の無い通がある番は決めない（今までどおり癖）", () => eq(deviceWriterOfWindow([W("staff", "2026-11-16T02:00:00Z", "takeuchi"), W("staff", "2026-11-16T02:05:00Z", null, null)], "2026-11-16T01:00:00Z", null), null));
it("窓の外（次のお客様の発言の後）の通は見ない", () => eq(deviceWriterOfWindow([W("staff", "2026-11-16T02:00:00Z", "takeuchi"), W("staff", "2026-11-16T05:00:00Z", "employee")], "2026-11-16T01:00:00Z", "2026-11-16T03:00:00Z")?.writer, "takeuchi"));
it("癖の記録（source=style）は端末の記録と数えない", () => eq(deviceWriterOfWindow([W("staff", "2026-11-16T02:00:00Z", "takeuchi", "style")], "2026-11-16T01:00:00Z", null), null));
it("スイッチは既定 off", () => { eq(watchWriterDeviceFirstOn({}), false); eq(watchWriterDeviceFirstOn({ WATCH_WRITER_DEVICE_FIRST: "on" }), true); });

console.log("repeat-brain-align ACK_PICKUP_AIX_PATH");
// 実物の形（60日の監査の お礼・了承 × 前のピックアップの約束 の番・伏せ字）
const pickupTurn = [
  { sender: "staff", text: "〇〇様ご連絡ありがとうございます！！\n頂いた条件で今お部屋ピックアップさせて頂いております！！\nピックアップ出来次第お送りさせて頂きます！！", created_at: "2026-10-15T21:40:00Z" },
  { sender: "customer", text: "ありがとうございます！よろしくお願いします", created_at: "2026-10-15T22:12:00Z" },
];
const f = ackFormFacts(pickupTurn);
it("ピックアップの約束への了承だけ（読みの前提）", () => { eq(f?.family, "探す"); eq(f?.customer, "了承だけ"); });
it("off（既定）: 道の行は足さない＝今と1文字も変わらない", () => { eq(ackConfirmAixPathLine(f, {}), ""); eq(ackFormMaterialLine(f, {}).includes("物件の AIX"), false); });
it("on: 道は物件の AIX のままの1行", () => { const x = ackConfirmAixPathLine(f, { ACK_PICKUP_AIX_PATH: "on" }); eq(x.includes("property_send"), true); eq(x.includes("道は変えない"), true); });
it("on: ブレインの材料の行にも入る", () => eq(ackFormMaterialLine(f, { ACK_PICKUP_AIX_PATH: "on" }).includes("約束を果たす物件の AIX"), true));
it("on でも決定 C に戻している時（ACK_AFTER_PROMISE_REPLY=on）は足さない", () => eq(ackConfirmAixPathLine(f, { ACK_PICKUP_AIX_PATH: "on", ACK_AFTER_PROMISE_REPLY: "on" }), ""));
it("on でも作業員M の BRAIN_FULFIL_TURN=on の時は足さない（同じ材料を2つ並べない）", () => eq(ackConfirmAixPathLine(f, { ACK_PICKUP_AIX_PATH: "on", BRAIN_FULFIL_TURN: "on" }), ""));
it("on でも約束の後に締め（お気軽に）がある番は足さない（q111 と同じ線）", () => {
  const g = ackFormFacts([{ sender: "staff", text: "ピックアップ出来次第お送りさせて頂きます！！\n気になる点ございましたらお気軽にご連絡ください！！", created_at: "2026-10-15T21:40:00Z" }, { sender: "customer", text: "ありがとうございます", created_at: "2026-10-15T22:12:00Z" }]);
  eq(ackConfirmAixPathLine(g, { ACK_PICKUP_AIX_PATH: "on" }), "");
});
it("確認の約束の行（ACK_CONFIRM_AIX_PATH）は今のまま", () => {
  const g = ackFormFacts([{ sender: "staff", text: "募集状況確認させて頂きます！！\n確認出来次第ご連絡させて頂きます！！", created_at: "2026-11-09T07:00:00Z" }, { sender: "customer", text: "ありがとうございます", created_at: "2026-11-09T07:52:00Z" }]);
  eq(ackConfirmAixPathLine(g, {}).includes("property_check_result"), true);
});

console.log("repeat-brain-align ACK_FORM_COUNT_WITH_AIX");
it("off（既定）: 材料の行は今と同じ（AIX を入れた数の行が無い）", () => { eq(ackFormAixShareLine(f!, {}), ""); eq(ackFormMaterialLine(f, {}).includes("AIX を送った番も入れた数"), false); });
it("on: ピックアップの約束の番は 68 → AIX 46 の行が、返信の形の数より先に入る", () => { const x = ackFormMaterialLine(f, { ACK_FORM_COUNT_WITH_AIX: "on" }); eq(x.includes("ピックアップの約束だけの番 68 → 最初の一手が約束を果たす AIX 46"), true); eq(x.indexOf("AIX 46") < x.indexOf("待ちの形の1文 7"), true); });
it("on: 確認の約束の番は 21 → AIX 14", () => {
  const g = ackFormFacts([{ sender: "staff", text: "募集状況確認させて頂きます！！\n確認出来次第ご連絡させて頂きます！！", created_at: "2026-11-09T07:00:00Z" }, { sender: "customer", text: "ありがとうございます", created_at: "2026-11-09T07:52:00Z" }]);
  eq(ackFormMaterialLine(g, { ACK_FORM_COUNT_WITH_AIX: "on" }).includes("確認の約束だけの番 21"), true);
});

console.log("brain-prompt-rules-1112 BRAIN_RULE6_OPEN_PROMISE");
{
  const src = readFileSync(join(__dirname, "..", "brain-core.ts"), "utf8");
  it("旧の⑥の太字の1文が brain-core に一字一句ある（差し替えが当たる）", () => eq(src.includes(RULE6_OPEN_PROMISE_EDIT.from), true));
  it("brain-core は旧の⑥を applyRule6OpenPromise に通している", () => eq(/RULE6_FACTS : applyRule6OpenPromise\("ルール⑥/.test(src), true));
  const sample = `ルール⑥（感謝・了承への返し方）: … ${RULE6_OPEN_PROMISE_EDIT.from}。成約会話の…`;
  it("off（既定）: 1文字も変わらない", () => { eq(applyRule6OpenPromise(sample, {}), sample); eq(rule6OpenPromiseOn({}), false); });
  it("on: 約束が開いている番は約束を果たす AIX のまま・開いていない番は null", () => { const x = applyRule6OpenPromise(sample, { BRAIN_RULE6_OPEN_PROMISE: "on" }); eq(x.includes("約束を果たす AIX のままにする"), true); eq(x.includes("開いていない番は aix フィールドを null"), true); eq(x.includes(RULE6_OPEN_PROMISE_EDIT.from), false); });
  it("on でも元の文が無い（BRAIN_RULES_678_FACTS=on の⑥）時は何もしない", () => eq(applyRule6OpenPromise("ルール⑥（感謝・了承だけの番・事実の材料）", { BRAIN_RULE6_OPEN_PROMISE: "on" }), "ルール⑥（感謝・了承だけの番・事実の材料）"));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
