// tmp: 見張りの「初回なのに通す物件が足りない」を本番の記録で出してみる（読むだけ）
import { createClient } from "@supabase/supabase-js";
import { loadLineWatch } from "../app/lib/line-watch-server";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, (process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)!);
(async () => {
  const r = await loadLineWatch(sb, {}) as unknown as { search?: Array<{ kind: string; name: string | null; detail: string }>; errors?: Record<string, unknown> };
  for (const s of (r.search ?? []).filter((x) => x.kind === "short")) console.log(`${s.name}: ${s.detail}`);
  console.log("errors:", JSON.stringify(r.errors ?? {}).slice(0, 300));
})();
