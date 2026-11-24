// scripts/audit-off-cost.ts — 台帳の built_off の行を on にした時の費用の種類（0／入力増／呼び出し増／未確認）と、全部 on にした時の1日の増え（読むだけ・LLM なし）
// 実行: npx tsx --env-file=.env.local scripts/audit-off-cost.ts [--json=<file>]
//   DB は work_items（built_off）と llm_usage_logs（直近7日・action×model の平均と件数だけ）。コードは app/ の静的な読み。
// 2026-11-24 作業員A（竹内さん 11/24「全部 on にしたら費用が上がるか」・統括役の頼み・#675 の1列）。分け方は scripts/lib/off-cost.ts
import { createClient } from "@supabase/supabase-js";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { costOfSites, usdPerCall, COST_JA, type CostSite } from "./lib/off-cost";
import { altPriceOf, claudePriceOf } from "../app/lib/llm-price";

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? "";
const FILES: Array<{ path: string; lines: string[] }> = [];
const walk = (d: string) => { for (const f of readdirSync(d)) { if (f === "node_modules" || f === "__tests__" || f.startsWith(".")) continue; const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (/\.(ts|tsx)$/.test(f)) FILES.push({ path: p.replace(/\\/g, "/"), lines: readFileSync(p, "utf8").split(/\r?\n/) }); } };
walk("app");

