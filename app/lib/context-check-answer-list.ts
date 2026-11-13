// 最終チェックの文脈の点検（context_check・Sonnet）に渡す「答えるべき項目の一覧」（2026-10-13 竹内さん・ブレインの使い残し 5・純関数）
//
// 旧: context_check は「顧客の質問を全て列挙し…」と自分で会話を読み直して質問を探し、MISSED_QUESTION を出していた。
//   ブレインはこの番の依頼ごとの答え方（turn_contract＝返信／約束／AIX／触れない）を既に決めている（brainBaselineNote に本質として入る）が、
//   質問の取りこぼしの物差しは LLM が自分で作り直す＝ブレインと逆の指摘（約束・AIX の番に「答えていない」）→ 書き直しが起きる。
// 新: ブレインの本質がある時は、一覧を MISSED_QUESTION の物差しにする（route=返信 の項目だけ本文で答えているかを見る・一覧に無い質問を探さない）。
//   [ANALYSIS]（会話の分析の JSON）は一覧がある時は短く（読み直しを減らす）。戻す: CONTEXT_CHECK_ANSWER_LIST=off
import type { TurnContract } from "@/app/lib/turn-contract";

type Env = Record<string, string | undefined>;
export function contextCheckAnswerListEnabled(env: Env = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.CONTEXT_CHECK_ANSWER_LIST ?? "").trim().toLowerCase() !== "off";
}

const ROUTE_SHORT: Record<string, string> = { reply: "返信で答える", promise: "約束だけ（答えの中身は後で AIX）", aix: "AIX の番（中身は本文に書かない）", none: "触れない" };

/** ブレインの本質から一覧の欄を作る（本質が無い・ブレインでない・項目が無い時は空） */
export function buildContextCheckAnswerList(c: TurnContract | null | undefined, customerQuestions?: ReadonlyArray<string> | null, env?: Env): string {
  if (!contextCheckAnswerListEnabled(env)) return "";
  if (!c || c.source !== "brain") return "";
  if (!c.asks.length && !c.closeOnly) return "";
  const L: string[] = ["【答えるべき項目の一覧（ブレインがこの番の会話を読んで決めた・MISSED_QUESTION の物差し）】"];
  if (c.closeOnly) L.push("- 返事の要らない番（受けの一言＋締めだけ）。質問の取りこぼし・行動宣言の不足は指摘しない");
  c.asks.forEach((a, i) => L.push(`- ${i + 1}. 「${a.quote}」→ ${ROUTE_SHORT[a.route] ?? a.route}${a.answer ? `：${a.answer}` : ""}`));
  const extra = (customerQuestions ?? []).map((q) => String(q ?? "").trim()).filter((q) => q && !c.asks.some((a) => a.quote.includes(q) || q.includes(a.quote)));
  if (extra.length) L.push(`- ブレインが読んだお客様の質問（一覧の補い）: ${extra.slice(0, 4).map((q) => `「${q}」`).join(" ")}`);
  L.push("質問の取りこぼし（検査1）はこの一覧で見る: 「返信で答える」の項目に本文が答えていない時だけ MISSED_QUESTION。"
    + "一覧に無い質問を会話から探し直して指摘しない。「約束だけ」「AIX の番」「触れない」の項目は本文で答えていなくても指摘しない（約束の一文があれば足りる）。");
  return `${L.join("\n")}\n\n`;
}

/** 一覧がある時の [ANALYSIS] の長さ（読み直しを減らす）。無い時は今まで通り 2500 */
export function contextCheckAnalysisLimit(hasList: boolean): number {
  return hasList ? 1200 : 2500;
}
