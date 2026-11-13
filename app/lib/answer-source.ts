// app/lib/answer-source.ts — 答えに使う事実の出所の名前の正と、読み替えの1か所（純関数・作業員22・2026-11-13・統括役の決め）
//
// 2つに割れていた名前:
//   ・作業員16 の ANSWER_SOURCES（brain-now-later.ts・ブレインの now_vs_later.answer_source・作業員7b の ask-parts の parts[].source）: company_fact／material_value／staff_only／none
//   ・作業員10 の文の側の AnswerSource: material・record・conversation・company_fact・general・staff_only・checked_result
// 決め（統括役 11/13）: 細かい方の7つを正にする。staff_only の中は作業員7b の who（mgmt＝管理会社／rep＝代表・社内の判断／phone＝電話）で分ける。
//   16 の4つと、判断のブレインの turn_contract.asks[].basis（conversation・material・company_fact・general・judgement）からの読み替えは、このファイルにだけ置く（あちこちに作らない）。
//   ブレインへの指示の文（now_vs_later の answer_source・ask-parts の source）は変えない（16 の一覧は残し、読む側がここで読み替える）。既定の動きは変えない。

export const ANSWER_SOURCE_KINDS = ["material", "record", "conversation", "company_fact", "general", "staff_only", "checked_result"] as const;
export type AnswerSourceKind = typeof ANSWER_SOURCE_KINDS[number];
export const ANSWER_SOURCE_JA: Record<AnswerSourceKind, string> = {
  material: "資料の値", record: "物件の記録（送った物・確認済み）", conversation: "会話で分かっている事", company_fact: "会社の事実", general: "一般の事",
  staff_only: "スタッフだけ", checked_result: "確かめた結果",
};
/** 作業員7b の ask-parts の PART_WHO と同じ3つ（ask-parts がここを読むので、ここでは写して持つ・テストで一致を確かめる） */
export const STAFF_WHO = ["mgmt", "rep", "phone"] as const;
export type StaffWho = typeof STAFF_WHO[number];
export const STAFF_WHO_JA: Record<StaffWho, string> = { mgmt: "管理会社", rep: "代表・社内の判断", phone: "電話で確かめる" };
export type AnswerSource = { kind: AnswerSourceKind; who?: StaffWho };

/** 出所の印（読み替えの手がかり）。material_value の中を資料・記録・会話に分け、確かめた結果があれば staff_only を checked_result にする */
export type SourceHint = { basis?: unknown; record?: boolean; checkResultReady?: boolean; who?: unknown };
const whoOf = (w: unknown): StaffWho | undefined => ((STAFF_WHO as readonly string[]).includes(String(w)) ? (String(w) as StaffWho) : undefined);

/** 作業員16 の4つ（company_fact／material_value／staff_only／none）→ 7つ */
export function fromBrainAnswerSource(s: unknown, hint: SourceHint = {}): AnswerSource {
  switch (String(s ?? "")) {
    case "company_fact": return { kind: "company_fact" };
    case "material_value": return { kind: hint.record ? "record" : String(hint.basis ?? "") === "conversation" ? "conversation" : "material" };
    case "staff_only": return hint.checkResultReady ? { kind: "checked_result" } : { kind: "staff_only", ...(whoOf(hint.who) ? { who: whoOf(hint.who) } : {}) };
    default: return { kind: "general" };
  }
}
/** 判断のブレインの turn_contract.asks[].basis と道 → 7つ（basis が無く確かめる約束・スタッフの番なら staff_only・確かめた結果が手元なら checked_result） */
export function fromContractBasis(basis: unknown, route: unknown, hint: SourceHint = {}): AnswerSource {
  const b = String(basis ?? "");
  if (b === "material") return { kind: hint.record ? "record" : "material" };
  if (b === "conversation") return { kind: "conversation" };
  if (b === "company_fact") return { kind: "company_fact" };
  if (b === "general") return { kind: "general" };
  if (hint.checkResultReady) return { kind: "checked_result" };
  if (route === "promise" || route === "aix" || b === "judgement" || !b) return { kind: "staff_only", ...(whoOf(hint.who) ? { who: whoOf(hint.who) } : {}) };
  return { kind: "general" };
}
/** 文に書く名前（staff_only は who まで） */
export const answerSourceLabel = (s: AnswerSource): string => (s.kind === "staff_only" && s.who ? `${ANSWER_SOURCE_JA.staff_only}（${STAFF_WHO_JA[s.who]}）` : ANSWER_SOURCE_JA[s.kind]);

/** この番に確かめた結果が手元にあるか（now_vs_later.ready_now に「確認の結果」）。あれば staff_only を checked_result に読み替える（作業員16 の注意・11/13） */
export function checkResultReadyOf(meta: Record<string, unknown> | null | undefined): boolean {
  const nl = meta && typeof meta.now_vs_later === "object" && meta.now_vs_later ? (meta.now_vs_later as { ready_now?: unknown }) : null;
  return Array.isArray(nl?.ready_now) && (nl!.ready_now as unknown[]).some((x) => /確認の結果/.test(String(x)));
}