(async () => {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");
  const { data, error } = await sb.from("work_items").select("id, title, owner, switch_name").eq("stage", "built_off").order("id");
  if (error) throw error;
  const items = (data ?? []) as Array<{ id: number; title: string; owner: string | null; switch_name: string | null }>;
  // 直近7日の LLM の平均（action×model）と1日の番の数（軽い読み・日付で絞る）
  const since = new Date(Date.now() - 7 * 86400e3).toISOString();
  const usage = new Map<string, { n: number; inu: number; cr: number; cw: number; out: number; ms: number; model: string }>();
  for (let from = 0; ; from += 1000) {
    const { data: u, error: e } = await sb.from("llm_usage_logs").select("action, model, input_uncached, cache_read, cache_write, output_tokens, thinking_tokens, duration_ms").gte("created_at", since).range(from, from + 999);
    if (e) throw e;
    for (const r of (u ?? []) as Array<Record<string, number | string | null>>) {
      const k = String(r.action ?? "?");
      const s = usage.get(k) ?? { n: 0, inu: 0, cr: 0, cw: 0, out: 0, ms: 0, model: String(r.model ?? "") };
      s.n++; s.inu += Number(r.input_uncached ?? 0); s.cr += Number(r.cache_read ?? 0); s.cw += Number(r.cache_write ?? 0); s.out += Number(r.output_tokens ?? 0) + Number(r.thinking_tokens ?? 0); s.ms += Number(r.duration_ms ?? 0);
      usage.set(k, s);
    }
    if (!u || u.length < 1000) break;
  }
  const perDay = (a: string) => (usage.get(a)?.n ?? 0) / 7;
  const turnsPerDay: Record<string, number> = {
    brain: perDay("brain_fresh") + perDay("brain_full") + perDay("brain_fresh_claude"),
    reply: perDay("reply_generate") + perDay("reply_generate_claude_writer"),
    aix: perDay("aix_template"),
  };
  const usdOfAction = (a: string): number | null => {
    const s = usage.get(a); if (!s || !s.n) return null;
    const avg = { inu: s.inu / s.n, cr: s.cr / s.n, cw: s.cw / s.n, out: s.out / s.n };
    const alt = altPriceOf(s.model); if (alt) return usdPerCall(avg, alt);
    const cl = claudePriceOf(s.model); return cl ? usdPerCall(avg, { in: cl.in, read: cl.read, out: cl.out }) : null;
  };

  const actionOfModule = (mod: string): string | null => {
    const f = FILES.find((x) => x.path.endsWith(`/${mod}.ts`)); if (!f) return null;
    const txt = f.lines.join("\n");
    const m = txt.match(/logLlmUsage\(\s*(?:["']([\w:.-]+)["']|([A-Z_][A-Z0-9_]*))/); if (!m) return null;
    if (m[1]) return m[1];
    const c = txt.match(new RegExp(`${m[2]}\\s*=\\s*["']([\\w:.-]+)["']`)); return c ? c[1] : null;
  };
  type CostRow = { id: number; title: string; owner: string | null; switch_name: string | null; kind: "zero" | "input" | "call" | "unknown"; evidence: string; perDayUsd: number | null; pos?: "前" | "後ろ" | "未確認"; waits?: boolean; module?: string; action?: string | null; perCall?: number | null; msAvg?: number | null; running?: boolean };
  const rows: CostRow[] = items.map((it): CostRow => {
    const sw = it.switch_name;
    if (!sw) return { ...it, kind: "unknown" as const, evidence: "スイッチ無し（コードの直し）", perDayUsd: null as number | null };
    const re = new RegExp(`env\\.${sw}\\b|\\b${sw}\\b[^\\n]{0,40}\\?\\?`);
    let read: { f: (typeof FILES)[number]; k: number } | null = null;
    for (const f of FILES) { const k = f.lines.findIndex((l) => re.test(l)); if (k >= 0) { read = { f, k }; break; } }
    if (!read) return { ...it, kind: "unknown" as const, evidence: "env の読みが無い", perDayUsd: null };
    // 入口の関数の名前（読む行か上の4行の export function/const）
    let gate: string | null = null;
    for (let j = read.k; j >= Math.max(0, read.k - 4) && !gate; j--) { const m = read.f.lines[j].match(/export\s+(?:function|const)\s+(\w+)/); if (m) gate = m[1]; }
    const sites: CostSite[] = [];
    if (gate) {
      const gre = new RegExp(`\\b${gate}\\(`);
      for (const f of FILES) f.lines.forEach((l, i) => { if (gre.test(l) && !/export\s+(?:function|const)/.test(l)) sites.push({ file: f.path, line: i + 1, text: l }); });
      // 一度だけ読んで定数に入れる形（const X_ON = gate()）は、その定数を使う所も見る
      for (const s of [...sites]) { const c = s.text.match(/const\s+([A-Z][A-Z0-9_]*)\s*=\s*\w+\(/); if (!c) continue; const cre = new RegExp(`\\b${c[1]}\\b`); const f = FILES.find((x) => x.path === s.file)!; f.lines.forEach((l, i) => { if (cre.test(l) && i + 1 !== s.line) sites.push({ file: s.file, line: i + 1, text: l }); }); }
    } else sites.push({ file: read.f.path, line: read.k + 1, text: read.f.lines[read.k] });
    const winOf = (s: CostSite) => FILES.find((x) => x.path === s.file)!.lines.slice(s.line - 1, s.line + 6).join("\n"); // 呼ぶ行から下6行（広いと別の呼び出しを拾う）
    const v = costOfSites(sites.slice(0, 40), winOf, (mod) => { const f = FILES.find((x) => x.path.endsWith(`/${mod}.ts`)); return !!f && /logLlmUsage|anthropic|deepseek|messages\.create/.test(f.lines.join("\n")); });
    let running = false; let perDayUsd: number | null = null, action: string | null = null, perCall: number | null = null, msAvg: number | null = null;
    if (v.kind === "call" && v.module) {
      action = actionOfModule(v.module) ?? (() => { const g = v.module!.replace(/-server$/, "").replace(/-/g, "_"); return usage.has(g) ? g : null; })();
      perCall = action ? usdOfAction(action) : null;
      const u = action ? usage.get(action) : undefined; msAvg = u && u.n ? Math.round(u.ms / u.n) : null;
      const where = /brain-core/.test(v.evidence) ? "brain" : /generate-reply/.test(v.evidence) ? "reply" : /aix-template-generate/.test(v.evidence) ? "aix" : null;
      // 今も記録に出ている呼び出し（既定が shadow・本番の環境で on 等）は今の1日の数で＝on にしても増えない。出ていない物は毎番呼ぶと見た上限
      running = !!u && u.n > 0;
      perDayUsd = perCall == null ? null : running ? perCall * u!.n / 7 : where ? perCall * turnsPerDay[where] : null;
    }
    return { ...it, kind: v.kind, pos: v.pos, waits: v.waits, module: v.module, action, perCall, msAvg, perDayUsd, running, evidence: v.evidence };
  });
  const c = (k: string) => rows.filter((r) => r.kind === k).length;
  console.log(`■ built_off ${rows.length}行を on にした時の費用の種類: ${["zero", "input", "call", "unknown"].map((k) => `${COST_JA[k as keyof typeof COST_JA]} ${c(k)}`).join("・")}`);
  console.log(`  入力増の位置: 前（指示文の固定部分＝キャッシュが切れる）${rows.filter((r) => r.kind === "input" && r.pos === "前").length}・後ろ ${rows.filter((r) => r.kind === "input" && r.pos === "後ろ").length}`);
  console.log(`  呼び出し増のうち本番のブレイン・返信の中で待つ: ${rows.filter((r) => r.kind === "call" && r.waits).length}`);
  console.log(`  1日の番の数（直近7日の llm_usage_logs）: ブレイン ${turnsPerDay.brain.toFixed(0)}・返信 ${turnsPerDay.reply.toFixed(0)}・AIX の文 ${turnsPerDay.aix.toFixed(0)}`);
  const priced = rows.filter((r) => r.perDayUsd != null).sort((a, b) => (b.perDayUsd ?? 0) - (a.perDayUsd ?? 0));
  const total = priced.filter((r) => !(r as { running?: boolean }).running).reduce((s, r) => s + (r.perDayUsd ?? 0), 0);
  const nowRun = priced.filter((r) => (r as { running?: boolean }).running);
  console.log(`\n■ 全部 on にした時の1日の増え（呼び出し増で $ が出せた行のうち、今は呼ばれていない物の和・毎番呼ぶと見た上限）: $${total.toFixed(2)}/日`);
  console.log(`  台帳は off でも今すでに呼ばれている（増えない・台帳が古い）: ${nowRun.map((r) => `#${r.id} ${r.switch_name} $${(r.perDayUsd ?? 0).toFixed(2)}/日`).join("・") || "なし"}`);
  console.log(`  $ が出せない呼び出し増 ${rows.filter((r) => r.kind === "call" && r.perDayUsd == null).length}行・入力増 ${c("input")}行（トークンの増えは未確認＝夜の試験の材料の字数で測る）`);
  console.log(`\n■ 上位10行`);
  for (const r of priced.slice(0, 10)) console.log(`  #${r.id} ${r.switch_name}: $${(r.perDayUsd ?? 0).toFixed(2)}/日（1回 $${(r.perCall ?? 0).toFixed(4)}・${r.action}・平均 ${r.msAvg ?? "?"}ms${r.waits ? "・本番で待つ" : ""}${(r as { running?: boolean }).running ? "・今も呼ばれている" : ""}）${r.evidence}`);
  if (arg("json")) writeFileSync(arg("json"), JSON.stringify(rows, null, 1));
})().catch((e) => { console.error(e); process.exit(1); });
