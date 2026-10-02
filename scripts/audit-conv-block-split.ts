// scripts/audit-conv-block-split.ts — 会話専用ブロックを「変わりにくい物 A（顧客プロファイル・会話ストーリー）」と
//   「変わりやすい物 B（前回の全体分析 JSON・セーブデータ＋出力の指定）」に分けた時の q と費用の見積もり（読むだけ・LLM を呼ばない）
// 実行: npx tsx --env-file=.env.local scripts/audit-conv-block-split.ts [--days=9] [--a=0.6]
//
// 2026-10-02 ⑮ の提案①（竹内さんが推奨を選んだ）: 会話専用ブロック（brain-core の freshStableText）は1つの印（cache_control）で、
//   中のどれか1つが変わると全部を書き直す。今の q（次の本物まで変わらない率）0.42〜0.48 の多くは「間に戦略・全体分析・セーブデータが走った」組。
//   → 変わりにくい物を前（A・印あり）、変わりやすい物を後（B・印あり）にすると、B が変わっても A は読める。
//   A を書き直すのは、お客様の要約（customer_summary）が間に走った時（profile・会話ストーリーは ai_summary 由来）。
//   ここでは llm_usage_logs の並び（brain_fresh の組と、間に走った処理の名前）から、A・B それぞれの当たり方を見積もる。
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=").slice(1).join("=");
const days = Number(arg("days", "9"));
// A の割合。出力の指定は「上の【前回の全体分析】」を前提の文なので B に残した（文面を変えないため）→ A はプロファイル＋会話ストーリーだけ。
//   YUMA の実測（10/02・Claude）: A 474 トークン／全体 3,078＝0.15。会話ストーリーが長い（最大1,500字）お客様は 0.3 前後
const aShare = Number(arg("a", "0.3"));
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const PR = { w5: 2.5, read: 0.2 }; // Sonnet 5 / 1M tokens

type U = { created_at: string; action: string; conversation_id: string | null; cache_read: number; cache_write_5m: number; cache_write_1h: number; input_tokens?: number; status: number };

(async () => {
  const since = new Date(Date.now() - days * 86400e3).toISOString();
  const rows: U[] = [];
  for (let p = 0; p < 100; p++) {
    const { data, error } = await sb.from("llm_usage_logs").select("created_at, action, conversation_id, cache_read, cache_write_5m, cache_write_1h, status")
      .gte("created_at", since).eq("env", "production").in("action", ["brain_fresh", "brain_full", "brain_strategy", "brain_checkpoint", "customer_summary"])
      .order("created_at", { ascending: true }).range(p * 1000, p * 1000 + 999);
    if (error) throw new Error(error.message);
    rows.push(...((data ?? []) as U[]));
    if ((data ?? []).length < 1000) break;
  }
  const byConv = new Map<string, U[]>();
  for (const r of rows) { if (!r.conversation_id || r.conversation_id === YUMA || r.status >= 400) continue; (byConv.get(r.conversation_id) ?? byConv.set(r.conversation_id, []).get(r.conversation_id)!).push(r); }
  const freshTok: number[] = [];
  type Pair = { gapMin: number; bChanged: boolean; aChanged: boolean; hitNow: boolean };
  const pairs: Pair[] = [];
  for (const list of byConv.values()) {
    let prev: U | null = null, bChanged = false, aChanged = false;
    for (const r of list) {
      if (r.action !== "brain_fresh") {
        if (prev) { if (/brain_(strategy|checkpoint|full)/.test(r.action)) bChanged = true; if (r.action === "customer_summary") aChanged = true; }
        continue;
      }
      freshTok.push((r.cache_read || 0) + (r.cache_write_5m || 0) + (r.cache_write_1h || 0));
      if (prev) {
        const gap = (Date.parse(r.created_at) - Date.parse(prev.created_at)) / 60000;
        pairs.push({ gapMin: gap, bChanged, aChanged, hitNow: (r.cache_write_5m || 0) + (r.cache_write_1h || 0) < 1500 });
      }
      prev = r; bChanged = false; aChanged = false;
    }
  }
  const within = (m: number) => pairs.filter((p) => p.gapMin >= 0.5 && p.gapMin <= m);
  const report = (label: string, ps: Pair[]) => {
    const n = ps.length || 1;
    const qWhole = ps.filter((p) => !p.aChanged && !p.bChanged).length / n;
    const qA = ps.filter((p) => !p.aChanged).length / n;
    const qB = qWhole;
    console.log(`  ${label}: 組 ${ps.length}・間に戦略/全体分析/セーブデータ ${ps.filter((p) => p.bChanged).length}・間にお客様の要約 ${ps.filter((p) => p.aChanged).length}`);
    console.log(`    今（1つの印）q=${qWhole.toFixed(2)} ／ 分けた後: A（変わりにくい物）q=${qA.toFixed(2)}・B（変わりやすい物）q=${qB.toFixed(2)}`);
    return { n: ps.length, qWhole, qA, qB };
  };
  console.log(`=== 会話専用ブロックを2つに分けた時の見積もり（本番・${days}日・YUMA を除く）===`);
  const P = 3080; // audit-cache-warm-switch の中央値（会話専用ブロックのトークン）
  const r5 = report("0.5〜5分の組（今の 5分の印で当たりうる）", within(5));
  const r60 = report("0.5〜60分の組（温めを ON にした時の 1h の印で当たりうる）", within(60));
  const A = Math.round(P * aShare), B = P - A;
  const cost = (q: number, tok: number) => tok * (q * PR.read + (1 - q) * PR.w5) / 1e6;
  const perDay = (n: number) => n / days;
  const now5 = perDay(r5.n) * cost(r5.qWhole, P), split5 = perDay(r5.n) * (cost(r5.qA, A) + cost(r5.qB, B));
  console.log(`  費用（5分の組だけ・1日）: 今 $${now5.toFixed(4)} → 分けた後 $${split5.toFixed(4)}（差 $${(now5 - split5).toFixed(4)}/日・A=${A}・B=${B} トークン）`);
  console.log(`  温めのスイッチの q（1h の組）: 今 ${r60.qWhole.toFixed(2)} → 分けた後 A ${r60.qA.toFixed(2)}（温めて読み直すのは A だけ＝B は本物の時に書き直す）`);
  console.log(`  brain_fresh ${freshTok.length}回・会話専用ブロックより前の共有の前置きは変わらない（system の2つの印）`);
})().catch((e) => { console.error(e); process.exit(1); });
