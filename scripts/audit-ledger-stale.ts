// scripts/audit-ledger-stale.ts — 「作ってあるのに台帳は todo のまま」の候補の一覧（読むだけ・LLM なし・統括役の頼み 11/28・作業員L）
//   DB は台帳（work_items）の読み1回だけ。git log --all（件名に #id のあるコミット）1回・git grep（コードの中の大文字の名前）2回・ファイルの有る無しで引き当てる。
//   台帳は書き換えない（統括役が一覧を見てから）。
// 実行: npx tsx --env-file=.env.local scripts/audit-ledger-stale.ts [--owners=作業員L,作業員A] [--stages=todo] [--since=2026-10-15] [--json=<path>]
import { createClient } from "@supabase/supabase-js";
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { staleRowOf, VERDICT_JA, type GitCommit, type LedgerItem, type StaleRow } from "./lib/ledger-stale";
import { LINKAGE_SWITCH_DEFAULTS } from "../app/lib/linkage-switch-defaults";

const argv = process.argv.slice(2);
const arg = (k: string, d = "") => argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const git = (args: string[]) => { try { return execFileSync("git", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }); } catch (e) { const out = (e as { stdout?: string }).stdout; return typeof out === "string" ? out : ""; } };

async function main() {
  const owners = arg("owners", "作業員L,作業員A").split(",").map((s) => s.trim()).filter(Boolean);
  const stages = arg("stages", "todo").split(",").map((s) => s.trim()).filter(Boolean);
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "", { auth: { persistSession: false } });
  const { data, error } = await sb.from("work_items").select("id,title,next_step,switch_name,owner,stage,commits,updated_at").in("owner", owners).in("stage", stages).order("priority", { ascending: true, nullsFirst: false }).limit(2000);
  if (error) throw new Error(`work_items: ${error.message}`);
  const items = (data ?? []) as LedgerItem[];

  const commits: GitCommit[] = git(["log", "--all", `--since=${arg("since", "2026-10-15")}`, "--format=%h%x09%cs%x09%s"]).split("\n").filter(Boolean).map((l) => { const [hash, date, ...s] = l.split("\t"); return { hash, date, subject: s.join("\t") }; });
  const hash7 = new Set(commits.map((c) => c.hash.slice(0, 7)));
  const names = new Set<string>();
  for (const ref of ["HEAD", "origin/main"]) for (const n of git(["grep", "-h", "-o", "-E", "\\b[A-Z][A-Z0-9]+(_[A-Z0-9]+)+\\b", ref, "--", "app", "scripts"]).split("\n")) { const m = n.replace(/^[^:]*:/, "").trim(); if (m) names.add(m); }

  const rows: StaleRow[] = items.map((it) => staleRowOf(it, { commits, codeNames: names, defaults: LINKAGE_SWITCH_DEFAULTS, fileExists: (p) => existsSync(p) || existsSync(`app/lib/${p}`) || existsSync(`scripts/${p}`) || existsSync(`scripts/lib/${p}`), knownHash: (h) => hash7.has(h.slice(0, 7)) }));
  const order = ["done_candidate", "built_off_candidate", "partly", "not_built"] as const;
  console.log(`台帳の ${stages.join("・")}（持ち主 ${owners.join("・")}）${rows.length}件・コミット ${commits.length}・コードの名前 ${names.size}`);
  for (const o of owners) {
    const mine = rows.filter((r) => r.owner === o);
    console.log(`\n## ${o}（${mine.length}件）: ${order.map((v) => `${VERDICT_JA[v]} ${mine.filter((r) => r.verdict === v).length}`).join("・")}`);
    for (const v of order.slice(0, 3)) {
      const rs = mine.filter((r) => r.verdict === v);
      if (!rs.length) continue;
      console.log(`### ${VERDICT_JA[v]}（${rs.length}）`);
      for (const r of rs) console.log(`- #${r.id}｜${r.title}｜${r.why}${r.refCommits.length ? `｜最後 ${r.refCommits[0].hash} ${r.refCommits[0].date}` : ""}`);
    }
  }
  const j = arg("json");
  if (j) writeFileSync(j, JSON.stringify({ at: new Date().toISOString(), owners, stages, rows }, null, 1));
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
