// scripts/check-foundation.ts — 自己改善の芯 ①「土台が無い」の点検（読むだけ・LLM なし・費用0・作業員N・2026-11-21・台帳 #473）
//
// 竹内さん 11/21「足りていない土台を見つける…を自己改善の仕組で特に強化すれば更に質が上がる」。
//   土台の表（scripts/lib/foundation-table.ts の形）を全部読み、決まり → 物差し → 本番の数字 → 担当の部品 のどれが欠けているかを出す。
//   表: 作業員N の土台8つ（FOUNDATION_N）＋ memory/foundation_tables/*.json（作業員K2 の AIX の表・作業員G の統括Pro の F ほか・同じ形）。
//   数: core:foundation = 4列そろった行の割合（%）。欠けた行は持ち主つきで直しの候補へ（self-improve）。
// 実行: npx tsx --env-file=.env.local scripts/check-foundation.ts [--json]
import { createClient } from "@supabase/supabase-js";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { FOUNDATION_N, foundationGapsOf, type FoundationRow } from "./lib/foundation-table";
import { LINKAGE_SWITCH_DEFAULTS } from "../app/lib/linkage-switch-defaults";

/** origin/main にその道のファイルがあるか（git cat-file・手元の git だけ・費用0） */
export function inOriginMain(p: string): boolean {
  try { execFileSync("git", ["cat-file", "-e", `origin/main:${p.replace(/^\.\//, "")}`], { stdio: "ignore", timeout: 10_000 }); return true; } catch { return false; }
}

export const FOUNDATION_TABLE_DIR = "C:/Users/竹内 悠馬/sumora-ai-ui/memory/foundation_tables";

export function otherTables(): FoundationRow[] {
  if (!existsSync(FOUNDATION_TABLE_DIR)) return [];
  const out: FoundationRow[] = [];
  for (const f of readdirSync(FOUNDATION_TABLE_DIR).filter((x) => x.endsWith(".json"))) {
    try { const j = JSON.parse(readFileSync(join(FOUNDATION_TABLE_DIR, f), "utf8")); for (const r of (Array.isArray(j) ? j : j.rows ?? [])) out.push(r as FoundationRow); } catch { /* 形の違う表は飛ばす（出力に出す） */ console.warn(`読めない表: ${f}`); }
  }
  return out;
}

export async function checkFoundation() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");
  const rows = [...FOUNDATION_N, ...otherTables()];
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
  const { data } = await sb.from("quality_daily").select("metric").gte("day", since).limit(5000);
  const seen = new Set(((data ?? []) as Array<{ metric: string }>).map((r) => r.metric));
  const codeText = (() => { try { return readdirSync("app/lib").filter((f) => f.endsWith(".ts")).map((f) => readFileSync(join("app/lib", f), "utf8")).join("\n"); } catch { return ""; } })();
  const gaps = foundationGapsOf(rows, {
    // 2026-11-21 統括役: 作業ツリーが古いと台本を見落とす＝今の作業ツリーか origin/main のどちらかにあれば、ある事にする
    scriptExists: (p) => existsSync(p) || inOriginMain(p),
    metricSeen: (m) => seen.has(m),
    switchKnown: (s) => s in LINKAGE_SWITCH_DEFAULTS || codeText.includes(s),
  });
  const full = rows.length - gaps.length;
  // 2026-11-21 土台の埋まりの表（foundation-fill）が同じ行と数の有無を使う
  const metricsSeen = rows.flatMap((r) => [r.metric, ...(r.metricAlt ?? [])]).filter((m): m is string => !!m && seen.has(m));
  return { rows, metricsSeen, n: rows.length, full, score: rows.length ? Math.round((full / rows.length) * 1000) / 10 : null, gaps, tables: ["N", ...(existsSync(FOUNDATION_TABLE_DIR) ? readdirSync(FOUNDATION_TABLE_DIR).filter((x) => x.endsWith(".json")) : [])] };
}

if (process.argv[1]?.endsWith("check-foundation.ts")) checkFoundation().then((r) => {
  if (process.argv.includes("--json")) { console.log(JSON.stringify(r)); return; }
  console.log(`土台が無い（表 ${r.tables.join("・")}・土台 ${r.n}・4列そろった ${r.full}＝${r.score ?? "—"}%）`);
  for (const g of r.gaps) console.log(`- ${g.name}（${g.owner}）: 欠け ${g.missing.join("・")}｜${g.detail.slice(0, 140)}`);
}).catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
