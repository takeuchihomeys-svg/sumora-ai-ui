// app/lib/compose-decided.ts — ブレインと統括が決めた事を書き手まで届ける配線のスイッチと名前の表（純関数・作業員22・2026-11-13）
//
// 竹内さん 11/13（統括役経由）「文の要素（押さえ 34%・潜在 27%・信頼 43%）の一番の根は、ブレインと統括が決めた事が書き手まで届いていない事」。
//   KB 2301dbf1・5cf2d736。届き方の表（scripts/delivery-table.ts・本番30番）で分けた届かない所のうち、
//   c（渡しているが書き手の指示文で使われていない）と b（欄はあるが渡す配線が無い）を、言葉を足すのでなく配線と欄で塞ぐ。
// スイッチ: COMPOSE_DECIDED（既定 off＝書き手への注記は今と1文字も同じ）。塞ぐ順（統括役 11/13）:
//   1 設計図の注記が空の番（主の行が無い番＝本番 10/30）でも、受け取ったブレインの読み（重点・潜在…）の行は書き手に出す
//   2 本質の帯に答えに使う事実の出所（basis）を書く
//   3 設計図の従の行（潜在）に下の種類を書く（作業員5 の重点の下の種類 focus_sub に読み替え）
//   4 近い番の意見を、文の統括と書き手へ
// AIX 1通目・2通目への受け渡しは DECIDED_TO_AIX（既定 off・conductor-decided.decidedNote を使う）。
type Env = Record<string, string | undefined>;
const envOf = (): Env => (typeof process !== "undefined" ? process.env : {});
export const composeDecidedOn = (env: Env = envOf()): boolean => (env.COMPOSE_DECIDED ?? "").trim().toLowerCase() === "on";
export const decidedToAixOn = (env: Env = envOf()): boolean => (env.DECIDED_TO_AIX ?? "").trim().toLowerCase() === "on";

/** 潜在の下の種類（compose-sentence-plan の LATENT_KINDS）→ 作業員5 の重点の下の種類（meta.conductor_focus.focus_sub・ease の下）。無い物は null */
export const LATENT_TO_FOCUS_SUB: Readonly<Record<string, string | null>> = {
  審査: "screening", 費用: "cost", "入居日・時期": "timing", 先に取られる: null, "住み心地・周り": null, 物件が見つからない: null, 内覧できない: null, "対応・信頼": null, 事情の変化: null,
};
/** 作業員5 の focus_sub の値（2026-11-13 作業員5 から: promise_keep に report を足した） */
export const FOCUS_SUB_VALUES: Readonly<Record<string, readonly string[]>> = {
  promise_make: ["check", "search", "estimate"], promise_keep: ["fulfill_now", "report"], answer: ["fact", "compare", "ask_back"], ease: ["cost", "screening", "timing"],
};
export function latentKindLine(kind: string | null | undefined): string | null {
  if (!kind) return null;
  const sub = LATENT_TO_FOCUS_SUB[kind];
  return sub ? `${kind}（ease:${sub}）` : kind;
}

/**
 * 答えの確かさ（fact.certainty）: 言い切れる／基本的に／確認が要る（統括役 11/13・竹内さんの決定 79cf95c8「例外のある事を言い切らない（基本的に）」）。
 *   会社の事実のうち例外のある話題（申込の時期・キャンセル・SUUMO 等の掲載・虫・内覧後の見積）と一般の事＝基本的に／資料の値・会話で分かっている事・会社の事実の他＝言い切れる／
 *   出所が無い・確かめる約束・スタッフの番＝確認が要る。ただし確かめた結果が今手元にある（now_vs_later.ready_now に「確認の結果」）なら言い切れる。
 */
/** 名前は作業員10 の compose-value-slots（AnswerSource から決める certaintyOf）と同じ: assertable＝言い切れる／basically＝基本的に／needs_check＝確認が要る */
export type Certainty = "assertable" | "basically" | "needs_check";
export const CERTAINTY_JA: Record<Certainty, string> = { assertable: "言い切れる", basically: "基本的に", needs_check: "確認が要る" };
export const BASIC_TOPIC_RE = /申込|お申し?込|キャンセル|SUUMO|スーモ|ポータル|掲載|虫|見積/;
export function factCertaintyOf(a: { basis?: unknown; route?: unknown; quote?: unknown; answer?: unknown }, o: { checkResultReady?: boolean } = {}): Certainty {
  const b = String(a.basis ?? "");
  if (b === "material" || b === "conversation") return "assertable";
  if (b === "company_fact") return BASIC_TOPIC_RE.test(`${String(a.quote ?? "")} ${String(a.answer ?? "")}`) || /基本的に/.test(String(a.answer ?? "")) ? "basically" : "assertable";
  if (b === "general") return "basically";
  return o.checkResultReady ? "assertable" : "needs_check";
}

