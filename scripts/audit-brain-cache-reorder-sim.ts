// scripts/audit-brain-cache-reorder-sim.ts — ブレイン（brain_fresh）のキャッシュの並べ替えの損得を本番の呼び出しの並びで見積もる（読むだけ・LLM なし）
//   2026-10-07 竹内「この3つもはかって！！質は絶対に落ちないように」の③。
//   今: system[静的 1h] → system[DB 由来 1h] → 会話専用 A[5分] → 会話専用 B[5分] → 毎回の材料（印なし: アクション別ルール → テンプレ → … → 会話履歴）
//   案: system[静的] → system[DB 由来] → アクション別ルール[1h・会話をまたいで同じ＝局面の候補で決まる] → A＋B（印なし or 1つ）→ 残り
//     ・アクション別ルールは「局面の候補（前回のフェーズ＋前回の AIX）・ステータスの条件付きルール」だけで決まり、会話ごとの物を含まない
//     ・会話専用の5分の印は本番で 974回書いて 61回しか読めていない（audit-brain-cost-levers）→ 外しても失う割引は小さい
//   見積もりの作り方: 本番の brain_fresh の並び（時刻）に、その時点の局面（直前の判断の conversation_status → フェーズ・前回の AIX）を当て、
//     同じ候補の組を1つの鍵にして TTL（1h・読むたび延長）で書き/読みを数える。system が書き直された回（1h書き>0）は全部の鍵を捨てる（前置きが変わる）。
//   ⚠ フェーズは本番の conversation_direction.current_phase の履歴が無いので status から推す（候補の組の数は実際より少なく出うる → 感度として「鍵を倍に割った時」も出す）
// 実行: npx tsx --env-file=.env.local scripts/audit-brain-cache-reorder-sim.ts [--since=2026-09-23]
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const SINCE = arg("since", "2026-09-23T00:00:00+09:00");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ms = (s: string) => Date.parse(s);
async function readAll<T>(q: (f: number, t: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < 200_000; i += 1000) { const r = await q(i, i + 999); if (r.error) throw new Error(r.error.message); const d = (r.data ?? []) as T[]; out.push(...d); if (d.length < 1000) break; await sleep(300); }
  return out;
}
// brain-core の写し（PHASE_ACTION_CANDIDATES・STATUS_TO_PHASE は module の外に出ていないので同じ値をここに置く・2026-10-07 時点）
const PHASE_ACTION_CANDIDATES: Record<string, string[]> = {
  hearing: ["condition_hearing", "property_search", "property_send", "followup_revive", "phone_call"],
  proposing: ["property_send", "property_recommendation", "property_search", "acknowledge_check", "property_check_result", "estimate_sheet", "cost_explain", "cost_breakdown", "viewing_invite", "followup_revive", "phone_call", "guarantor_info"],
  viewing: ["viewing_invite", "meeting_place", "greeting_viewing", "estimate_sheet", "cost_explain", "cost_breakdown", "phone_call", "guarantor_info", "application_push", "property_check_result", "property_send"],
  applying: ["application_push", "estimate_sheet", "cost_explain", "cost_breakdown", "acknowledge_check", "phone_call", "guarantor_info"],
};
const STATUS_TO_PHASE: Record<string, string> = { first_reply: "hearing", hearing: "hearing", condition_hearing: "hearing", property_search: "hearing", proposing: "proposing", property_recommendation: "proposing", estimate_request: "proposing", availability_check: "proposing", viewing: "viewing", applying: "applying", application: "applying", screening: "applying" };

