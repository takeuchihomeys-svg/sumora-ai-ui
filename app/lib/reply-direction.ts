// app/lib/reply-direction.ts — 返信の下書きが向かった石（決まった計算・LLM なし・記録だけ）（台帳 #787）
// 2026-11-26 作業員A（統括役の頼み）: 次の石・内覧の後・物件選びのどれでも「ブレインが返信を選んだ時に向かった石」が測れないのが共通の止まり。
//   ブレインには書かせない（前例 q406: 出力の欄を足すと道がずれた）。下書きの文の締めの型（scripts/lib/guide-measure の closeKindOf と同じ網）と、
//   判断の記録の駅（digest.ar の node）から、次の石の表（route-next-stone）の語で1つ付けて判断の記録に残す（digest.rdir＝締めの型・digest.rst＝石の向き）。
//   スイッチ REPLY_DIRECTION_RECORD: 既定 on（記録だけ・動きは変えない）／off
import { stoneMoveOf, type StoneMove } from "./route-next-stone";
import type { RouteNodeId } from "./apply-route-map";

export function replyDirectionRecordOn(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.REPLY_DIRECTION_RECORD ?? "on").trim().toLowerCase() !== "off";
}
/** 返信の締めの型（guide-measure.closeKindOf と同じ網・竹内さんの文の言葉から） */
export function replyCloseKindOf(text: string): string {
  const t = String(text ?? "").normalize("NFKC");
  if (/お申込み?(?:頂|いただ|下さ|ください|され)|お申込みで(?:お部屋を?)?(?:抑|押さ)え/.test(t)) return "invite_apply";
  if (/ご内覧|内覧(?:頂|いただ|のご案内|させて)|ご案内させて頂/.test(t)) return "invite_viewing";
  if (/御見積書|お見積/.test(t) && /(?:作成|お送り)/.test(t)) return "invite_estimate";
  if (/ご都合(?:の)?(?:よろしい|良い)|何時頃|お日にち/.test(t)) return "ask_schedule";
  if (/ピックアップ|お送りさせて頂きます|お調べ|確認(?:出来|でき)次第|確認させて頂きます/.test(t)) return "promise";
  if (/[？?]/.test(t)) return "ask";
  if (/お気軽に|ご検討|ごゆっくり|お待ちしております/.test(t)) return "wait";
  return "answer";
}
/** 締めの型 → 向かう駅（route-progress の ACT_TARGET の reply: の行と同じ） */
const REPLY_TARGET: Record<string, RouteNodeId | "promise" | null> = { invite_apply: "apply_prep", invite_viewing: "viewing_arrange", invite_estimate: "estimate", ask_schedule: "viewing_arrange", promise: "promise" };
/** 判断の記録の駅（digest.ar＝"node|branch|substate|版"）と下書きから、石の向き（純関数） */
export function replyStoneOf(ar: string | null | undefined, draft: string): { rdir: string; rst: StoneMove } {
  const rdir = replyCloseKindOf(draft);
  const node = String(ar ?? "").split("|")[0] || null;
  return { rdir, rst: stoneMoveOf(node, REPLY_TARGET[rdir] ?? null) };
}
