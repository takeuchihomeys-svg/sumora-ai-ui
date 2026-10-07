// scripts/kb-priority.ts — 設計知見に段（P0〜P3）を付ける計画を作る・当てる
// 2026-10-07 竹内「設計知見もちゃんと整理して優先順位あげれる環境もつくる　そうすれば質が良くなるから」
//   段の決まりは app/lib/design-knowledge-priority.ts。決定論の目印が先 → 言い切れない行だけ DeepSeek（推論なし・温度0・12行ずつ）。
//   DeepSeek に送る前に、お客様の名前（conversations.customer_name）と電話・メールを伏せる。費用は llm_usage_logs（action=kb-priority）にも残す。
//
// 実行:
//   npx tsx --env-file=.env.local scripts/kb-priority.ts                         … 決定論だけで数える（DB に書かない・LLM なし）
//   npx tsx --env-file=.env.local scripts/kb-priority.ts --llm --out=<plan.json>  … DeepSeek で分けた計画（JSON）と SQL（<plan>.sql）を作る（DB に書かない）
//   npx tsx --env-file=.env.local scripts/kb-priority.ts --review --plan=<plan.json> … 迷う物を memory/rules_digest_review.md の「段の要確認」に書く
//   npx tsx --env-file=.env.local scripts/kb-priority.ts --apply --plan=<plan.json>  … 計画を本番に当てる（priority 列が要る・竹内さんが流す）
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { loadKbRows } from "../app/lib/design-knowledge-curation-server";
import { DECISIONS, decisionRow, maskForLlm, type KbRow } from "../app/lib/design-knowledge-curation";
import {
  inferPriority, mergePriority, OWNER_DECISION_RE, OWNER_QUOTE_RE, parsePriorityBatch, PRIORITY_LABEL, PRIORITY_SYSTEM, priorityPromptBatch,
  type KbPriority, type PriorityDecision,
} from "../app/lib/design-knowledge-priority";
import { callDeepSeek } from "../app/lib/vision-alt-provider";
import { altPriceOf } from "../app/lib/llm-price";
import { flushLlmUsage, recordAltUsage, setScriptRouteLabel } from "../app/lib/llm-usage-recorder";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? "").split("=").slice(1).join("=");
const has = (k: string) => process.argv.includes(`--${k}`);

type Plan = { generated_at: string; decisions: PriorityDecision[]; usage: { calls: number; failed: number; input: number; cacheHit: number; output: number; usd: number; model: string } };

async function customerNames(): Promise<string[]> {
  const names = new Set<string>();
  for (let p = 0; p < 20; p++) {
    const { data, error } = await sb.from("conversations").select("customer_name").not("customer_name", "is", null).range(p * 1000, p * 1000 + 999);
    if (error) throw new Error(`conversations: ${error.message}`);
    for (const r of (data ?? []) as Array<{ customer_name: string | null }>) {
      const n = String(r.customer_name ?? "").trim();
      if (n.length >= 2 && !/^竹内/.test(n)) names.add(n);
      for (const part of n.split(/[\s　]+/)) if (part.length >= 2 && !/^竹内/.test(part)) names.add(part);
    }
    if ((data ?? []).length < 1000) break;
  }
  return [...names].sort((a, b) => b.length - a.length);
}
function makeMask(names: string[]) {
  return (s: string) => { let t = String(s ?? ""); for (const n of names) if (t.includes(n)) t = t.split(n).join("［名前］"); return maskForLlm(t); };
}

function toSql(decisions: PriorityDecision[]): string {
  const by: Record<KbPriority, string[]> = { 0: [], 1: [], 2: [], 3: [] };
  for (const d of decisions) by[d.priority].push(d.id);
  const lines = [
    "-- 設計知見の段（priority）の付与（scripts/kb-priority.ts が作成・竹内さんが流す）",
    "ALTER TABLE system_design_thinking ADD COLUMN IF NOT EXISTS priority SMALLINT;",
    "BEGIN;",
  ];
  for (const p of [0, 1, 2, 3] as KbPriority[]) {
    if (!by[p].length) continue;
    lines.push(`-- ${PRIORITY_LABEL[p]}: ${by[p].length}行`);
    for (let i = 0; i < by[p].length; i += 200) lines.push(`UPDATE system_design_thinking SET priority = ${p} WHERE id IN (${by[p].slice(i, i + 200).map((x) => `'${x}'`).join(",")});`);
  }
  lines.push("COMMIT;", "SELECT priority, count(*) FROM system_design_thinking WHERE is_current GROUP BY 1 ORDER BY 1;", "");
  return lines.join("\n");
}

