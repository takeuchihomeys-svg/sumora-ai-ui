// app/lib/__tests__/context-check-answer-list.test.ts — 2026-10-13 最終チェックの文脈の点検にブレインの答えるべき項目の一覧
//   実行: npx tsx app/lib/__tests__/context-check-answer-list.test.ts
import { buildContextCheckAnswerList, contextCheckAnalysisLimit } from "../context-check-answer-list";
import type { TurnContract } from "../turn-contract";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`); } };

const base: TurnContract = { asks: [], leadWith: null, closeOnly: false, mustNot: [], proposals: [], alreadySaid: [], settled: [], feeling: { kind: null, acknowledge: false }, humanChecks: [], source: "brain" };
const c: TurnContract = { ...base, asks: [
  { quote: "駐車場はありますか", topic: "equipment" as never, kind: "question", route: "reply", answer: "資料どおり敷地内に1台", basis: "material", aixKey: null },
  { quote: "初期費用いくらですか", topic: "cost" as never, kind: "question", route: "promise", answer: "最大限割引の御見積書を作成しお送り", basis: null, aixKey: null },
] };
const s = buildContextCheckAnswerList(c, ["駐車場はありますか", "ペットは何匹まで"], {});
t("一覧に項目と答え方", /駐車場はありますか」→ 返信で答える/.test(s) && /初期費用いくらですか」→ 約束だけ/.test(s));
t("一覧に無いブレインの質問は補いで1つ", /ペットは何匹まで/.test(s) && (s.match(/駐車場はありますか/g) ?? []).length === 1);
t("物差しの指示", /一覧に無い質問を会話から探し直して指摘しない/.test(s));
t("閉じる番", /返事の要らない番/.test(buildContextCheckAnswerList({ ...base, closeOnly: true }, null, {})));
t("ブレインでない本質は空", buildContextCheckAnswerList({ ...c, source: "ledger" }, null, {}) === "");
t("本質が無ければ空", buildContextCheckAnswerList(null, null, {}) === "");
t("戻す（off）は空", buildContextCheckAnswerList(c, null, { CONTEXT_CHECK_ANSWER_LIST: "off" }) === "");
t("一覧がある時は分析を短く", contextCheckAnalysisLimit(true) === 1200 && contextCheckAnalysisLimit(false) === 2500);
console.log(`\n${pass} pass / ${fail} fail`);
if (fail) process.exit(1);
