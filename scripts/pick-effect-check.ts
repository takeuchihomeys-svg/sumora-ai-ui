/**
 * 町・管理費・構造の選択が効いたかを本番の点検の記録で数える（読むだけ・直近 N 回のリアプロ）。
 * 使い方: npx tsx --env-file=.env.local scripts/pick-effect-check.ts [--n=60]
 *   ・選ぶ場面: 町（page:town）／管理費（cond_one_* 管理費）／構造（cond_one_* 構造）の回数
 *   ・2.8.328 からの印: page:cond_effect_ok／page:cond_effect_retry／page:press_ng_cond_effect
 */
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "");
const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1] ?? d;
type Step = { k: string; d?: string | null; n?: number };

(async () => {
  const n = Number(arg("n", "60"));
  const { data, error } = await sb.from("search_audits").select("id, ext_version, status, steps").eq("site", "realpro").order("id", { ascending: false }).limit(n);
  if (error) { console.error(error.message); process.exit(1); }
  const c = { runs: 0, town: 0, fee: 0, feeSkip: 0, struct: 0, ok: 0, retry: 0, ng: 0 };
  const okBy: Record<string, number> = {}, ngBy: Record<string, number> = {};
  for (const r of (data || []) as any[]) {
    const st = (r.steps || []) as Step[];
    c.runs++;
    const cnt = (f: (s: Step) => boolean) => st.filter(f).reduce((a, s) => a + (s.n || 1), 0);
    c.town += cnt((s) => s.k === "page:town");
    c.fee += cnt((s) => s.k === "page:cond_one_ok" && /管理費|共益費|include_common_fee/.test(String(s.d || "")));
    c.feeSkip += cnt((s) => s.k === "page:fee_skip");
    c.struct += cnt((s) => s.k === "page:cond_one_ok" && /構造|structured_type/.test(String(s.d || "")));
    for (const s of st) {
      const what = String(s.d || "").split(/\s/)[0] || "?";
      if (s.k === "page:cond_effect_ok") { c.ok += s.n || 1; okBy[what] = (okBy[what] || 0) + (s.n || 1); }
      if (s.k === "page:cond_effect_retry") c.retry += s.n || 1;
      if (s.k === "page:press_ng_cond_effect") { c.ng += s.n || 1; ngBy[what] = (ngBy[what] || 0) + (s.n || 1); }
    }
  }
  console.log(`直近 ${c.runs} 回（リアプロ）`);
  console.log(`  選んだ場面: 町 ${c.town} 回／管理費 ${c.fee} 回（欄が無く見送り ${c.feeSkip}）／構造 ${c.struct} 回`);
  console.log(`  効いたの確かめ: 効いた ${c.ok}（${JSON.stringify(okBy)}）／選び直し ${c.retry}／選び直しても付かない ${c.ng}（${JSON.stringify(ngBy)}）`);
})();
