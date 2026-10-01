import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
(async () => {
  const since = process.argv[2] ?? new Date(Date.now() - 20 * 60_000).toISOString();
  const { data, error } = await sb.from("llm_usage_logs").select("created_at,model,action,env,input_uncached,cache_read,output_tokens,conversation_id").gte("created_at", since).order("created_at");
  if (error) { console.log(error.message); return; }
  for (const r of data ?? []) console.log(r.created_at.slice(11, 19), r.env, r.model, r.action, r.input_uncached, r.cache_read, r.output_tokens, (r.conversation_id ?? "").slice(0, 8));
})();
