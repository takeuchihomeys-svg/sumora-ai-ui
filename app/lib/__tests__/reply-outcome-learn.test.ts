// 2026-10-21 結果から学ぶ（reply-outcome-learn.ts）
// 実行: npx tsx app/lib/__tests__/reply-outcome-learn.test.ts
// 文は実物の形（名前・物件名は伏せた・scripts/audit-reply-outcome.ts --examples で読んだ物）
import {
  replyShapeOf, sceneAt, sceneFromCustomerStage, reliableCells, buildOutcomeNote, outcomeLearnEnabled, type OutcomeTable, type OutcomeCell,
} from "../reply-outcome-learn";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function eq<T>(a: T, b: T, msg = "") { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg} 期待 ${JSON.stringify(b)} 実際 ${JSON.stringify(a)}`); }
function ok(v: unknown, msg = "") { if (!v) throw new Error(msg || "false"); }

console.log("replyShapeOf");
it("受け止め＋内覧の誘い1文", () => eq(replyShapeOf("かしこまりました！！ こちらのお部屋は駅から徒歩5分で日当たりも良好です😊！！ よろしければご内覧可能ですのでご都合いかがでしょうか！！"), "answer_invite"));
it("ほぼ誘いだけ", () => eq(replyShapeOf("ご内見可能です！！ いかがでしょうか😊"), "invite"));
it("駐車場のご案内（内覧の誘いではない）は誘いにしない", () => ok(replyShapeOf("駐車場のご案内もさせて頂きますので、ご安心ください。ご希望条件を教えて頂けますか？") !== "invite"));
it("申込で抑える", () => eq(replyShapeOf("お部屋埋まってしまう前に先にお申込みで抑えることも可能です！！"), "apply"));
it("1番手の説明だけは勧めにしない", () => ok(replyShapeOf("2番手のお申込とは、現在1番手で別のお客様がお申込をされている状態となります！！") !== "apply"));
it("見積", () => eq(replyShapeOf("最大限割引した御見積書お送りさせて頂きます！！"), "estimate"));
it("物件（ピックアップ）", () => eq(replyShapeOf("🌟オススメ物件ピックアップさせて頂きました！！\nhttps://example.com/x"), "property"));
it("確認の約束", () => eq(replyShapeOf("管理会社に確認させて頂きます！！ 分かり次第ご連絡致します😊"), "promise"));
it("聞き返す", () => eq(replyShapeOf("ご希望の間取りはございますか？"), "ask"));
it("短い受け", () => eq(replyShapeOf("かしこまりました！！ よろしくお願いいたします😊！！"), "ack"));
it("答え・説明", () => eq(replyShapeOf("こちらのお部屋はペット可で、小型犬1匹まで飼育可能となっております！！ 敷金が1ヶ月追加となります！！"), "answer"));
it("画像だけは null", () => eq(replyShapeOf("[画像]"), null));

console.log("sceneAt / sceneFromCustomerStage");
it("物件送付前は条件を聞く段", () => eq(sceneAt(100, { propertySentAt: 200 }), "hearing"));
it("物件送付の後は内覧前", () => eq(sceneAt(300, { propertySentAt: 200 }), "proposing"));
it("内覧の予定の後", () => eq(sceneAt(300, { propertySentAt: 100, viewingAt: 250 }), "viewing"));
it("申込の後は対象外", () => eq(sceneAt(300, { appliedAt: 250 }), null));
it("本番の段階の写し", () => { eq(sceneFromCustomerStage("searching"), "hearing"); eq(sceneFromCustomerStage("estimate_sent"), "proposing"); eq(sceneFromCustomerStage("viewed"), "viewing"); eq(sceneFromCustomerStage("applying"), null); eq(sceneFromCustomerStage(null), null); });

const cell = (o: Partial<OutcomeCell>): OutcomeCell => ({ scene: "proposing", shape: "invite", n: 50, convs: 30, progress: 0.6, view14: 0.4, apply30: 0.3, reply7: 0.9, lift: 0.15, lo: 0.05, hi: 0.25, held: true, ...o });
const T: OutcomeTable = { builtAt: "", days: 365, turns: 1000, outcome: "progress", cells: [
  cell({}),
  cell({ shape: "answer_invite", lift: 0.08, lo: 0.01, hi: 0.15 }),
  cell({ shape: "apply", lift: 0.2, lo: -0.02, hi: 0.4 }), // 幅が 0 をまたぐ
  cell({ shape: "estimate", lift: 0.1, lo: 0.02, hi: 0.2, held: false }), // 新しい側で向きが逆
  cell({ shape: "ack", lift: 0.3, lo: 0.1, hi: 0.5, n: 20 }), // 数が足りない
  cell({ shape: "property", lift: -0.12, lo: -0.2, hi: -0.03 }),
  cell({ shape: "promise", lift: -0.15, lo: -0.25, hi: -0.05 }), // 約束は出さない
  cell({ scene: "hearing", shape: "ask", lift: -0.1, lo: -0.16, hi: -0.03 }), // 条件を聞く段の聞き返しは出さない
  cell({ scene: "hearing", shape: "apply", lift: 0.25, lo: 0.1, hi: 0.4 }),
] };
console.log("reliableCells / buildOutcomeNote");
it("言えるマスだけ（数・幅・新しい側で保たれた・約束を除く）", () => eq(reliableCells("proposing", T).map((c) => c.shape), ["invite", "answer_invite", "property"]));
it("条件を聞く段の聞き返しは出さない", () => eq(reliableCells("hearing", T).map((c) => c.shape), ["apply"]));
it("注記は1〜2行・進む形が先・止まる形は1つ", () => {
  const n = buildOutcomeNote("proposing", T);
  ok(n.includes("内覧の誘い") && n.includes("+15pt") && n.includes("物件を送る −12pt"), n);
  ok(n.indexOf("内覧の誘い") < n.indexOf("物件を送る"), "順");
  ok(n.includes("誘う・勧めるをやめる理由にはしない"), "営業の意図");
  eq(n.trim().split("\n").length, 2);
});
it("内覧の予定の後は申込30日で書く", () => ok(buildOutcomeNote("viewing", { ...T, cells: [cell({ scene: "viewing", shape: "apply" })] }).includes("30日で申込に進んだ")));
it("言えるマスが無ければ空", () => { eq(buildOutcomeNote("viewing", T), ""); eq(buildOutcomeNote(null, T), ""); });
it("スイッチは既定 off", () => { eq(outcomeLearnEnabled({}), false); eq(outcomeLearnEnabled({ BRAIN_OUTCOME_LEARN: "on" }), true); eq(outcomeLearnEnabled({ BRAIN_OUTCOME_LEARN: "shadow" }), false); });

console.log(`\n${passed} 通過・${failed} 失敗`);
if (failed) { for (const f of failures) console.log(" - " + f); process.exit(1); }
