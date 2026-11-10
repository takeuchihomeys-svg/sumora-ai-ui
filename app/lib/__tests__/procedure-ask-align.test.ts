// 手続きの一般の問いで返信に決めた番の依頼の答え方をそろえる（app/lib/procedure-ask-align.ts）のテスト（自己完結ハーネス）
// 文は実物: q374（c024b7b9 10/26「最短入居日どのくらいですね」）・q375（同 10/20「最短でどのくらいで入居までいけますか」）・
//   試験 proc-points-on-1108b の q374 でブレインが書いた読み「最短入居日はどのくらいですか？」・q092（物件を探す依頼は触らない）
// 実行: PROCEDURE_MOVE_IN_WIDE=on npx tsx app/lib/__tests__/procedure-ask-align.test.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { alignProcedureAsks, alignProcedurePriorities, isProcedureAskText, procedureGeneralAskReplyOn } from "../procedure-ask-align";

let passed = 0, failed = 0;
function it(name: string, fn: () => void) { try { fn(); passed++; } catch (e) { failed++; console.log(`✕ ${name}: ${(e as Error).message}`); } }
function eq(a: unknown, b: unknown) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${JSON.stringify(a)} !== ${JSON.stringify(b)}`); }

process.env.PROCEDURE_MOVE_IN_WIDE = "on";

it("スイッチは既定 off", () => { eq(procedureGeneralAskReplyOn({}), false); eq(procedureGeneralAskReplyOn({ PROCEDURE_GENERAL_ASK_REPLY: "on" }), true); });
it("q374 q375 の文は手続きの問い", () => {
  eq(isProcedureAskText("最短入居日どのくらいですね"), true);
  eq(isProcedureAskText("ありがとうございます😭\n最短でどのくらいで入居までいけますか"), true);
  eq(isProcedureAskText("最短入居日はどのくらいですか？"), true);
});
it("物件を探す依頼・費用は手続きの問いでない", () => {
  eq(isProcedureAskText("10月後半くらいに入れる物件はありますか？"), false);
  eq(isProcedureAskText("初期費用もう少し安くなりませんか"), false);
});

const tc = () => ({ asks: [
  { quote: "最短入居日はどのくらいですか？", route: "promise", answer: "確認しご連絡", aix: "property_check_result" },
  { quote: "10月後半くらいに入れる物件はありますか？", route: "promise", answer: "ご条件でピックアップしお送り" },
], must_not: [] });

it("on・返信の番: 手続きの問いだけ reply に・他の約束は残す", () => {
  const r = alignProcedureAsks(tc(), { on: true, replyTurn: true });
  eq(r.changed, 1);
  const a = (r.contract as { asks: Array<{ route: string; basis?: string; aix?: unknown }> }).asks;
  eq([a[0].route, a[0].basis, a[0].aix], ["reply", "company_fact", null]);
  eq(a[1].route, "promise");
});
it("off は何もしない", () => { const x = tc(); const r = alignProcedureAsks(x, { on: false, replyTurn: true }); eq(r.changed, 0); eq(r.contract === x, true); });
it("返信の番でない（AIX・2段）は何もしない", () => { eq(alignProcedureAsks(tc(), { on: true, replyTurn: false }).changed, 0); });
it("既に reply の項目・null は触らない", () => {
  eq(alignProcedureAsks({ asks: [{ quote: "最短入居日はどのくらいですか？", route: "reply" }] }, { on: true, replyTurn: true }).changed, 0);
  eq(alignProcedureAsks(null, { on: true, replyTurn: true }).contract, null);
});

it("優先の項目: confirm → answer_now（手続きの問いだけ）", () => {
  const items = [
    { rank: 1, kind: "asked" as const, item: "最短入居日", quote: "最短入居日はどのくらいですか？", handling: "confirm" as const, aix: null, reason: "管理会社に確認" },
    { rank: 2, kind: "asked" as const, item: "物件を探す", quote: "10月後半くらいに入れる物件はありますか？", handling: "confirm" as const, aix: null, reason: "" },
  ];
  const r = alignProcedurePriorities(items, { on: true, replyTurn: true });
  eq(r.changed, 1);
  eq(r.items!.map((p) => p.handling), ["answer_now", "confirm"]);
  eq(alignProcedurePriorities(items, { on: false, replyTurn: true }).changed, 0);
});

it("配線: brain-core が turn_contract と優先の項目の両方で呼ぶ（返信に決めた番の条件つき）", () => {
  const src = readFileSync(join(__dirname, "..", "brain-core.ts"), "utf8");
  eq(/procedureAlignContract\(reconcileTurnContractWithAix\(/.test(src), true);
  eq(/alignProcedurePriorities\(priorityItems, \{ on: procedureGeneralAskReplyOn\(\), replyTurn: procedureDecision === "reply" && !finalAix && !twoStage \}\)/.test(src), true);
  eq(/procedureDecision === "reply" && !finalAix && !twoStage, conversationId\)/.test(src), true);
});

console.log(`procedure-ask-align: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
