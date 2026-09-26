// app/lib/search-override-link.ts（サーバー用・DB を読むのは loadPickupSearchOverride だけ）
// 売上サポに届いた1回（merge-pdfs → property_pickups）を「どの上書きで検索した回か」に結ぶ。
//
// 竹内さんの決定（2026-09-27）「案Aでおこなう」: メモの上書きで検索した回は、判定もその上書きで行う。
// 結び方: 拡張（v2.5.27〜）は web_brain の上書き付きコマンドを動かしている間、そのお客様の merge-pdfs に search_command_id（コマンドの id）を付ける。
//   サーバーは上書きの中身を拡張から受け取らず、コマンドの行（automation_commands.payload.search_override・積む時に関所を通した物）を引き直す
//   （拡張が送る値を信じない・中身は1か所）。
// 結ばない（＝登録の条件で判定）時: id が無い（古い拡張・上書きなしの検索・手動の検索）／コマンドが web_brain でない／お客様が違う／
//   コマンドが古すぎる（LINK_MAX_AGE_MS）／上書きが空。間違って結ぶより、登録の条件で判定する方が安全（今までと同じ動き）
import { sanitizeSearchOverride } from "@/app/lib/search-override-read";
import type { PickupSearchOverride } from "@/app/lib/search-override";

/** コマンドを積んでから、その回の物件が届くまでの上限（拾い手の待ち 3時間＋検索・送信の時間） */
export const LINK_MAX_AGE_MS = 4 * 3600_000;
const ID_RE = /^[0-9a-f-]{8,64}$/i;

export type CommandRowLike = { id: string; created_at?: string | null; customer_ids?: string[] | null; payload?: { source?: unknown; search_override?: unknown } | null };

/** コマンドの行から、この回（お客様）に使う上書きを決める（純関数） */
export function pickupOverrideFromCommand(cmd: CommandRowLike | null | undefined, propertyCustomerId: string | null, nowMs = Date.now()): PickupSearchOverride | null {
  if (!cmd || !propertyCustomerId) return null;
  if (cmd.payload?.source !== "web_brain") return null;
  if (!(cmd.customer_ids ?? []).map(String).includes(String(propertyCustomerId))) return null;
  const at = Date.parse(String(cmd.created_at ?? ""));
  if (!Number.isFinite(at) || nowMs - at > LINK_MAX_AGE_MS || at - nowMs > 5 * 60_000) return null;
  const ov = sanitizeSearchOverride(cmd.payload?.search_override);
  return ov ? { command_id: cmd.id, override: ov } : null;
}

/** merge-pdfs の search_command_id から上書きを引く。読めない・結べない時は null（登録の条件で判定）。投げない */
export async function loadPickupSearchOverride(commandId: unknown, propertyCustomerId: string | null): Promise<PickupSearchOverride | null> {
  if (typeof commandId !== "string" || !ID_RE.test(commandId) || !propertyCustomerId) return null;
  try {
    const { supabase } = await import("@/app/lib/supabase");
    const { data, error } = await supabase.from("automation_commands").select("id, created_at, customer_ids, payload").eq("id", commandId).maybeSingle();
    if (error || !data) return null;
    const r = pickupOverrideFromCommand(data as CommandRowLike, propertyCustomerId);
    console.log(JSON.stringify({ tag: "merge-pdfs:search-override-link", command: commandId.slice(0, 8), linked: !!r }));
    return r;
  } catch { return null; }
}
