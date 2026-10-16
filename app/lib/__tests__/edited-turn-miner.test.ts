// 2026-10-16 大きく直された番の拾い出し（edited-turn-miner.ts）。文は本番の形（名前・物件名は伏せた）
// 実行: npx tsx app/lib/__tests__/edited-turn-miner.test.ts
import { editTypesOf, mineReplyTurn, mineAixExample, staffValuesOf, weakSpotsOf, examSpecOf, compactMined, editedTurnMinerEnabled, convHash, needsLlmLabel, type ReplyTurnInput } from "../edited-turn-miner";
import { editLines } from "../edit-diff";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function eq<T>(a: T, b: T, label = "") { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${label} expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); }
function ok(v: unknown, label = "") { if (!v) throw new Error(`${label} expected truthy`); }

const base = (o: Partial<ReplyTurnInput>): ReplyTurnInput => ({
  conv: "11111111-2222-3333-4444-555555555555", at: "2026-10-12T05:00:00.000Z", scene: "question", sceneJa: "質問", writer: "takeuchi",
  customer: "", draft: "", sent: "", pressed: [], humanKinds: [], ...o,
});

console.log("editTypesOf");
it("AI が確認の約束・人はその場で答えた → promise_escape", () => {
  const t = editTypesOf("かしこまりました！！\n繁忙期の家賃について確認させて頂きます！！\n確認出来次第ご連絡させて頂きます！！", "1〜3月は繁忙期で家賃・礼金が高くなる傾向となります！！\n入居日が決まっていなければ今探すのがオススメです😊！！");
  ok(t.includes("promise_escape"), JSON.stringify(t));
  ok(t.includes("vague_promise_cut"), JSON.stringify(t));
});
it("人が締めと呼びかけの行を足した", () => {
  const t = editTypesOf("内覧のご予約承りました！！", "〇〇さん\n内覧のご予約承りました！！\n当日は何卒よろしくお願い致します！！");
  ok(t.includes("close_added") && t.includes("name_line_added"), JSON.stringify(t));
});
it("伴走の一文を人が消した → extra_cut", () => {
  const t = editTypesOf("かしこまりました！！\nピックアップ出来次第お送りさせて頂きます！！\n〇〇さんにご満足頂けるお部屋が見つかるまで全力でサポートさせて頂きます！！", "かしこまりました！！\nピックアップ出来次第お送りさせて頂きます！！");
  ok(t.includes("extra_cut"), JSON.stringify(t));
});
it("まったく別の文 → rewrite（量しか言えない＝LLM の候補）", () => {
  const t = editTypesOf("はい！！", "大阪市内の治安の良いエリアとなりますので2LDKの家賃相場が高いエリアとなります！！");
  ok(t.includes("rewrite"), JSON.stringify(t));
});
it("needsLlmLabel は量の型だけの時だけ", () => {
  eq(needsLlmLabel(["rewrite", "longer"]), true);
  eq(needsLlmLabel(["rewrite", "promise_escape"]), false);
});
it("editLines は消えた行・足した行の中身を返す", () => {
  const r = editLines("お部屋の募集状況確認させて頂きます\n確認出来次第ご連絡させて頂きます", "お部屋の募集状況確認させて頂きます\n駐車場は近くにコインパーキングがございます");
  eq(r.deleted.length, 1); eq(r.added.length, 1);
});

console.log("staffValuesOf");
it("会話に無い日時を人が書いた → staff_value:datetime（人しか知らない値）", () => {
  eq(staffValuesOf("内覧の日程を確認させて頂きます！！", "10/18 14:00にてご案内可能です！！", "内覧したいです"), ["staff_value:datetime"]);
});
it("会話に既にある日時は数えない（AI が落とした＝返信の外れ）", () => {
  eq(staffValuesOf("かしこまりました！！", "10/18 14:00でお待ちしております！！", "10/18 14:00でお願いします"), []);
});

