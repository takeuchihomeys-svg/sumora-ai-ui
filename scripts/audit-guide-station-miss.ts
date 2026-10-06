// scripts/audit-guide-station-miss.ts（読むだけ・書かない・サイトには触らない）
// 2026-10-06 v2.5.84 竹内「沿線はちゃんと選択されているのに何で駅直通全て表示されていないのか　駅の部分について把握できていないのか
//   原因見つけて改善するのと改善していく仕組み作る」（みくさん・梅田まで電車1本＝12路線・122駅 → 案内が先頭 40駅で切っていた）
//
// 光らせる予定の駅のうち、リアプロの駅の小窓に当たらなかった駅を集めて、表（拡張の駅の名前 ↔ リアプロの文字）を直す材料にする。
//   ①記録（v2.5.84〜）: search_audits.filled.guide_stations（案内で駅の手順が済んだ・検索を押した時に realpro-guide.js が1回だけ送る）
//      = { planned, missing[], via{名前: 読み替えで当たった文字}, lit_labels, page_labels[]（その時の駅の小窓の文字） }
//   ②当て直し（v2.5.84 より前の回も）: 案内・自動の回の intended.station_names を、本番で見たリアプロの駅の文字の辞書
//      （自動入力の filled.form.stations＝駅の小窓の文字の読み戻し ＋ ①の page_labels）に realpro-guide-plan.js matchStations で当てる
//      → 辞書のどこにも無い名前＝表記違いか未収録の疑い。旧の 40駅で切れていた回の数も出す
//   見つからない駅ごとに、辞書の中の近い文字（JR の有無・ヶ/ケ・含む・1字違い）を候補に出す。直すのは
//   realpro-guide-plan.js STATION_NAME_ALIASES（読み替え）か、駅の名前を出している表（popup-maps.js LINE_STATION_ORDER 等・サイトごとに独立）。
// 実行: npx tsx --env-file=.env.local scripts/audit-guide-station-miss.ts [--days=30] [--show=40]
import { createClient } from "@supabase/supabase-js";
import { createRequire } from "module";
const require_ = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const P = require_("../chrome-extension/realpro-guide-plan.js") as {
  matchStations(names: string[], labels: string[]): { want: Record<string, boolean>; missing: string[]; via: Record<string, string> };
  stationKey(n: string): string;
  MAX_GUIDE_STATIONS: number;
};
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "");
const arg = (k: string, d: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=").slice(1).join("=");
const days = Number(arg("days", "30"));
const show = Number(arg("show", "40"));
const OLD_CAP = 40; // v2.5.83 までの案内の切り

type Row = {
  run_id: string; created_at: string; property_customer_id: string | null; mode: string | null; ext_version: string | null;
  intended: { station_names?: string[]; area_mode?: string; select_all_line_stations?: boolean } | null;
  filled: { form?: { stations?: string[] }; guide_stations?: { planned?: number; missing?: string[]; via?: Record<string, string>; page_labels?: string[]; lit_labels?: number } } | null;
};

function lev1(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1 || a === b) return false;
  let i = 0, j = 0, diff = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++diff > 1) return false;
    if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; }
  }
  return diff + (a.length - i) + (b.length - j) <= 1;
}
function candidates(name: string, dict: string[]): string[] {
  const k = P.stationKey(name), kj = k.replace(/^JR/, "");
  const out = dict.filter((l) => {
    const lk = P.stationKey(l), lj = lk.replace(/^JR/, "");
    if (lk === k) return false;
    return lj === kj || (kj.length >= 2 && (lj.includes(kj) || kj.includes(lj)) && lj.length >= 2) || lev1(lj, kj);
  });
  return out.slice(0, 6);
}

