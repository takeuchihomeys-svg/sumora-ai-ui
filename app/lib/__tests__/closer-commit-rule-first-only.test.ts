// 条件の言い直しのセルの全力サポートも初回だけ（2026-11-06 作業員9・弱い所 322・q010・CLOSER_COMMIT_RULE_FIRST_ONLY）
// 実行: npx tsx app/lib/__tests__/closer-commit-rule-first-only.test.ts
import {
  analyzeSubstance, classifyLastStaffTurn, classifyCustomerResponse, resolveTurnPair, resolveCloser, predictCloserSignals,
  closerCommitRuleFirstOnlyOn, stripCommitSentence, buildTurnPairNote,
} from "../reply-context";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean, extra: unknown = "") => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`, extra); } };
const STAFF = "🌟メゾン難波 302号室\n家賃6.5万円\nお手隙の際にご査収ください😌！！";
const CUST = "ありがとうございます！やっぱり2LDKで枚方か高槻あたりで探してほしいです";
const run = (first: boolean) => {
  const staff = classifyLastStaffTurn(STAFF, { recentAixRows: [], lastStaffAt: "2026-11-05T06:25:00Z" });
  const sub = analyzeSubstance(CUST, undefined, { staffAskedQuestion: false });
  const customer = classifyCustomerResponse(sub, staff, {});
  const pair = resolveTurnPair(staff, customer, sub, STAFF, { customerName: "テスト" });
  const closer = resolveCloser(pair, { ...predictCloserSignals({}), hasConcreteDeclaration: true }, { customerName: "テスト", isFirstContact: first });
  return { pair, closer };
};
t("既定 off", closerCommitRuleFirstOnlyOn({}) === false);
delete process.env.CLOSER_COMMIT_RULE_FIRST_ONLY;
const off = run(false);
t("前提: 条件の言い直しのセル", off.pair.customer.kind === "condition_change", off.pair.customer.kind);
t("off: 2回目以降でも全力サポート（今まで通り）", off.closer.closer === "commit_until_found", off.closer);
process.env.CLOSER_COMMIT_RULE_FIRST_ONLY = "on";
const on = run(false);
t("on: 2回目以降は全力サポートを入れない", on.closer.closer === "none", on.closer);
const onFirst = run(true);
t("on: 初回は全力サポートのまま", onFirst.closer.closer === "commit_until_found", onFirst.closer);
const note = buildTurnPairNote(on.pair, CUST, "テスト", {});
t("on: 手本に全力サポートが残らない", !/全力でサポート|見つかるまで/.test(note), note.slice(0, 400));
delete process.env.CLOSER_COMMIT_RULE_FIRST_ONLY;
const noteOff = buildTurnPairNote(off.pair, CUST, "テスト", {});
t("off: 手本は今まで通り", /全力でサポート|見つかるまで/.test(noteOff));
const ex = "かしこまりました！！\n2LDKのご条件で、枚方周辺からテストさんにオススメ出来るお部屋新たにピックアップしてお送りさせて頂きます😌！！\nテストさんにご満足頂けるお部屋が見つかるまで全力でサポートさせて頂きます！！";
const st = stripCommitSentence(ex);
t("約束の行だけ外す", !/全力/.test(st) && st.includes("ピックアップしてお送り"), st);
const ex2 = "かしこまりました！！ピックアップしお送りさせて頂きます！！テストさんにご満足頂けるお部屋が見つかるまで全力でサポートさせて頂きます！！";
const st2 = stripCommitSentence(ex2);
t("1行の中でも約束の文だけ外す", !/全力/.test(st2) && st2.includes("ピックアップしお送り"), st2);
t("全部が約束なら元のまま", stripCommitSentence("全力でサポートさせて頂きます！！") === "全力でサポートさせて頂きます！！");
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