function reviewSection(plan: Plan, rows: KbRow[]): string {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const t = (id: string) => { const r = byId.get(id); return r ? `${r.title.replace(/\s+/g, " ").slice(0, 90)} ［${r.created_at.slice(0, 10)}・${id.slice(0, 8)}］` : id; };
  const items = plan.decisions.filter((d) => d.review);
  const p1Ids = new Set(plan.decisions.filter((d) => d.priority === 1).map((d) => d.id));
  const p0 = rows.filter((r) => r.is_current && p1Ids.has(r.id) && /絶対|最優先|全作業|全部の(返信|場面)/.test(r.title) && !(r.tags ?? []).includes("絶対・最優先"));
  return [
    "<!-- kb-priority:start -->",
    `## 段（優先順位）の要確認（scripts/kb-priority.ts・${plan.generated_at.slice(0, 10)}）`,
    "",
    "> 段: P0 絶対・最優先／P1 今の決まり／P2 実装の知見／P3 事例・経緯。直す時は `UPDATE system_design_thinking SET priority=<段> WHERE id='<id>'`（P0 にする時は札「絶対・最優先」も足す）",
    "",
    "### P0（絶対・最優先）の候補 — P1 で題に「絶対」「最優先」「全作業」がある行（竹内さんが決める・札を足すと P0）",
    ...(p0.length ? p0.slice(0, 30).map((r) => `- ${t(r.id)}`) : ["- （なし）"]),
    "",
    `### 決定論と DeepSeek が食い違った行（${items.length}）`,
    ...(items.length ? items.slice(0, 80).map((d) => `- P${d.priority}（${d.reason}）— ${d.review}\n  - ${t(d.id)}`) : ["- （なし）"]),
    ...(items.length > 80 ? [`- …ほか ${items.length - 80}行（計画の JSON を見る）`] : []),
    "<!-- kb-priority:end -->",
    "",
  ].join("\n");
}

