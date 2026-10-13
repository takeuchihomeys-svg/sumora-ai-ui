// tpo-debug-fallback.ts — 送った例に tpo_debug（生成の記録）が付かない穴を、サーバの会話の記録で埋める（2026-10-14 区切り1）
//
// page.tsx は画面の checkResult.tpo_debug を save-reply-example に送るが、会話の切り替え・表示済みの下書きの復元・AIX の送信の後の消去・
// スパークルの経路などで checkResult が無い／別の物になり、送った例の 14日で下書きありの 18%・全体では 6 割で記録が無かった。
// サーバは conversations.ai_draft_check（generate-reply が tpo_debug ごと保存）を持っているので、
// 「同じ番の下書き」と言える時だけそれを使う（別の番の記録を付けると物差しが狂う）。
//   同じ番 = ai_draft_check.checked_text_hash が送った下書き（aiDraft）の sha1 と同じ
//         or ai_draft_check.context_hash が下書きを作った時のお客様の発言（customerMessage）の sha1 と同じ
//         or ai_draft_check.context_last_hash（連投の最後の1通）が customerMessage の sha1 と同じ（画面は最後の1通を送る時がある）
// 戻す: TPO_DEBUG_SERVER_FALLBACK=off
import { createHash } from "node:crypto";

export function tpoDebugFallbackEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.TPO_DEBUG_SERVER_FALLBACK !== "off";
}

const sha1 = (t: string) => createHash("sha1").update(t, "utf8").digest("hex");

export type TpoFallbackPick = { tpo: Record<string, unknown>; by: "draft_hash" | "context_hash" } | null;

/** ai_draft_check から同じ番の tpo_debug を選ぶ（純関数） */
export function pickServerTpoDebug(
  check: unknown,
  sent: { aiDraft?: string | null; customerMessage?: string | null },
): TpoFallbackPick {
  if (!check || typeof check !== "object") return null;
  const c = check as { tpo_debug?: unknown; checked_text_hash?: unknown; context_hash?: unknown; context_last_hash?: unknown };
  const tpo = c.tpo_debug;
  if (!tpo || typeof tpo !== "object" || Array.isArray(tpo)) return null;
  const draft = (sent.aiDraft ?? "").trim();
  if (draft && typeof c.checked_text_hash === "string" && c.checked_text_hash === sha1(draft)) {
    return { tpo: tpo as Record<string, unknown>, by: "draft_hash" };
  }
  const msg = (sent.customerMessage ?? "").trim();
  if (msg && msg !== "（初回連絡）" && ((typeof c.context_hash === "string" && c.context_hash === sha1(msg)) || (typeof c.context_last_hash === "string" && c.context_last_hash === sha1(msg)))) {
    return { tpo: tpo as Record<string, unknown>, by: "context_hash" };
  }
  return null;
}
