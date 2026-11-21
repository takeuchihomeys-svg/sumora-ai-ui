// scripts/lib/found-gap-ledger.ts — 点検で見つけた穴を台帳（work_items・origin=found_gap）に持ち主つきで足す（作業員N2・2026-11-21・台帳 #505）
//
// check-stale・check-linkage と同じ形（題で重ねない・段は todo・work_item_events に assign を1行）。穴の型③〜⑤の点検（check-windows・check-count-verified・check-off-path）が使う。
//   持ち主: 連携の地図の段の持ち主（owner-feedback-check の STAGE_OWNER）を先に・今動いている作業員に読み替え（作業員K → 作業員K2）・決まらない物は統括役
import type { SupabaseClient } from "@supabase/supabase-js";
import { STAGE_OWNER } from "../owner-feedback-check";

export const LIVE_WORKERS = ["作業員K2", "作業員N", "作業員M", "作業員G", "作業員L", "作業員H"];

/** 持ち主の決め（純関数）: 段（STAGE_OWNER の鍵）か、名前（「作業員L・作業員H」の形）から今動いている作業員を1人 */
export function liveOwnerOf(ownerOrStage: string): string {
  const byStage = STAGE_OWNER[ownerOrStage];
  if (byStage) return byStage;
  return ownerOrStage.split("・").map((o) => (o === "作業員K" ? "作業員K2" : o.trim())).find((o) => LIVE_WORKERS.includes(o)) ?? "統括役";
}

export type FoundGap = { title: string; owner: string; next: string; priority?: number; area?: string };

export async function addFoundGaps(sb: SupabaseClient, gaps: ReadonlyArray<FoundGap>, actor: string): Promise<number[]> {
  if (!gaps.length) return [];
  const { data: open } = await sb.from("work_items").select("title").eq("origin", "found_gap").not("stage", "in", "(done,dropped)").limit(3000);
  const have = new Set(((open ?? []) as Array<{ title: string }>).map((x) => x.title));
  const added: number[] = [];
  for (const g of gaps) {
    if (have.has(g.title)) continue;
    const owner = liveOwnerOf(g.owner);
    const { data: ins } = await sb.from("work_items").insert({ title: g.title, origin: "found_gap", stage: "todo", area: g.area ?? "土台", owner, priority: g.priority ?? 20, next_step: g.next.slice(0, 400) }).select("id").single();
    if (ins) {
      const id = (ins as { id: number }).id;
      added.push(id);
      have.add(g.title);
      await sb.from("work_item_events").insert({ item_id: id, to_stage: "todo", actor, kind: "assign", note: `持ち主 ${owner}・#505 の子` });
    }
  }
  return added;
}
