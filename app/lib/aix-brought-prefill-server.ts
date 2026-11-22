// app/lib/aix-brought-prefill-server.ts — お客様が送ってきた物件（まだ確認の結果を返していない）を DB から読む所（読むだけ）
//   画面の初期値（/api/aix/brought-properties）と、AIX の文の生成の材料（AIX_BROUGHT_MATERIAL）が同じ物を使う
import { supabase } from "@/app/lib/supabase-server";
import { loadPropertyThreads } from "@/app/lib/property-thread-server";
import { broughtForCheck, broughtMaxAgeDays, type BroughtPrefill } from "@/app/lib/aix-brought-prefill";

/** AIX の文の生成に「お客様が送ってきた物件」の名前を渡すか（既定 off・AIX_BROUGHT_MATERIAL=on） */
export function aixBroughtMaterialEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.AIX_BROUGHT_MATERIAL ?? "").trim().toLowerCase() !== "off";
}

/** 失敗・時間切れ（4秒）は null（材料を足さないだけ） */
export async function loadBroughtPrefillFor(conversationId: string, opts: { asOf?: string | null } = {}): Promise<BroughtPrefill | null> {
  const work = (async () => {
    const until = opts.asOf ?? new Date(Date.now() + 86400_000).toISOString();
    const [state, ck] = await Promise.all([
      loadPropertyThreads(conversationId, { asOf: opts.asOf ?? null }),
      // 物件確認した を送った時刻＝区切り（物件名の記録が空の AIX は台帳の物件に結びつかないため）
      supabase.from("aix_usage_logs").select("sent_at").eq("conversation_id", conversationId).eq("aix_type", "property_check_result")
        .not("sent_at", "is", null).lt("sent_at", until).order("sent_at", { ascending: false }).limit(1),
    ]);
    const p = broughtForCheck(state, { checkAts: (ck.data ?? []).map((r) => r.sent_at as string), maxAgeDays: broughtMaxAgeDays(), nowMs: opts.asOf ? Date.parse(opts.asOf) : Date.now() });
    // 2026-11-21 作業員K2（check-name-fill.ts・CHECK_NAME_FILL=on の時だけ・既定 off）: 台帳の物件名が全部空の時、直前 72時間のお客様の持ち込みが
    //   1件に決まれば、その名前を先頭に入れる（画面のコードは変えない・2件以上・決まらない時は今のまま）
    const cf = await import("./check-name-fill");
    if (cf.checkNameFillOn() && !p.rooms.some((r) => (r.name ?? "").trim())) {
      const r = await cf.loadCheckNameFill(supabase, conversationId, opts.asOf ?? new Date().toISOString());
      if (r) {
        const at = opts.asOf ?? new Date().toISOString();
        const rooms = p.rooms.length ? [{ ...p.rooms[0], name: cf.filledLabel(r), source: `check_name_fill:${r.via}` }, ...p.rooms.slice(1)] : [{ name: cf.filledLabel(r), at, source: `check_name_fill:${r.via}` }];
        return { ...p, rooms, count: Math.max(p.count, 1) };
      }
    }
    return p;
  })();
  try {
    return await Promise.race([work, new Promise<null>((r) => setTimeout(() => r(null), 4_000))]);
  } catch (e) {
    console.warn("[aix-brought] load failed:", e instanceof Error ? e.message : String(e));
    return null;
  }
}