/**
 * 聞かれた事ごとの出所と、今言える部分／確認が要る部分（統括役 11/13・点検役の結果「答えに要る事実と出所の段が 19番中7番で粗い」）。
 *   出所: conversation＝会話／material＝資料／company＝会社の知識（会社の事実・一般）／staff_only＝スタッフだけ（管理会社・代表・電話で確かめる）。
 *   1つの依頼の答えに、言い切る文と確かめる約束の文が混ざる時は文で分ける（実例 12643: 「鍵交換は必須か」→ 必須です（今言える）／「外せるか」→ 管理会社に交渉（確認が要る））。
 *   1通に聞かれた事が複数ある時は、依頼（turn_contract.asks）ごとに1行（実例 12548 は4つ）。
 */
// 出所の名前は app/lib/answer-source.ts の7つ（統括役 11/13 の決め・読み替えはそこの1か所）
import { fromContractBasis, fromBrainAnswerSource, type AnswerSource } from "./answer-source";
/** 確かめる・交渉する・問い合わせる約束の文（今は言えない部分） */
export const CHECK_PART_RE = /確認(?:させて|致し|いたし|して|し(?:ご連絡|次第)|出来次第)|交渉(?:させて|致し|いたし|して|し)|問い?合わせ|お調べ|管理会社(?:に|へ)/;
export type AskPart = { quote: string; source: AnswerSource; now: string | null; check: string | null; certainty: Certainty };
/** 依頼ごとに、今言える部分と確認が要る部分を分ける（答えの文を句点で分け、確かめる約束の文を確認が要る側に） */
export function askPartsOf(asks: ReadonlyArray<{ quote?: unknown; basis?: unknown; route?: unknown; answer?: unknown; parts?: unknown }>, o: { checkResultReady?: boolean } = {}): AskPart[] {
  return asks.filter((a) => typeof a.quote === "string" && a.quote.trim()).map((a) => {
    const ans = typeof a.answer === "string" ? a.answer.trim() : "";
    const sents = ans.split(/(?<=[。！!？?])\s*|、(?=(?:[^、]*?)(?:確認|交渉|問い?合わせ|お調べ|管理会社))/).map((x) => x.trim()).filter(Boolean);
    const checkS = sents.filter((x) => CHECK_PART_RE.test(x)), nowS = sents.filter((x) => !CHECK_PART_RE.test(x));
    // 作業員7b の parts[]（ブレインが依頼を部分に分けた物・source は作業員16 の4つ）があれば、その部分ごとの出所と確かさを先に使う
    const parts = Array.isArray(a.parts) ? (a.parts as Array<{ part?: unknown; source?: unknown; certainty?: unknown; route?: unknown; who?: unknown }>) : [];
    if (parts.length) {
      const nowP = parts.filter((p) => p.certainty !== "needs_check" && p.source !== "staff_only"), chkP = parts.filter((p) => !nowP.includes(p));
      const src = fromBrainAnswerSource((nowP[0] ?? parts[0]).source, { basis: a.basis, checkResultReady: o.checkResultReady, who: (chkP[0] ?? parts[0]).who });
      return { quote: String(a.quote).trim().slice(0, 40), source: src, now: nowP.length ? nowP.map((p) => String(p.part ?? "")).join("・") : null, check: chkP.length ? chkP.map((p) => String(p.part ?? "")).join("・") : null, certainty: chkP.length && !nowP.length ? "needs_check" : (nowP[0]?.certainty === "basically" ? "basically" : "assertable") } as AskPart;
    }
    const source = fromContractBasis(a.basis, a.route, { checkResultReady: o.checkResultReady });
    const certainty = checkS.length && !nowS.length ? (o.checkResultReady ? "assertable" : "needs_check") : factCertaintyOf(a, o);
    return { quote: String(a.quote).trim().slice(0, 40), source, now: nowS.length ? nowS.join("") : null, check: checkS.length ? checkS.join("") : (a.route === "promise" && !nowS.length ? (ans || "確かめる") : null), certainty: source.kind === "staff_only" && !nowS.length && !o.checkResultReady ? "needs_check" : certainty };
  });
}
