// app/lib/rag-watch-server.ts — RAG の見張りの包みを入れる（instrumentation.ts から1回だけ）・記録は rag_call_logs
//   2026-11-15 作業員H。RAG_WATCH=on の時だけ。鍵が無い・表が無い時は1回だけ警告して何もしない（本来の応答は止めない）
import { ragWatchOn, wrapFetchWithRagWatch, type RagCallRow } from "./rag-watch";
import { serverSupabaseKey } from "./supabase-server-key";
import { usageEnvLabel } from "./llm-test-mode";

const INSTALLED = Symbol.for("sumora.ragWatchInstalled");
type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export async function installRagWatch(): Promise<boolean> {
  if (!ragWatchOn()) return false;
  const g = globalThis as unknown as { fetch: FetchLike } & Record<symbol, unknown>;
  if (typeof g.fetch !== "function" || g[INSTALLED]) return false;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = serverSupabaseKey();
  if (!url || !key) return false;
  const { createClient } = await import("@supabase/supabase-js");
  const { waitUntil } = await import("@vercel/functions");
  const original = g.fetch.bind(globalThis);
  // 記録の書き込みは包む前の fetch で（自分の書き込みを見ない・match_* でないので見ないが念のため）
  const db = createClient(url, key, { auth: { persistSession: false }, global: { fetch: original } });
  type WorkStore = { getStore(): { route?: string } | undefined };
  let workStore: WorkStore | null = null;
  try {
    const mod = await import("next/dist/server/app-render/work-async-storage.external");
    workStore = (mod as unknown as { workAsyncStorage?: WorkStore }).workAsyncStorage ?? null;
  } catch { workStore = null; }
  let warned = false;
  const wrapped = wrapFetchWithRagWatch(original, {
    insert: async (r: RagCallRow) => {
      const { error } = await db.from("rag_call_logs").insert(r);
      if (error && !warned) { warned = true; console.warn("[rag-watch] insert failed:", error.message); }
    },
    keepAlive: (p) => { try { waitUntil(p); } catch { /* Vercel 以外 */ } },
    route: () => workStore?.getStore()?.route ?? null,
    env: usageEnvLabel(process.env),
  });
  Object.assign(wrapped, g.fetch);
  g.fetch = wrapped;
  g[INSTALLED] = true;
  return true;
}
