/**
 * 押したことの把握を本番の点検の記録で数える（読むだけ・直近 N 回・営業時間でも軽い範囲）。
 * 使い方: npx tsx --env-file=.env.local scripts/press-grasp-count.ts [--n=40]
 * 確定してリストへ・所在地を開く・駅の設定へ進む・検索・並べ替え・リセット・押した受領（press_ok_/press_ng_）の印が、
 * 何回の記録に残っているかを出す。印が無い＝押していない、ではない（120段の上限で捨てられた物もある）。
 */
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "");
const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1] ?? d;

const MARKS: [string, RegExp][] = [
  ["確定を積んだ modal_confirm", /^page:modal_confirm$/],
  ["確定0.4秒後 ok", /^page:confirm_press_ok$/],
  ["確定0.4秒後 fail", /^page:confirm_press_fail$/],
  ["確定→閉じた", /^page:guide_phase_after_confirm$/],
  ["確定後も開いたまま", /^page:guide_phase_confirm_open$/],
  ["所在地を開く retry", /^page:area_open_retry$/],
  ["所在地を開く fail", /^page:area_open_fail$/],
  ["駅の設定へ ok", /^page:go_press_ok$/],
  ["駅の設定へ fail", /^page:go_press_fail$/],
  ["駅の設定へ詰まり", /^page:station_go_stuck$/],
  ["検索 search_press_ok", /^page:search_press_ok$/],
  ["並べ替え sort_pressed", /^dl:sort_pressed$/],
  ["並べ替え sort_done", /^dl:sort_done$/],
  ["リセット reset_press", /^reset_press$/],
  ["受領 press_ok_*", /^page:press_ok_/],
  ["受領 press_ng_*", /^page:press_ng_/],
  ["段が120で満杯", /./],
];

(async () => {
  const n = Number(arg("n", "40"));
  const { data, error } = await sb
    .from("search_audits")
    .select("id, ext_version, status, steps")
    .eq("site", "realpro")
    .order("id", { ascending: false })
    .limit(n);
  if (error) { console.error(error.message); process.exit(1); }
  const rows = (data || []).filter((r: any) => !String(r.run_id || "").startsWith("human_"));
  const cnt: Record<string, number> = {};
  const vers: Record<string, number> = {};
  for (const r of rows as any[]) {
    vers[r.ext_version || "?"] = (vers[r.ext_version || "?"] || 0) + 1;
    const st = (r.steps || []) as { k: string }[];
    for (const [name, re] of MARKS) {
      if (name === "段が120で満杯") { if (st.length >= 118) cnt[name] = (cnt[name] || 0) + 1; continue; }
      if (st.some((s) => re.test(s.k))) cnt[name] = (cnt[name] || 0) + 1;
    }
  }
  console.log(`直近 ${rows.length} 回（#${(rows[rows.length - 1] as any)?.id}〜#${(rows[0] as any)?.id}） 版:`, vers);
  for (const [name] of MARKS) console.log(`  ${name.padEnd(28)} ${cnt[name] || 0} 回`);
  if (process.argv.includes("--per-run")) {
    for (const r of rows.slice(0, 15) as any[]) {
      const st = (r.steps || []) as { k: string }[];
      const pg = st.filter((s) => s.k.startsWith("page:"));
      const kinds = Array.from(new Set(pg.map((s) => s.k.slice(5)))).slice(0, 14).join(",");
      console.log(`  #${r.id} v${r.ext_version} ${r.status} 段${st.length} page段${pg.length} dl段${st.filter((s) => s.k.startsWith("dl:")).length} | ${kinds}`);
    }
  }
})();
