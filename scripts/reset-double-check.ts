/**
 * リセットの二重・同じ段の重複を本番の点検の記録で見る（読むだけ・直近 N 回）。
 * 使い方: npx tsx --env-file=.env.local scripts/reset-double-check.ts [--n=60] [--show=6]
 *   ・1回の記録の中のリセットの押し（reset_press）の数と、裏の起き直し（sw_restart_*）の有無
 *   ・同じ秒に同じ段・同じ中身が何回入っているか（多い順）
 */
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "");
const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1] ?? d;
type Step = { k: string; d?: string | null; at?: number | string | null };
const atOf = (s: Step) => { const v = s.at; const n = typeof v === "number" ? v : Date.parse(String(v || "")); return Number.isFinite(n) ? n : NaN; };

(async () => {
  const n = Number(arg("n", "60"));
  const show = Number(arg("show", "6"));
  const { data, error } = await sb.from("search_audits").select("id, ext_version, status, steps").eq("site", "realpro").order("id", { ascending: false }).limit(n);
  if (error) { console.error(error.message); process.exit(1); }
  const dupTotal: Record<string, number> = {};
  let shown = 0;
  let runsSw = 0, runsDoublePre = 0;
  for (const r of (data || []) as any[]) {
    const st = (r.steps || []) as Step[];
    const sw = st.filter((s) => /sw_restart/.test(s.k));
    const press = st.filter((s) => s.k === "reset_press");
    const pre = st.filter((s) => s.k === "reset_before_fill" || /pre_fill_reset/.test(String(s.d || "")) && s.k === "bulk_phase");
    const prePress = st.filter((s) => s.k === "reset_press" && /pre_fill|入力前/.test(String(s.d || "")));
    if (sw.length) runsSw++;
    if (prePress.length >= 2) runsDoublePre++;
    // 同じ秒・同じ段・同じ中身
    const seen: Record<string, number> = {};
    for (const s of st) {
      const t = atOf(s);
      const key = `${s.k}|${String(s.d || "").slice(0, 60)}|${Number.isFinite(t) ? Math.floor(t / 1000) : "?"}`;
      seen[key] = (seen[key] || 0) + 1;
    }
    for (const [key, c] of Object.entries(seen)) if (c >= 2) { const k = key.split("|")[0]; dupTotal[k] = (dupTotal[k] || 0) + (c - 1); }
    if (shown < show && (sw.length || prePress.length >= 2 || press.length >= 3)) {
      shown++;
      console.log(`#${r.id} v${r.ext_version} ${r.status} 段${st.length} 押し${press.length} 入力前の押し${prePress.length} 起き直し${sw.length}`);
      const t0 = atOf(st[0] || ({} as Step));
      for (const s of st.filter((x) => /^(reset_|sw_restart|bulk_phase|customer_api_reload|fill_done|begin|handoff_loop|post_send_clear)/.test(x.k)).slice(0, 40)) {
        const t = atOf(s);
        console.log(`   +${Number.isFinite(t) && Number.isFinite(t0) ? Math.round((t - t0) / 1000) : "?"}s ${s.k} ${String(s.d || "").slice(0, 80)}`);
      }
    }
  }
  // 一括の段 pre_fill_reset（_resetBeforeFill が押す時に必ず書く）と、同じ回の reset_before_fill「→リセットを押す」の数を比べる。
  //   段の方が多い＝回の番号を持たない道（ポップアップの受け口 axlx-reset-before-fill）から入力前リセットが来た
  console.log("\n回ごと: 一括の段 pre_fill_reset の数 ／ この回の『→リセットを押す』の数（段の方が多い＝番号なしの入力前リセット）");
  let runsOrphan = 0;
  for (const r of (data || []) as any[]) {
    const st = (r.steps || []) as Step[];
    const ph = st.filter((s) => s.k === "bulk_phase" && /^pre_fill_reset/.test(String(s.d || ""))).length;
    const own = st.filter((s) => s.k === "reset_before_fill" && /リセットを押す/.test(String(s.d || ""))).length;
    if (ph > own) { runsOrphan++; console.log(`  #${r.id} v${r.ext_version} ${r.status} 段=${ph} 自分の押す=${own}`); }
  }
  console.log(`  → 番号なしの入力前リセットがあった回: ${runsOrphan}`);
  console.log(`\n直近 ${(data || []).length} 回: 起き直しあり ${runsSw} 回／入力前の押しが2回以上 ${runsDoublePre} 回`);
  console.log("同じ秒・同じ段・同じ中身の重複（余分の数・多い順）:");
  for (const [k, c] of Object.entries(dupTotal).sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(`  ${k.padEnd(36)} ${c}`);
})();
