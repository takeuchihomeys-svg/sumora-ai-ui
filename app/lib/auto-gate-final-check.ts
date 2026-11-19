// auto-gate-final-check.ts — 自動送信の関所が「最終チェックを通った下書きだけ」を通すための判定（純関数・作業員20・2026-11-12）
//
// 台帳 auto-gate:passes-without-final-check（本物の関所 canAutoReply は最終チェックを通っていない下書きも通す）。
// 今の関所は hasBlock(ai_draft_check) だけ見ていて、ai_draft_check が無い（テンプレ最適化・最終チェックが走らなかった・古い下書き）／
// 3パスが完走していない（passes_completed が3未満）下書きは「block 0」と読まれて通っていた（hasBlock(null) は false）。
// 判断の根拠: 迷ったら人に残す（canAutoReply の決まり）。最終チェックの結果が読めない・3パス未完走は「通った」の証拠にならない。
//   自動送信は今 off（auto_send_enabled が true の会話が無い）ので本番の動きは変わらない。戻す: AUTO_GATE_FINAL_CHECK=off
// 下書き本文と checked_text_hash の突き合わせ（書き直し後の取り違え）は、ai_draft の整形（draftToSendableText）との差で誤って止める恐れがあるので
//   別スイッチ AUTO_GATE_FC_HASH=on（既定 off）にして、影の運用で一致率を見てから入れる。

export type FinalCheckState = "ok" | "missing" | "incomplete" | "stale";

type Env = Record<string, string | undefined>;
const envOf = (env?: Env): Env => env ?? (typeof process !== "undefined" ? process.env : {});
export function autoGateFinalCheckEnabled(env?: Env): boolean { return (envOf(env).AUTO_GATE_FINAL_CHECK ?? "").trim().toLowerCase() !== "off"; }
export function autoGateFcHashEnabled(env?: Env): boolean { return (envOf(env).AUTO_GATE_FC_HASH ?? "").trim().toLowerCase() === "on"; }

/**
 * ai_draft_check（会話に保存された最終チェックの結果）が「3パスを完走した」証拠になるか。
 *  missing    … 結果が無い・オブジェクトでない（最終チェックが走っていない）
 *  incomplete … passes_completed が無い・3パス（meta を除く）に満たない
 *  stale      … AUTO_GATE_FC_HASH=on の時だけ: checked_text_hash が今の下書きの sha1 と違う（draftHash を渡した時）
 * block の有無は呼び出し側の hasBlock（draftHasBlock）が見る（ここでは見ない）。
 */
export function finalCheckStateOf(check: unknown, o: { draftHash?: string | null; env?: Env } = {}): FinalCheckState {
  if (!check || typeof check !== "object" || Array.isArray(check)) return "missing";
  const c = check as Record<string, unknown>;
  const passes = Array.isArray(c.passes_completed) ? (c.passes_completed as unknown[]).filter((p) => p !== "meta") : null;
  if (!passes || passes.length < 3) return "incomplete";
  if (autoGateFcHashEnabled(o.env) && o.draftHash && typeof c.checked_text_hash === "string" && c.checked_text_hash !== o.draftHash) return "stale";
  return "ok";
}