(async () => {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const rows: Row[] = [];
  for (let o = 0; o < 20000; o += 1000) {
    const { data, error } = await sb.from("search_audits")
      .select("run_id, created_at, property_customer_id, mode, ext_version, intended, filled")
      .eq("site", "realpro").gte("created_at", since).order("created_at").range(o, o + 999);
    if (error) throw new Error(error.message);
    rows.push(...((data ?? []) as Row[]));
    if (!data || data.length < 1000) break;
  }
  // 本番で見たリアプロの駅の文字の辞書（期間を問わず・自動入力の読み戻し＋案内の記録）
  const dictSet = new Set<string>();
  for (let o = 0; o < 50000; o += 1000) {
    const { data, error } = await sb.from("search_audits").select("filled").eq("site", "realpro").not("filled", "is", null).order("id").range(o, o + 999);
    if (error) throw new Error(error.message);
    for (const r of (data ?? []) as Array<Pick<Row, "filled">>) {
      (r.filled?.form?.stations ?? []).forEach((s) => s && dictSet.add(String(s)));
      (r.filled?.guide_stations?.page_labels ?? []).forEach((s) => s && dictSet.add(String(s)));
    }
    if (!data || data.length < 1000) break;
  }
  const dict = [...dictSet];
  console.log(`期間 ${days}日・リアプロの回 ${rows.length}・リアプロの駅の文字の辞書 ${dict.length}（本番で見た分だけ＝辞書に無い≠リアプロに無い）`);

  // ① 案内の記録
  const rec = rows.filter((r) => r.filled?.guide_stations);
  const missCount = new Map<string, { n: number; customers: Set<string> }>();
  for (const r of rec) for (const m of r.filled!.guide_stations!.missing ?? []) {
    const e = missCount.get(m) ?? { n: 0, customers: new Set<string>() };
    e.n++; if (r.property_customer_id) e.customers.add(r.property_customer_id);
    missCount.set(m, e);
  }
  console.log(`\n── ① 案内の記録（v2.5.84〜）: ${rec.length}回・見つからない駅 ${missCount.size}種`);
  [...missCount.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, show).forEach(([name, e]) =>
    console.log(`  ${name}  ${e.n}回・${e.customers.size}人  候補: ${candidates(name, dict).join("・") || "（なし）"}`));
  const viaCount = new Map<string, number>();
  for (const r of rec) for (const [n, l] of Object.entries(r.filled!.guide_stations!.via ?? {})) viaCount.set(`${n}→${l}`, (viaCount.get(`${n}→${l}`) ?? 0) + 1);
  if (viaCount.size) console.log("  読み替えで当たった: " + [...viaCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([k, n]) => `${k}(${n})`).join("・"));

  // ② 当て直し（全部の回の intended.station_names × 辞書）
  const withNames = rows.filter((r) => (r.intended?.station_names ?? []).length > 0 && (r.intended?.area_mode ?? "station") === "station");
  const cut = withNames.filter((r) => (r.intended!.station_names!.length) > OLD_CAP);
  const replayMiss = new Map<string, { n: number; customers: Set<string> }>();
  for (const r of withNames) {
    const m = P.matchStations(r.intended!.station_names!, dict);
    for (const name of m.missing) {
      const e = replayMiss.get(name) ?? { n: 0, customers: new Set<string>() };
      e.n++; if (r.property_customer_id) e.customers.add(r.property_customer_id);
      replayMiss.set(name, e);
    }
  }
  console.log(`\n── ② 当て直し: 駅を指定した回 ${withNames.length}・旧の案内で ${OLD_CAP}駅を超えて切れていた回 ${cut.length}（落ちた駅 計 ${cut.reduce((s, r) => s + r.intended!.station_names!.length - OLD_CAP, 0)}）`);
  cut.slice(-10).forEach((r) => console.log(`  ${r.created_at.slice(0, 16)} ${r.property_customer_id?.slice(0, 8)} ${r.intended!.station_names!.length}駅（${r.mode ?? "-"}・v${r.ext_version ?? "?"}${r.intended!.select_all_line_stations ? "・路線の全駅" : ""}）`));
  console.log(`  辞書のどこにも無い名前 ${replayMiss.size}種（表記違い・未収録の疑い・辞書が見ていないだけの事もある）:`);
  [...replayMiss.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, show).forEach(([name, e]) =>
    console.log(`  ${name}  ${e.n}回・${e.customers.size}人  候補: ${candidates(name, dict).join("・") || "（なし）"}`));
})().catch((e) => { console.error(e); process.exit(1); });
