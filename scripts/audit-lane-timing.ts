// scripts/audit-lane-timing.ts（読むだけ・DB に書かない）
// 2026-09-30 v2.5.43 リアプロと ITANDI を同時に動かした時の「1人あたりの時間」の見積もりの材料:
//   search_audits（ブレインの回・finished・失敗なし）の 1回（お客様×サイト×パス）の時間をサイトごとに数え、
//   同じ命令×お客様でリアプロと ITANDI がそろった組の「順（今）」と「同時（v2.5.43）」の時間を比べる。
// 実行: npx tsx --env-file=.env.local scripts/audit-lane-timing.ts [--days=14]
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const days = Number((process.argv.find((a) => a.startsWith("--days=")) ?? "--days=14").split("=")[1]) || 14;

type Row = { command_id: string | null; property_customer_id: string | null; site: string | null; created_at: string; finished_at: string | null; status: string; error: string | null; error_kind: string | null };

function q(xs: number[], p: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))];
}
const min = (ms: number | null) => (ms == null ? "?" : `${(ms / 60000).toFixed(1)}分`);

(async () => {
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const { data, error } = await sb.from("search_audits").select("command_id, property_customer_id, site, created_at, finished_at, status, error, error_kind")
    .gte("created_at", since).eq("status", "finished").order("created_at", { ascending: true }).limit(5000);
  if (error) { console.error(error.message); process.exit(1); }
  const rows = ((data ?? []) as Row[]).filter((r) => r.finished_at && !r.error && !r.error_kind);
  const dur = (r: Row) => Date.parse(r.finished_at!) - Date.parse(r.created_at);
  for (const site of ["realpro", "itandi"]) {
    const xs = rows.filter((r) => r.site === site).map(dur).filter((x) => x > 0);
    console.log(`${site}: ${xs.length}回 中央値 ${min(q(xs, 0.5))}・p90 ${min(q(xs, 0.9))}・最長 ${min(q(xs, 1))}`);
  }
  // 同じ命令×お客様でリアプロと ITANDI がそろった組
  const by = new Map<string, Row[]>();
  for (const r of rows) {
    if (!r.command_id || !r.property_customer_id) continue;
    const k = `${r.command_id}|${r.property_customer_id}`;
    by.set(k, [...(by.get(k) ?? []), r]);
  }
  const seq: number[] = [], par: number[] = [], gap: number[] = [];
  for (const list of by.values()) {
    const rp = list.filter((r) => r.site === "realpro"), it = list.filter((r) => r.site === "itandi");
    if (!rp.length || !it.length) continue;
    const rpMs = rp.reduce((a, r) => a + dur(r), 0), itMs = it.reduce((a, r) => a + dur(r), 0);
    const first = Math.min(...list.map((r) => Date.parse(r.created_at))), last = Math.max(...list.map((r) => Date.parse(r.finished_at!)));
    seq.push(last - first);
    gap.push(Math.max(0, (last - first) - rpMs - itMs));
    par.push(Math.max(rpMs, itMs + 9000)); // 同時: 遅い方＋ずらし（3〜15秒の真ん中）
  }
  console.log(`両サイトの組 ${seq.length}組: 順（実測の始め〜終わり）中央値 ${min(q(seq, 0.5))}・p90 ${min(q(seq, 0.9))}／同時（見積もり＝遅い方＋ずらし）中央値 ${min(q(par, 0.5))}・p90 ${min(q(par, 0.9))}／順の間（サイトの間・入力の段）中央値 ${min(q(gap, 0.5))}`);
})();
