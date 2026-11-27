// scripts/audit-rule-code-drift.ts — 決まり（設計知見）とコードの食い違いの一覧（台帳 #818・LLM なし・DB は設計知見と台帳の軽い読みだけ）
// 2026-11-27 作業員L（統括役の頼み）: 毎週の整理（kb-curate）の時に回す。既定は一覧を出すだけ。--ledger で食い違いを持ち主つきで台帳（work_items・origin=found_gap）に積む（題で重ねない）
// 実行: npx tsx --env-file=.env.local scripts/audit-rule-code-drift.ts [--ledger] [--json=<file>]
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync } from "node:fs";
import { examCacheRoot } from "./lib/llm-cassette";
import { join } from "node:path";
import { ruleCodeDrift, scanCodeDefaults, driftLedgerTitle, scanIdLinks, idLinkDrift, partialOverrides, type KbRow } from "./lib/rule-code-drift";

const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const flag = (k: string) => process.argv.includes(`--${k}`);

async function main() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)!, { auth: { persistSession: false } });
  const rows: KbRow[] = [];
  for (let from = 0; from < 20_000; from += 1000) {
    const { data, error } = await sb.from("system_design_thinking").select("id, title, insight, rationale, applied_to, tags, is_current, priority, retired_reason, superseded_by").order("created_at", { ascending: true }).range(from, from + 999);
    if (error) throw new Error(error.message);
    rows.push(...((data ?? []) as KbRow[]));
    if (!data || data.length < 1000) break;
  }
  const code = scanCodeDefaults([join(process.cwd(), "app", "lib"), join(process.cwd(), "app", "api")]);
  const roots = [join(process.cwd(), "app", "lib"), join(process.cwd(), "app", "api")];
  const byName = ruleCodeDrift(rows, code);
  // コメントが設計知見の id を根拠に書いている所も照らす（名前で見つけた組と重ねない）
  const nameKeys = new Set(byName.map((d) => `${d.id}|${d.sw}`));
  const ds = [...byName, ...idLinkDrift(rows, scanIdLinks(roots)).filter((d) => !nameKeys.has(`${d.id}|${d.sw}`))];
  // 持ち主: そのスイッチの台帳の行の持ち主（無ければ統括役）
  const { data: wi } = await sb.from("work_items").select("switch_name, owner").not("switch_name", "is", null).not("owner", "is", null).limit(3000);
  const ownerOf = new Map<string, string>(((wi ?? []) as Array<{ switch_name: string; owner: string }>).map((r) => [r.switch_name, r.owner]));
  const byId = new Map(rows.map((r) => [r.id, r]));
  // 本番の env（係が控える prod-env.json）: コードの既定と本番の値が違う物を添える（コードは off でも本番 env で on なら決まりは生きている）
  const prodEnv: Record<string, string> = (() => { try { return (JSON.parse(readFileSync(join(examCacheRoot(), "exam-queue", "prod-env.json"), "utf8")) as { env?: Record<string, string> }).env ?? {}; } catch { return {}; } })();
  const prodOf = (sw: string) => (sw in prodEnv ? `｜本番 env: ${prodEnv[sw]}` : "");
  console.log(`決まりとコードの食い違い（設計知見 ${rows.length}行・現行 ${rows.filter((r) => r.is_current).length}・コードのスイッチ ${code.defaults.size}）: ${ds.length}組`);
  for (const kind of ["退役・コードは生きている", "決まりは生きている・コードは止まっている", "決まりは生きている・コードに無い"] as const) {
    const xs = ds.filter((d) => d.kind === kind).sort((a, b) => (a.currentMentions ?? 0) - (b.currentMentions ?? 0));
    console.log(`\n## ${kind}（${xs.length}）`);
    for (const d of xs) {
      const sup = d.supersededBy ? byId.get(d.supersededBy) : null;
      console.log(`- ${d.sw}｜${d.id.slice(0, 8)}${d.priority != null ? ` P${d.priority}` : ""}「${d.title}」｜コード: 既定 ${d.code}${prodOf(d.sw)}${d.where.length ? `（${d.where.join("・")}）` : ""}${d.retiredReason ? `｜退役の理由: ${String(d.retiredReason).slice(0, 60)}` : ""}${d.supersededBy ? `｜代わり: ${d.supersededBy.slice(0, 8)}${sup ? `「${String(sup.title ?? "").slice(0, 40)}」` : ""}` : ""}${d.currentMentions != null ? `｜現行の行にも ${d.currentMentions}` : ""}｜持ち主: ${ownerOf.get(d.sw) ?? "統括役"}`);
    }
  }
  // 2026-11-27 作業員L（#822 の続き・統括役の決め 2）: 現行の P0/P1 の決まり同士の一部の上書き（同じ関数を持つ2行・新しい方に上書きの語・古い方に追記も superseded_by も無い）。要確認に出すだけ（直さない・台帳にも積まない）
  const po = partialOverrides(rows);
  console.log(`
## 決まり同士の一部の上書き（要確認・${po.length}組）: 古い行に「新しい id で上書き」の1文を足すか、退役か`);
  for (const p of po) console.log(`- 古 ${p.oldId.slice(0, 8)}「${p.oldTitle.slice(0, 50)}」← 新 ${p.newId.slice(0, 8)}「${p.newTitle.slice(0, 50)}」｜同じ関数: ${p.fns.join("・")}｜語: ${p.word}`);
  if (arg("json")) writeFileSync(arg("json"), JSON.stringify({ drift: ds, partialOverrides: po }, null, 1));
  if (flag("ledger")) {
    const { data: open } = await sb.from("work_items").select("title").like("title", "決まりとコードの食い違い: %").not("stage", "in", "(done,dropped)").limit(1000);
    const have = new Set(((open ?? []) as Array<{ title: string }>).map((r) => r.title));
    let n = 0;
    for (const d of ds) {
      const title = driftLedgerTitle(d); if (have.has(title)) continue;
      const { error } = await sb.from("work_items").insert({ title, origin: "found_gap", stage: "todo", area: "土台", owner: ownerOf.get(d.sw) ?? "統括役", priority: d.kind === "退役・コードは生きている" ? 20 : 10, switch_name: d.sw, next_step: `audit-rule-code-drift（#818）: 設計知見 ${d.id.slice(0, 8)} とコード（${d.where.join("・") || "無し"}）を照らし、どちらを直すか決める（記録だけ・自動では変えない）` });
      if (!error) { n++; have.add(title); }
    }
    console.log(`\n台帳に積んだ: ${n}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