(async () => {
  const { STATIC_BRAIN_SYSTEM, loadBrainSystemInputs, buildBrainSystemBlocks } = await import("../app/lib/brain-core");
  const sys = buildBrainSystemBlocks(await loadBrainSystemInputs());
  const sysChars = sys.blocks.reduce((a, b) => a + b.text.length, 0);
  const { data: warm } = await sb.from("llm_usage_logs").select("cache_read, created_at").eq("action", "brain-warm").eq("env", "production").order("created_at", { ascending: false }).limit(3);
  const sysTok = Math.max(...((warm ?? []) as Array<{ cache_read: number }>).map((w) => w.cache_read));
  const tpc = sysTok / sysChars;
  console.log(`system ${sysChars}字（静的 ${STATIC_BRAIN_SYSTEM.length}）＝温めの読み ${sysTok}トークン → 1字 ${tpc.toFixed(3)}トークン`);
  const rules = await readAll<{ rule_key: string; action_type: string; rule_text: string; priority: number; condition_key: string | null; condition_value: string | null; updated_at: string | null }>((f, t) => sb.from("ai_prompt_rules")
    .select("rule_key, action_type, rule_text, priority, condition_key, condition_value, updated_at").eq("is_active", true).not("action_type", "is", null).not("rule_key", "like", "BOUNDARY-%").gte("priority", 4)
    .order("priority", { ascending: false }).order("updated_at", { ascending: false, nullsFirst: false }).range(f, t));
  const permanent = new Set((sys.promptRulesText ?? "").split("\n").map((l) => l.replace(/^- /, "")));
  const variantText = (cands: string[], status: string | null) => {
    const rs = rules.filter((r) => cands.includes(r.action_type)).slice(0, 40).slice(0, 15)
      .filter((r) => !r.condition_key || (r.condition_key === "conversation_state" && r.condition_value === status))
      .filter((r) => !permanent.has(r.rule_text));
    return rs.length ? `\n【アクション別ルール（現局面候補: ${cands.join("/")}）】\n${rs.map((r) => `- [${r.action_type}] ${r.rule_text}`).join("\n")}` : "";
  };
  const llm = await readAll<{ created_at: string; conversation_id: string | null; cache_write_1h: number | null; cache_write_5m: number | null; cache_read: number; input_uncached: number }>((f, t) => sb.from("llm_usage_logs")
    .select("created_at, conversation_id, cache_write_1h, cache_write_5m, cache_read, input_uncached").gte("created_at", SINCE).eq("env", "production").eq("action", "brain_fresh").gte("status", 1).lte("status", 399).order("created_at").range(f, t));
  const decs = await readAll<{ conversation_id: string; created_at: string; suggested_action: string | null; conversation_status: string | null }>((f, t) => sb.from("brain_decision_logs")
    .select("conversation_id, created_at, suggested_action, conversation_status").gte("created_at", new Date(ms(SINCE) - 7 * 86_400_000).toISOString()).order("created_at").range(f, t));
  const dBy = new Map<string, typeof decs>(); for (const d of decs) { if (!dBy.has(d.conversation_id)) dBy.set(d.conversation_id, []); dBy.get(d.conversation_id)!.push(d); }
  const allAix = Object.keys(PHASE_ACTION_CANDIDATES).flatMap((k) => PHASE_ACTION_CANDIDATES[k]);
  const ALL = [...new Set([...allAix, "zenryoku_support", "applying", "followup_revive"])];
  type Call = { t: number; key: string; chars: number; sysRewrite: boolean };
  const calls: Call[] = [];
  const keyChars = new Map<string, number>();
  for (const l of llm) {
    const prev = (dBy.get(l.conversation_id ?? "") ?? []).filter((d) => ms(d.created_at) < ms(l.created_at) - 1000).pop() ?? null;
    const status = prev?.conversation_status ?? null;
    const phase = status ? STATUS_TO_PHASE[status] ?? null : null;
    const base = phase ? PHASE_ACTION_CANDIDATES[phase] : ALL;
    const prevAix = prev?.suggested_action && ALL.includes(prev.suggested_action) ? prev.suggested_action : null;
    const cands = [...new Set([...base, ...(prevAix ? [prevAix] : [])])];
    const text = variantText(cands, status);
    const key = text;
    if (!keyChars.has(key)) keyChars.set(key, text.length);
    calls.push({ t: ms(l.created_at), key, chars: text.length, sysRewrite: (l.cache_write_1h ?? 0) > 0 });
  }
  const days = (Date.now() - ms(SINCE)) / 86_400_000;
  const cnt = new Map<string, number>(); for (const c of calls) cnt.set(c.key, (cnt.get(c.key) ?? 0) + 1);
  console.log(`brain_fresh ${calls.length}回・${days.toFixed(1)}日｜アクション別ルールの組（推定）${cnt.size}種・平均 ${Math.round(calls.reduce((a, c) => a + c.chars, 0) / calls.length)}字（約 ${Math.round(calls.reduce((a, c) => a + c.chars, 0) / calls.length * tpc)}トークン）`);
  console.log(`  多い組: ${[...cnt].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${v}回/${k.length}字`).join("・")}`);
  const simulate = (ttlMs: number, split = 1, writeMul = 4) => {
    const exp = new Map<string, number>();
    let base = 0, cached = 0, writes = 0, reads = 0;
    calls.forEach((c, i) => {
      if (!c.chars) return;
      if (c.sysRewrite) exp.clear();
      const key = split > 1 ? `${c.key}#${i % split}` : c.key;
      const tok = c.chars * tpc;
      base += tok * 2;
      const e = exp.get(key);
      if (e && e > c.t) { cached += tok * 0.2; reads++; } else { cached += tok * writeMul; writes++; }
      exp.set(key, c.t + ttlMs);
    });
    return { usdSave: (base - cached) / 1e6, writes, reads, base: base / 1e6 };
  };
  for (const [label, ttl, mul] of [["1h", 3600_000, 4], ["5分", 300_000, 2.5]] as const) for (const split of [1, 2, 4]) {
    const r = simulate(ttl, split, mul);
    console.log(`  TTL ${label}${split > 1 ? `・鍵を${split}倍に割った時（感度）` : ""}: 書き ${r.writes}・読み ${r.reads}（読みの割合 ${Math.round((r.reads / Math.max(1, r.reads + r.writes)) * 100)}%）｜素で払っていた $${r.base.toFixed(2)} → 浮く $${r.usdSave.toFixed(2)}（30日 $${((r.usdSave / days) * 30).toFixed(1)}）`);
  }
  // 会話専用ブロックの印（5分）を外した時: 5分書きの割増が消え、読めていた回の割引を失う
  let w5 = 0, convReads = 0; for (const l of llm) { w5 += l.cache_write_5m ?? 0; if (l.cache_read > sysTok + 1500) convReads += l.cache_read - sysTok; }
  const save5 = (w5 * (2.5 - 2) - convReads * (2 - 0.2)) / 1e6;
  console.log(`会話専用ブロックの印を外す: 5分書き ${w5}トークン・会話専用の読み ${convReads}トークン → 浮く $${save5.toFixed(2)}（30日 $${((save5 / days) * 30).toFixed(1)}）`);
})().catch((e) => { console.error(e); process.exit(1); }).finally(() => setTimeout(() => process.exit(process.exitCode ?? 0), 300));