async function main() {
  setScriptRouteLabel("script:kb-priority");
  const planPath = arg("plan");
  if (has("apply")) {
    if (!planPath) throw new Error("--apply には --plan=<plan.json> が要る");
    const plan = JSON.parse(readFileSync(planPath, "utf8")) as Plan;
    let n = 0;
    for (const p of [0, 1, 2, 3] as KbPriority[]) {
      const ids = plan.decisions.filter((d) => d.priority === p).map((d) => d.id);
      for (let i = 0; i < ids.length; i += 200) {
        const { data, error } = await sb.from("system_design_thinking").update({ priority: p }).in("id", ids.slice(i, i + 200)).select("id");
        if (error) throw new Error(`priority=${p}: ${error.message}（列が無いなら先に ALTER）`);
        n += (data ?? []).length;
      }
    }
    console.log(`当てた: ${n}行`);
    return;
  }

  const rows = await loadKbRows(sb);
  const cur = rows.filter((r) => r.is_current);

  if (has("review")) {
    if (!planPath) throw new Error("--review には --plan=<plan.json> が要る");
    const plan = JSON.parse(readFileSync(planPath, "utf8")) as Plan;
    const f = join(process.cwd(), "memory", "rules_digest_review.md");
    const old = existsSync(f) ? readFileSync(f, "utf8") : "";
    const sec = reviewSection(plan, rows);
    const next = /<!-- kb-priority:start -->[\s\S]*<!-- kb-priority:end -->\n?/.test(old) ? old.replace(/<!-- kb-priority:start -->[\s\S]*<!-- kb-priority:end -->\n?/, sec) : `${old.replace(/\n*$/, "\n\n")}${sec}`;
    writeFileSync(f, next);
    console.log("書きました:", f);
    return;
  }

  const decIds = new Set(DECISIONS.map((d) => decisionRow(rows, d)?.id).filter(Boolean) as string[]);
  const guesses = cur.map((r) => ({ r, g: inferPriority(r, { isDecisionRow: decIds.has(r.id) }) }));
  const uncertain = guesses.filter((x) => !x.g.certain);
  const cnt = (list: Array<{ priority: KbPriority }>) => [0, 1, 2, 3].map((p) => `P${p} ${list.filter((x) => x.priority === p).length}`).join("・");
  console.log(`現行 ${cur.length}行・目印で言い切れる ${guesses.length - uncertain.length}・LLM に聞く ${uncertain.length}`);
  console.log(`  決定論だけの段: ${cnt(guesses.map((x) => x.g))}`);
  if (has("remerge")) {
    // 前の計画の DeepSeek の答えを使い回して合わせ直す（決まりを直した時・LLM を呼ばない）
    if (!planPath) throw new Error("--remerge には --plan=<plan.json> が要る");
    const old = JSON.parse(readFileSync(planPath, "utf8")) as Plan;
    const prev = new Map(old.decisions.filter((d) => d.source === "llm").map((d) => [d.id, { p: (/汎用の札で P2 に留めた/.test(d.reason) ? 3 : d.priority) as 1 | 2 | 3, why: d.reason.replace(/（汎用の札で P2 に留めた）$/, "") }]));
    const decisions = guesses.map((x) => mergePriority(x.r.id, x.g, prev.get(x.r.id), x.r));
    const plan: Plan = { generated_at: new Date().toISOString(), decisions, usage: old.usage };
    const out = arg("out") || planPath;
    writeFileSync(out, JSON.stringify(plan, null, 1));
    writeFileSync(out.replace(/\.json$/, "") + ".sql", toSql(decisions));
    console.log(`  段: ${cnt(decisions)}（要確認 ${decisions.filter((d) => d.review).length}・前の答えが無い行 ${guesses.filter((x) => !x.g.certain && !prev.has(x.r.id)).length}）\n  計画: ${out}`);
    return;
  }
  if (!has("llm")) return;

  const mask = makeMask(await customerNames());
  const B = Number(arg("batch") || 12);
  const llm = new Map<string, { p: 1 | 2 | 3; why: string }>();
  const usage = { calls: 0, failed: 0, input: 0, cacheHit: 0, output: 0, usd: 0, model: "" };
  const limit = Number(arg("limit") || uncertain.length);
  const target = uncertain.slice(0, limit);
  for (let i = 0; i < target.length; i += B) {
    const chunk = target.slice(i, i + B);
    const prompt = priorityPromptBatch(chunk.map((x, k) => ({
      n: k + 1, title: x.r.title, insight: x.r.insight,
      ownerQuote: OWNER_QUOTE_RE.test(`${x.r.insight}\n${x.r.context ?? ""}`), ownerDecision: OWNER_DECISION_RE.test(`${x.r.insight}\n${x.r.context ?? ""}`),
    })), mask);
    const t0 = Date.now();
    usage.calls++;
    const res = await callDeepSeek(PRIORITY_SYSTEM, prompt, { thinking: false, temperature: 0, maxTokens: 60 + chunk.length * 40, timeoutMs: 60_000 });
    if (res) {
      usage.model = res.model;
      usage.input += res.usage.input; usage.cacheHit += res.usage.cacheHit; usage.output += res.usage.output;
      recordAltUsage({ model: res.model, action: "kb-priority", conversationId: null, usage: { input_tokens: res.usage.cacheMiss, cache_read_input_tokens: res.usage.cacheHit, output_tokens: res.usage.output }, status: 200, errorType: null, durationMs: Date.now() - t0, sysHead: PRIORITY_SYSTEM, sysKeyFull: null, maxTokens: 60 + chunk.length * 40 });
    }
    const parsed = res ? parsePriorityBatch(res.text) : new Map();
    chunk.forEach((x, k) => { const v = parsed.get(k + 1); if (v) llm.set(x.r.id, v); else usage.failed++; });
    process.stdout.write(`\r  DeepSeek ${Math.min(i + B, target.length)}/${target.length}`);
  }
  console.log("");
  const price = altPriceOf(usage.model || "deepseek");
  if (price) usage.usd = ((usage.input - usage.cacheHit) * price.in + usage.cacheHit * price.read + usage.output * price.out) / 1e6;
  const decisions = guesses.map((x) => mergePriority(x.r.id, x.g, llm.get(x.r.id), x.r));
  const plan: Plan = { generated_at: new Date().toISOString(), decisions, usage };
  const out = arg("out") || join(process.env.TEMP ?? process.cwd(), "kb-priority-plan.json");
  writeFileSync(out, JSON.stringify(plan, null, 1));
  writeFileSync(out.replace(/\.json$/, "") + ".sql", toSql(decisions));
  console.log(`  段: ${cnt(decisions)}（LLM ${decisions.filter((d) => d.source === "llm").length}・答えなしで推定 ${decisions.filter((d) => d.source === "fallback").length}・要確認 ${decisions.filter((d) => d.review).length}）`);
  console.log(`  DeepSeek ${usage.calls}回（答えなし ${usage.failed}行）・入力 ${usage.input}（キャッシュ ${usage.cacheHit}）・出力 ${usage.output}・約 $${usage.usd.toFixed(4)}（混む時間は2倍）・${usage.model}`);
  console.log(`  計画: ${out}\n  SQL: ${out.replace(/\.json$/, "")}.sql`);
  await flushLlmUsage();
}
main().catch((e) => { console.error(e); process.exit(1); });
