// 検索の点検の報告（原因ごとの Markdown）。2026-09-25 竹内「検索がちゃんとされていなかったら原因を見つけられるようにする」
// 実行: npx tsx --env-file=.env.local scripts/search-audit-report.ts --days=7
//   読むだけ（書き込みなし・DeepSeek を呼ばない）。お客様の名前は出さない（search_audits に元から無い）
import { createClient } from "@supabase/supabase-js";
import { causeTitle, type AuditCheck } from "../app/lib/search-audit-check";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d: string) => (process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1] ?? d);
const days = Math.max(1, Math.min(90, Number(arg("days", "7")) || 7));

type Row = { run_id: string; created_at: string; status: string; site: string | null; trigger: string | null; mode: string | null; severity: string | null; cause_key: string | null; checks: AuditCheck[] | null; ai_status: string | null; ai_diagnosis: Record<string, unknown> | null; ext_version: string | null; result: Record<string, unknown> | null };

(async () => {
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const { data, error } = await sb.from("search_audits")
    .select("run_id, created_at, status, site, trigger, mode, severity, cause_key, checks, ai_status, ai_diagnosis, ext_version, result")
    .gte("created_at", since).order("created_at", { ascending: true }).limit(5000);
  if (error) { console.error("読めない:", error.message); process.exit(1); }
  const rows = (data ?? []) as Row[];
  const causes = await sb.from("search_audit_causes").select("cause_key, status, fixed_in_version, fix_hint, count_total");
  if (causes.error) { console.error("原因の表が読めない:", causes.error.message); process.exit(1); }
  const cmap = new Map(((causes.data ?? []) as Array<{ cause_key: string; status: string; fixed_in_version: string | null; fix_hint: string | null; count_total: number }>).map((c) => [c.cause_key, c] as const));

  const bySev = { ok: 0, warn: 0, bad: 0, none: 0 } as Record<string, number>;
  const bySite = new Map<string, number>();
  const byTrigger = new Map<string, number>();
  const agg = new Map<string, { n: number; bad: number; runs: string[]; sites: Set<string>; diag: Record<string, unknown> | null; details: string[] }>();
  for (const r of rows) {
    bySev[r.severity ?? "none"] = (bySev[r.severity ?? "none"] ?? 0) + 1;
    bySite.set(r.site ?? "?", (bySite.get(r.site ?? "?") ?? 0) + 1);
    byTrigger.set(r.trigger ?? "?", (byTrigger.get(r.trigger ?? "?") ?? 0) + 1);
    const seen = new Set<string>();
    for (const c of r.checks ?? []) {
      if (c.severity === "ok" || seen.has(c.cause_key)) continue;
      seen.add(c.cause_key);
      const a = agg.get(c.cause_key) ?? { n: 0, bad: 0, runs: [], sites: new Set<string>(), diag: null, details: [] };
      a.n++; if (c.severity === "bad") a.bad++;
      a.runs.push(r.run_id); a.sites.add(r.site ?? "?");
      if (a.details.length < 3) a.details.push(c.detail);
      if (r.cause_key === c.cause_key && r.ai_diagnosis && !(r.ai_diagnosis as { failed?: boolean }).failed) a.diag = r.ai_diagnosis;
      agg.set(c.cause_key, a);
    }
  }
  const sorted = Array.from(agg.entries()).sort((x, y) => y[1].bad - x[1].bad || y[1].n - x[1].n);

  const out: string[] = [];
  out.push(`# 検索の点検 — 直近${days}日（${new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })} 時点）`, "");
  out.push(`- 検索の回: ${rows.length}回（重い ${bySev.bad}・注意 ${bySev.warn}・問題なし ${bySev.ok}・途中/未点検 ${bySev.none}）`);
  out.push(`- サイト: ${Array.from(bySite.entries()).map(([k, v]) => `${k} ${v}`).join("・") || "なし"}`);
  out.push(`- 起動: ${Array.from(byTrigger.entries()).map(([k, v]) => `${k} ${v}`).join("・") || "なし"}`);
  out.push(`- DeepSeek の見立て: ${rows.filter((r) => r.ai_status === "done").length}件（使い回し ${rows.filter((r) => r.ai_status === "reused").length}・失敗 ${rows.filter((r) => r.ai_status === "failed").length}・待ち ${rows.filter((r) => r.ai_status === "pending").length}）`, "");
  out.push(`## 原因ごと（重い順）`, "");
  if (!sorted.length) out.push("（原因なし）");
  for (const [key, a] of sorted) {
    const c = cmap.get(key);
    const st = c ? (c.status === "fixed" ? `直した ${c.fixed_in_version ?? ""}` : c.status === "ignored" ? "無視" : "未対応") : "未対応";
    out.push(`### ${causeTitle(key)}  — ${a.n}回（重い ${a.bad}）・${st}`);
    out.push(`- 鍵: \`${key}\``);
    for (const d of a.details) out.push(`- 例: ${d}`);
    const dg = a.diag as { cause_ja?: string; fix_ja?: string; where?: { file?: string; function?: string } } | null;
    if (dg?.cause_ja) out.push(`- 見立て: ${dg.cause_ja}`);
    if (dg?.fix_ja) out.push(`- 直し方の案: ${dg.fix_ja}${dg.where?.file ? `（${dg.where.file}${dg.where.function ? ` ${dg.where.function}` : ""}）` : ""}`);
    else if (c?.fix_hint) out.push(`- 直し方の案: ${c.fix_hint.replace(/\n/g, " ")}`);
    out.push(`- 例の回: ${a.runs.slice(-3).join("、")}`, "");
  }
  console.log(out.join("\n"));
})();
