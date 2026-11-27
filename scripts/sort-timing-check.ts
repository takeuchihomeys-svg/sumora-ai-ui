/**
 * 並べ替え（高→低）の前後の印と時間差を本番の点検の記録で見る（読むだけ・直近 N 回）。
 * 使い方: npx tsx --env-file=.env.local scripts/sort-timing-check.ts [--n=40] [--show=8]
 *   押した印（dl:sort_pressed）・読み直しの判定（dl:ad_sort_reload の ad_url/no_ad_url）・並べ替えの完了（dl:sort_done）・
 *   その後の最初の印刷用PDF（dl:one_send_ms 等）までの秒数を出す。印が無い＝押していない、ではない。
 */
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "");
const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1] ?? d;

type Step = { k: string; d?: string | null; at?: number | string | null; t?: number | string | null };
const atOf = (s: Step) => {
  const v = s.at ?? s.t;
  const n = typeof v === "number" ? v : Date.parse(String(v || ""));
  return Number.isFinite(n) ? n : NaN;
};

(async () => {
  const n = Number(arg("n", "40"));
  const show = Number(arg("show", "8"));
  const { data, error } = await sb
    .from("search_audits")
    .select("id, ext_version, status, steps")
    .eq("site", "realpro")
    .order("id", { ascending: false })
    .limit(n);
  if (error) { console.error(error.message); process.exit(1); }
  const cnt: Record<string, number> = {};
  const add = (k: string) => { cnt[k] = (cnt[k] || 0) + 1; };
  const gaps: { pressToReload: number[]; reloadToPdf: number[]; searchToPress: number[] } = { pressToReload: [], reloadToPdf: [], searchToPress: [] };
  let shown = 0;
  for (const r of (data || []) as any[]) {
    const st = (r.steps || []) as Step[];
    const sortSteps = st.filter((s) => /^dl:(sort_|ad_sort|search_to_sort|press_sort|press_ng_sort|sort_no_hilo)/.test(s.k));
    const has = (re: RegExp) => st.some((s) => re.test(s.k));
    add("回");
    if (has(/^dl:sort_pressed$/)) add("押した sort_pressed");
    if (has(/^dl:sort_done$/)) add("完了 sort_done");
    const rel = st.filter((s) => s.k === "dl:ad_sort_reload");
    if (rel.length) add("読み直し判定 ad_sort_reload");
    if (rel.some((s) => /^ad_url/.test(String(s.d || "")))) add("  うち ad_url（URL で高→低）");
    if (rel.some((s) => /no_ad_url/.test(String(s.d || "")))) add("  うち no_ad_url（URL に出ない）");
    if (has(/^dl:sort_fail/)) add("並べ替え失敗 sort_fail*");
    if (has(/^dl:sort_menu_open$/)) add("メニューが開いた sort_menu_open");
    if (has(/^dl:sort_hilo$/)) add("高→低を見つけた sort_hilo");
    if (has(/^dl:sort_lag_grace$/)) add("押した後の猶予 sort_lag_grace");
    if (has(/^dl:sort_hilo$/) && !has(/^dl:sort_pressed$/)) add(`  高→低を見つけたのに sort_pressed 無し（#${r.id} v${r.ext_version}）`);
    if (has(/^dl:sort_hilo$/) && has(/^dl:sort_pressed$/)) add(`  高→低を見つけて sort_pressed あり（#${r.id} v${r.ext_version}）`);
    const lg = st.filter((s) => s.k === "dl:list_flow_grasp").map((s) => String(s.d || ""));
    if (lg.some((d) => / AD未 /.test(d))) add("一覧の把握 AD未 あり");
    if (lg.some((d) => / AD高 /.test(d))) add("一覧の把握 AD高 あり（並べ替えが効いた）");
    if (has(/^dl:sort_hilo$/) && !lg.some((d) => / AD高 /.test(d))) add("  高→低を見つけたのに AD高 無し");
    if (has(/^dl:one_send_ms$/)) add("送った one_send_ms");
    const tPress = atOf(st.find((s) => s.k === "dl:sort_pressed") || ({} as Step));
    const tRel = atOf(rel[0] || ({} as Step));
    const tPdf = atOf(st.find((s) => s.k === "dl:one_send_ms") || ({} as Step));
    const tSearch = atOf(st.find((s) => /search_press_ok$/.test(s.k)) || ({} as Step));
    if (Number.isFinite(tPress) && Number.isFinite(tRel) && tRel >= tPress) gaps.pressToReload.push((tRel - tPress) / 1000);
    if (Number.isFinite(tRel) && Number.isFinite(tPdf) && tPdf >= tRel) gaps.reloadToPdf.push((tPdf - tRel) / 1000);
    if (Number.isFinite(tSearch) && Number.isFinite(tPress) && tPress >= tSearch) gaps.searchToPress.push((tPress - tSearch) / 1000);
    if (shown < show && sortSteps.length) {
      shown++;
      console.log(`#${r.id} v${r.ext_version} ${r.status}`);
      for (const s of sortSteps.slice(0, 14)) {
        const t = atOf(s);
        console.log(`   ${Number.isFinite(t) ? new Date(t).toISOString().slice(11, 19) : "--:--:--"} ${s.k} ${String(s.d || "").slice(0, 70)}`);
      }
    }
  }
  console.log(`\n直近 ${(data || []).length} 回`);
  for (const [k, v] of Object.entries(cnt)) console.log(`  ${k.padEnd(30)} ${v}`);
  const desc = (a: number[]) => a.length ? `n=${a.length} 最小${Math.min(...a).toFixed(1)} 中央${a.sort((x, y) => x - y)[Math.floor(a.length / 2)].toFixed(1)} 最大${Math.max(...a).toFixed(1)}秒` : "なし";
  console.log("  検索→押した      ", desc(gaps.searchToPress));
  console.log("  押した→読み直し判定", desc(gaps.pressToReload));
  console.log("  読み直し判定→最初の送付", desc(gaps.reloadToPdf));
})();