console.log("mineReplyTurn");
it("小さな直し（近さ0.6以上）は拾わない", () => {
  eq(mineReplyTurn(base({ draft: "かしこまりました！！\nピックアップ出来次第お送りさせて頂きます！！", sent: "かしこまりました！！\nピックアップ出来次第お送りさせて頂きます😊！！" })), null);
});
it("大きく直した返信 → reply_edit・道は返信", () => {
  const t = mineReplyTurn(base({ customer: "繁忙期の方が高いですか？", draft: "確認させて頂きます！！確認出来次第ご連絡させて頂きます！！", sent: "1〜3月は繁忙期で家賃・礼金が高くなる傾向となります！！" }));
  ok(t); eq(t!.bucket, "reply_edit"); eq(t!.accept, ["返信"]); eq(t!.convHash, convHash(base({}).conv));
});
it("人しか知らない事を書いた番 → aix_turn（返信の外れに数えない）・道は AIX の族", () => {
  const t = mineReplyTurn(base({ draft: "募集状況確認させて頂きます！！", sent: "管理会社に確認させて頂きましたところ、現在募集中となります！！", humanKinds: ["check_reported"] }));
  ok(t); eq(t!.bucket, "aix_turn"); eq(t!.accept, ["AIX:property_check_result"]);
});
it("AIX を押した番 → aix_turn・道は押した AIX", () => {
  const t = mineReplyTurn(base({ draft: "ありがとうございます！！", sent: "", pressed: ["property_recommendation"] }));
  ok(t); eq(t!.bucket, "aix_turn"); eq(t!.accept, ["AIX:property_recommendation"]);
});
it("下書きが無い番は拾わない（手打ちは brain-gap-finder の持ち物）", () => {
  eq(mineReplyTurn(base({ draft: null, sent: "了解しました！！" })), null);
});

console.log("mineAixExample");
it("値（金額）を入れただけの直し → aix_turn（人が値を入れた）", () => {
  const t = mineAixExample({ conv: "c1", at: "2026-10-12T05:00:00Z", aixAction: "estimate_sheet", writer: "takeuchi", customer: "見積お願いします",
    draft: "初期費用は御見積書の通りとなります！！", sent: "初期費用は合計182,400円となります！！" });
  ok(t); eq(t!.bucket, "aix_turn"); ok(t!.humanKinds.includes("staff_value:money"));
});
it("文を書き直した → aix_text_edit", () => {
  const t = mineAixExample({ conv: "c1", at: "2026-10-12T05:00:00Z", aixAction: "property_send_new_arrival", writer: "employee", customer: "お願いします",
    draft: "新着で茨木、豊中周辺全域からオススメできる2Kのお部屋が4件募集にでました！！", sent: "北摂のエリアからペット飼育可能な1LDKの募集中のお部屋全てお送りさせて頂きました！！" });
  ok(t); eq(t!.bucket, "aix_text_edit");
});

console.log("weakSpotsOf / examSpecOf / compactMined");
const turns = [
  mineReplyTurn(base({ customer: "繁忙期の方が高いですか？", draft: "確認させて頂きます！！確認出来次第ご連絡させて頂きます！！", sent: "1〜3月は繁忙期で家賃・礼金が高くなる傾向となります！！" }))!,
  mineReplyTurn(base({ writer: "employee", customer: "繁忙期は？", draft: "確認させて頂きます！！確認出来次第ご連絡させて頂きます！！", sent: "繁忙期は家賃が高くなる傾向となります！！" }))!,
];
it("弱い所は箱×場面×型で束ね、関係する設計知見 id を持つ", () => {
  const w = weakSpotsOf(turns);
  const esc = w.find((x) => x.type === "promise_escape");
  ok(esc); eq(esc!.n, 2); eq(esc!.takeuchi, 1); ok(esc!.kb.includes("4363a9f6"));
});
it("試験の候補は竹内さんの番だけ・保留の型は「一般的な事を保留しない」・2段は言ってはいけない道", () => {
  const c = examSpecOf(turns[0], (s) => s);
  ok(c); eq(c!.type, "一般的な事を保留しない"); eq(c!.accept, ["返信"]); eq(c!.mustNot, ["2段"]); eq(c!.stage, "brain"); eq(c!.asks[0].route, "reply");
  eq(examSpecOf(turns[1], (s) => s), null);
});
it("試験の候補の文は渡した伏せ方を通る", () => {
  const c = examSpecOf(turns[0], (s) => s.replace(/繁忙期/g, "◯"));
  ok(!c!.asks[0].q.includes("繁忙期") && !c!.asks[0].point.includes("繁忙期"));
});
it("cron に残すまとめは文を持たない", () => {
  const j = JSON.stringify(compactMined(turns, { reply: 2, aix: 0 }));
  ok(!j.includes("繁忙期"), j);
});
it("EDITED_TURN_MINER=off で止まる", () => {
  eq(editedTurnMinerEnabled({ EDITED_TURN_MINER: "off" }), false);
  eq(editedTurnMinerEnabled({}), true);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log(`  ✗ ${f}`); process.exit(1); }
