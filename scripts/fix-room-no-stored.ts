// scripts/fix-room-no-stored.ts — 保存済みの号室の形（先頭の0・読み取りの化け）を数え、そろえる（既定は数えるだけ・LLM なし・$0）
//
// 2026-10-14 竹内さん「日本の建物の号室は先頭の0を読まない（0704→704・00101→101）。照合・表示・記録のすべてで同じ形に」。直し方は app/lib/room-no.ts。
//   --apply で書くのは 記録の形だけ: sent_properties.room_no／sent_image_properties.room_no／aix_usage_logs.property_names（「Comforza 0302号室」）
//   売上サポの行（property_pickups.room_no）は数えるだけ（拡張の重複の見分け・PDF の号室と比べる所があるので、表示の側でそろえる＝PickupReview）
// 実行: npx tsx --env-file=.env.local scripts/fix-room-no-stored.ts [--apply]
import { createClient } from "@supabase/supabase-js";
import { canonicalRoomNo, canonicalRoomLabel } from "../app/lib/room-no";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const APPLY = process.argv.includes("--apply");

async function all<T>(t: string, cols: string, f?: (q: any) => any): Promise<T[]> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const out: T[] = [];
  for (let i = 0; ; i += 1000) { let q = sb.from(t).select(cols).range(i, i + 999); if (f) q = f(q); const { data, error } = await q; if (error) throw new Error(`${t}: ${error.message}`); out.push(...((data ?? []) as T[])); if (!data || data.length < 1000) break; }
  return out;
}
async function main() {
  let wrote = 0;
  for (const [t, key, apply] of [["sent_properties", "id", true], ["sent_image_properties", "image_url", true], ["property_pickups", "id", false]] as const) {
    const rows = await all<Record<string, string | null>>(t, `${key}, room_no`, (q) => q.not("room_no", "is", null));
    const withRoom = rows.filter((r) => String(r.room_no ?? "").trim());
    const change = withRoom.filter((r) => canonicalRoomNo(r.room_no, {}) !== String(r.room_no).trim());
    const ocr = change.filter((r) => /[OoIl|]/.test(String(r.room_no)));
    console.log(`${t}: 号室あり ${withRoom.length}・そろえる ${change.length}（化け ${ocr.length}）例 ${change.slice(0, 5).map((r) => `${r.room_no}→${canonicalRoomNo(r.room_no, {})}`).join(" ")}${apply ? "" : "（数えるだけ）"}`);
    if (APPLY && apply) for (const r of change) { const { error } = await sb.from(t).update({ room_no: canonicalRoomNo(r.room_no, {}) }).eq(key, r[key] as string); if (!error) wrote++; }
  }
  const ax = await all<{ id: string; property_names: string[] | null; line_message_id: string | null }>("aix_usage_logs", "id, property_names, line_message_id", (q) => q.not("property_names", "is", null));
  const axChange = ax.filter((r) => !String(r.line_message_id ?? "").startsWith("bexam") && (r.property_names ?? []).some((n) => canonicalRoomLabel(n, {}) !== n));
  const withRoom = ax.filter((r) => (r.property_names ?? []).some((n) => /号室/.test(n))).length;
  console.log(`aix_usage_logs.property_names: 号室のある行 ${withRoom}・そろえる ${axChange.length} 例 ${axChange.slice(0, 4).map((r) => (r.property_names ?? []).join("/")).join(" ｜ ")}`);
  if (APPLY) for (const r of axChange) { const { error } = await sb.from("aix_usage_logs").update({ property_names: (r.property_names ?? []).map((n) => canonicalRoomLabel(n, {})) }).eq("id", r.id); if (!error) wrote++; }
  console.log(APPLY ? `書いた ${wrote}` : "（数えただけ・--apply で書く）");
}
main().catch((e) => { console.error(e); process.exit(1); });
