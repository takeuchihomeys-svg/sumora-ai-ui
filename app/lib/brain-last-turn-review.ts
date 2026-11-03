// app/lib/brain-last-turn-review.ts — 前回の提案の振り返り（②スタッフが判断を変えた事・⑤前回の提案が当たったか・お客様は進んだか）（純関数・DB 依存なし）
//
// 2026-11-03 竹内さんの決定（KB P1「ブレインに4つ足す」の②⑤）・作業員1:
//   ② スタッフが提案と違う AIX・返信を選んだ事を、その会話の次の番からブレインに1行で渡す（「前回 物件確認した を勧めたが、スタッフは 見積書 を押した」）。
//      竹内さんの番は重く扱う（竹内基準）。スタッフの押し間違いもあるので正解扱いにせず「違った事実」として渡す。
//   ⑤ 次の番の最初に前回の提案が当たったか（スタッフが同じ物を押したか）・お客様は進んだか（段階が前に進んだか）を1行で確かめる。外れていれば理由を考えてから判断する。
//   材料: 前回の判断の記録（brain_decision_logs の suggested_action・suggested_reply_mode・digest.st＝その時の段階）と、その後のスタッフの押下（aix_usage_logs）・手打ち（messages）。
//   記録: digest.rv（当たり・違い・書き手・進んだか）＝毎晩数える。切替: BRAIN_LAST_TURN_REVIEW（既定 off）
import { aixContentFamily } from "./line-watch-judge";

type Env = Record<string, string | undefined>;
export function brainLastTurnReviewOn(env: Env = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.BRAIN_LAST_TURN_REVIEW ?? "").trim().toLowerCase() === "on";
}

export type PrevDecision = { at: string; action: string | null; replyMode: string | null; stage: string | null };
export type StaffActAfter = { at: string; kind: "aix" | "text"; aixType: string | null; writer: string | null };
export type LastTurnReview = {
  /** 前回の提案（AIX の名前か「返信」） */
  prev: string;
  /** スタッフが実際にした事（最初の一手） */
  staff: string | null;
  /** 当たり: same（同じ AIX・同じ系統）／reply_ok（返信を勧めて手打ち）／diff（違う）／none（スタッフがまだ何もしていない） */
  match: "same" | "reply_ok" | "diff" | "none";
  writer: "takeuchi" | "employee" | null;
  /** お客様は進んだか（段階が前に進んだ・同じ・戻った・分からない） */
  progress: "forward" | "same" | "back" | "unknown";
};

/** 段階の並び（customer-state の stage） */
const STAGE_ORDER = ["first", "searching", "proposing", "interested", "estimate_sent", "viewing_arranging", "viewing_scheduled", "viewed", "apply_prep", "applying", "won"];
function stageRank(s: string | null | undefined): number { return String(s ?? "") === "dropped" ? -1 : STAGE_ORDER.indexOf(String(s ?? "")); }

export function reviewLastTurn(o: { prev: PrevDecision | null; actsAfter: readonly StaffActAfter[]; stageNow: string | null }): LastTurnReview | null {
  if (!o.prev) return null;
  const prevAix = o.prev.replyMode === "aix" && o.prev.action ? o.prev.action : null;
  const prevLabel = prevAix ?? "返信";
  const acts = [...o.actsAfter].filter((a) => Date.parse(a.at) > Date.parse(o.prev!.at)).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const firstAix = acts.find((a) => a.kind === "aix");
  const first = firstAix ?? acts[0] ?? null;
  let match: LastTurnReview["match"] = "none";
  if (first) {
    if (prevAix) match = firstAix && (firstAix.aixType === prevAix || aixContentFamily(firstAix.aixType) === aixContentFamily(prevAix)) ? "same" : "diff";
    else match = firstAix ? "diff" : "reply_ok";
  }
  const writer = first?.writer === "takeuchi" ? "takeuchi" : first?.writer === "employee" ? "employee" : null;
  const a = stageRank(o.prev.stage), b = stageRank(o.stageNow);
  const progress: LastTurnReview["progress"] = a < 0 || b < 0 ? "unknown" : b > a ? "forward" : b === a ? "same" : "back";
  return { prev: prevLabel, staff: first ? (first.kind === "aix" ? first.aixType : "返信（手打ち）") : null, match, writer, progress };
}

const PROGRESS_JA: Record<LastTurnReview["progress"], string> = { forward: "前に進んだ", same: "同じ段階", back: "戻った", unknown: "分からない" };

/** ブレインに渡す1行（無ければ ""）。名前は AIX の名前を呼ぶ側で日本語にして渡す */
export function lastTurnReviewLine(r: LastTurnReview | null, ja: (k: string) => string): string {
  if (!r || r.match === "none") return "";
  const who = r.writer === "takeuchi" ? "竹内さん（社長・基準）" : r.writer === "employee" ? "スタッフ" : "スタッフ";
  const prev = r.prev === "返信" ? "返信" : ja(r.prev);
  const staff = r.staff == null ? "" : r.staff === "返信（手打ち）" ? "手打ちの返信" : ja(r.staff);
  const head = r.match === "same" || r.match === "reply_ok"
    ? `前回の提案（${prev}）は当たった（${who}も${staff}）`
    : `前回は ${prev} を勧めたが、${who}は ${staff} を選んだ（違った事実${r.writer === "takeuchi" ? "・竹内さんの判断なので重く見る" : "・スタッフの押し間違いの時もある"}）`;
  const tail = r.match === "diff" ? "。今回は、なぜ違う手が選ばれたかを先に考えてから判断する" : "";
  return `【前回の提案の振り返り】${head}。お客様は${PROGRESS_JA[r.progress]}${tail}。`;
}

/** digest.rv（毎晩数える・短く） */
export function lastTurnReviewDigest(r: LastTurnReview | null): Record<string, unknown> | null {
  if (!r) return null;
  return { p: r.prev, s: r.staff, m: r.match, w: r.writer, g: r.progress };
}
