// 2026-10-21 相手の頭の中・反応の予想（customer-reaction-predict.ts）
// 実行: npx tsx app/lib/__tests__/customer-reaction-predict.test.ts
// 文は実物の形（名前・物件名は伏せた・scripts/audit-reaction-predict.ts で読んだ物）
import {
  classifyCustomerBurst, draftKindOf, readCustomerMind, predictReaction, reactionRisk, buildReactionNote, reactionPredictEnabled, isDownMood,
} from "../customer-reaction-predict";
import type { ReactionTable } from "../customer-reaction-table-data";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function eq<T>(a: T, b: T, msg = "") { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg} 期待 ${JSON.stringify(b)} 実際 ${JSON.stringify(a)}`); }
function ok(v: unknown, msg = "") { if (!v) throw new Error(msg || "false"); }

const T: ReactionTable = {
  builtAt: "", days: 0,
  all: { question: 40, thanks: 30, silent: 10 },
  byNow: { thanks: { thanks: 30, question: 20, silent: 10 }, question: { question: 30, thanks: 25 } },
  byNowDraft: {
    "thanks|answer": { thanks: 20, question: 10, silent: 10 },
    "thanks|ask": { question: 15, thanks: 10, silent: 2 },
    "question|answer": { thanks: 30, question: 20, silent: 5 },
  },
  byMoodDraft: { "down|push": { thanks: 15, stall: 3, silent: 3, question: 5 }, "down|answer": { thanks: 20, silent: 2, question: 8 } },
};
const at = (h: number) => new Date(Date.UTC(2026, 9, 1, h)).toISOString();

console.log("classifyCustomerBurst");
it("質問", () => eq(classifyCustomerBurst(["ありがとうございます", "この二つは猫おっけいですか？"]), "question"));
it("依頼も質問に入れる", () => eq(classifyCustomerBurst(["もう一個調べて頂きたい物件ございまして"]), "question"));
it("ポータルの画面の持ち込み", () => eq(classifyCustomerBurst(["[画像] 【物件の画面（ポータル）】 ○○ 1K"]), "question"));
it("お礼", () => eq(classifyCustomerBurst(["調べて頂きありがとうございます🙇‍♂️"]), "thanks"));
it("内覧の日時を出す＝進む", () => eq(classifyCustomerBurst(["その時間でお願いします！", "13：00〜可能です"]), "proceed"));
it("検討＝止まる", () => eq(classifyCustomerBurst(["ちょっと検討します"]), "stall"));
it("不満", () => eq(classifyCustomerBurst(["ちょっと高すぎますね"]), "complaint"));
it("画像だけ＝その他", () => eq(classifyCustomerBurst(["[画像]"]), "other"));

console.log("draftKindOf");
it("内覧を勧める", () => eq(draftKindOf("ぜひご内覧いかがでしょうか😊"), "push"));
it("確認の約束", () => eq(draftKindOf("管理会社に確認してご連絡させて頂きます！！"), "promise"));
it("こちらから聞く", () => eq(draftKindOf("ご希望のエリアはございますか？"), "ask"));
it("答えだけ", () => eq(draftKindOf("ペット可となります！！"), "answer"));

console.log("readCustomerMind / predictReaction / reactionRisk");
const msgs = [
  { sender: "staff", text: "お部屋お送りさせて頂きました🌟", createdAt: at(1) },
  { sender: "customer", text: "ありがとうございます！", createdAt: at(2) },
];
it("お客様の番だけ読む", () => { eq(readCustomerMind([...msgs, { sender: "staff", text: "はい", createdAt: at(3) }]), null); ok(readCustomerMind(msgs)); });
it("お礼の番の頭の中", () => { const m = readCustomerMind(msgs)!; eq(m.now, "thanks"); eq(m.temperature, "中"); });
it("数が足りる時は今回×下書き", () => { const p = predictReaction("thanks", "ask", T); eq(p.level, "now+draft"); eq(p.likely, "question"); });
it("数が足りない時は今回だけに戻る", () => { const p = predictReaction("thanks", "property", T); eq(p.level, "now"); eq(p.likely, "thanks"); });
it("迷いの時に勧める＝pushy", () => {
  const m = readCustomerMind([{ sender: "staff", text: "ご内覧いかがでしょうか", createdAt: at(1) }, { sender: "customer", text: "うーん、ちょっと迷ってます", createdAt: at(2) }])!;
  ok(isDownMood(m), "下向き");
  const r = reactionRisk(m, "ぜひ今週末ご内覧いかがでしょうか😊", T);
  ok(r.kinds.includes("pushy"), JSON.stringify(r)); ok(r.risk > 0.2, String(r.risk));
});
it("下書きが無い時も信号は出る（下書き前の恐れ）", () => { const r = reactionRisk(readCustomerMind(msgs)!, null, T); eq(r.draft, null); ok(r.risk >= 0); });

console.log("buildReactionNote / スイッチ");
it("お礼の番: 返し方ごとの差を1行で", () => {
  const n = buildReactionNote(readCustomerMind(msgs), T);
  ok(n.includes("【相手の頭の中・反応の予想"), n); ok(n.includes("こちらから聞く"), n); ok(n.split("\n").filter((l) => l.startsWith("- ")).length <= 2, n);
});
it("確認の約束は比べに入れない", () => ok(!buildReactionNote(readCustomerMind(msgs), T).includes("確認して後で送る約束")));
it("画像だけの番は出さない", () => eq(buildReactionNote(readCustomerMind([{ sender: "customer", text: "[画像]", createdAt: at(1) }]), T), ""));
it("既定 off", () => { eq(reactionPredictEnabled({}), false); eq(reactionPredictEnabled({ BRAIN_REACTION_PREDICT: "on" }), true); });

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
