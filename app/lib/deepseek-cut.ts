// app/lib/deepseek-cut.ts
// 「DeepSeek に渡す時刻の線」で、会話から作った派生データ（ブレインの判断・会話の方向・要約・セーブデータ）を切る純関数。
//
// 2026-09-26 竹内「申込の間の部分は DeepSeek に渡さず、申込落ちてステータスを切り替えたら、切り替えたところ以降渡せば個人情報防げる」
//   履歴（メッセージ）は1通ずつ時刻で切れる（post-apply.ts filterAfterCutoff）。派生データは「作った時刻（見た最後の発言の時刻）」が
//   線より前なら、申込中の中身から作った物なので DeepSeek に渡さない。
//   ⚠ 線より後に作った派生データも、作る側（ブレイン＝Claude）は線より前の履歴を読んでいる。要約・セーブデータは積み上げ式なので
//     申込中の事実が持ち越されうる（残っている穴。出口の網＝線より前のお客様の発言の断片で、文そのままの持ち越しだけは止まる）。
//   線が -Infinity（申込の記録なし）の時は何も切らない。線が null（申込中）の時は全部落とす（そもそも DeepSeek に行かない）。
import { isAfterCutoff, cutoffMs, NO_CUTOFF, type DeepseekCutoff } from "./post-apply";

/** 派生データ1つ: 作った時刻が線より後なら残す、前・不明なら null */
export function keepIfMadeAfter<T>(value: T | null | undefined, madeAt: string | null | undefined, c: DeepseekCutoff): T | null {
  if (value === null || value === undefined) return null;
  if (cutoffMs(c) === NO_CUTOFF) return value;
  return isAfterCutoff(madeAt, c) ? value : null;
}

/** ブレインの判断（suggested_aix_meta / last_brain_meta）: 見た最後のお客様発言の時刻（analyzed_msg_ts）で判定 */
export function keepBrainMeta<T>(meta: T | null | undefined, c: DeepseekCutoff): T | null {
  const ts = meta && typeof meta === "object" ? (meta as Record<string, unknown>).analyzed_msg_ts : null;
  return keepIfMadeAfter(meta, typeof ts === "string" ? ts : null, c);
}

/** 会話の方向（conversation_direction）: updated_at で判定 */
export function keepConversationDirection<T>(dir: T | null | undefined, c: DeepseekCutoff): T | null {
  const ts = dir && typeof dir === "object" ? (dir as Record<string, unknown>).updated_at : null;
  return keepIfMadeAfter(dir, typeof ts === "string" ? ts : null, c);
}

/** 返信生成が読むブレインの判断の束（generate-reply の fetchReplyModeGate の形）を線で切る */
export function cutBrainGate<G extends { meta: unknown; lastMeta: unknown; conversationDirection: unknown }>(g: G | null, c: DeepseekCutoff): G | null {
  if (!g) return g;
  return {
    ...g,
    meta: keepBrainMeta(g.meta, c),
    lastMeta: keepBrainMeta(g.lastMeta, c),
    conversationDirection: keepConversationDirection(g.conversationDirection, c),
  } as G;
}
