// scripts/audit-screening-sensitive.ts — 審査の事情の判定（screening-sensitive）が実データでどれだけ当たり、
//   返信の下書き（reply_generate）・お客様のメモ（customer_memo）が何回 Claude に固定／止まるかを数える（読むだけ・LLM なし・$0）
// 実行: npx tsx --env-file=.env.local scripts/audit-screening-sensitive.ts [--days=90] [--samples=40]
//   ⚠ --samples の抜き出しは画面に出すだけ（ファイルに残さない・コミットしない）
import { createClient } from "@supabase/supabase-js";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;

async function pageAll<T>(q: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>, max = 200_000): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; from < max; from += 1000) {
    const { data, error } = await q(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...((data ?? []) as T[]));
    if (!data || (data as unknown[]).length < 1000) break;
  }
  return out;
}

async function main() {
  const { screeningSensitiveSignal, SCREENING_SENSITIVE_PREFILTER, isScreeningCheckPattern } = await import("../app/lib/screening-sensitive");
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { auth: { persistSession: false } });
  const days = Number(arg("days", "90"));
  const since = new Date(Date.now() - days * 86400e3).toISOString();
  const samples = Number(arg("samples", "40"));

  // お客様の通（語で先に絞る＝本番の loadScreeningSensitive と同じ）
  const cust = await pageAll<{ conversation_id: string; text: string | null; created_at: string; sender: string }>((a, b) =>
    db.from("messages").select("conversation_id, text, created_at, sender").eq("sender", "customer").gte("created_at", since)
      .or(SCREENING_SENSITIVE_PREFILTER).order("created_at", { ascending: true }).range(a, b));
  const { count: custTotal } = await db.from("messages").select("id", { count: "exact", head: true }).eq("sender", "customer").gte("created_at", since);
  // スタッフ（参考: 印の無いスタッフの通に当てたらどれだけ当たるか）
  const staff = await pageAll<{ conversation_id: string; text: string | null; created_at: string }>((a, b) =>
    db.from("messages").select("conversation_id, text, created_at").neq("sender", "customer").gte("created_at", since)
      .or(SCREENING_SENSITIVE_PREFILTER).order("created_at", { ascending: true }).range(a, b));
  const aix = await pageAll<{ conversation_id: string; generated_text: string | null; check_pattern: string | null; created_at: string }>((a, b) =>
    db.from("aix_usage_logs").select("conversation_id, generated_text, check_pattern, created_at").gte("created_at", since).not("check_pattern", "is", null).range(a, b));

  const firstHit = new Map<string, { at: string; cat: string }>();
  const byCat: Record<string, number> = {};
  const hitRows: Array<{ cat: string; word: string; snip: string }> = [];
  let custHits = 0;
  for (const m of cust) {
    const h = screeningSensitiveSignal(m.text);
    if (!h) continue;
    custHits++;
    byCat[h.category] = (byCat[h.category] ?? 0) + 1;
    const t = String(m.text ?? "");
    const i = t.indexOf(h.word);
    hitRows.push({ cat: h.category, word: h.word, snip: t.slice(Math.max(0, i - 25), i + h.word.length + 25).replace(/\s+/g, " ") });
    if (!firstHit.has(m.conversation_id)) firstHit.set(m.conversation_id, { at: m.created_at, cat: h.category });
  }
  let staffHits = 0; const staffByCat: Record<string, number> = {}; const staffSnips: string[] = [];
  for (const m of staff) {
    const h = screeningSensitiveSignal(m.text);
    if (!h) continue;
    staffHits++; staffByCat[h.category] = (staffByCat[h.category] ?? 0) + 1;
    const t = String(m.text ?? ""); const i = t.indexOf(h.word);
    if (staffSnips.length < 15) staffSnips.push(`${h.category} | ${t.slice(Math.max(0, i - 20), i + h.word.length + 20).replace(/\s+/g, " ")}`);
  }
  let aixHits = 0;
  for (const r of aix) {
    if (!isScreeningCheckPattern(r.check_pattern)) continue;
    const h = screeningSensitiveSignal(r.generated_text);
    if (!h) continue;
    aixHits++;
    const cur = firstHit.get(r.conversation_id);
    if (!cur || cur.at > r.created_at) firstHit.set(r.conversation_id, { at: r.created_at, cat: `AIX:${h.category}` });
  }

  // 返信の下書き・メモの呼び出し（本番）のうち、当たった会話で最初の当たりより後の物
  const logs = await pageAll<{ conversation_id: string | null; action: string; model: string; created_at: string; input_uncached: number | null; cache_read: number | null; output_tokens: number | null }>((a, b) =>
    db.from("llm_usage_logs").select("conversation_id, action, model, created_at, input_uncached, cache_read, output_tokens").gte("created_at", since)
      .eq("env", "production").eq("status", 200).not("conversation_id", "is", null).not("model", "ilike", "claude%").range(a, b));
  const agg = (action: string) => {
    const all = logs.filter((l) => l.action === action);
    const pinned = all.filter((l) => { const f = l.conversation_id ? firstHit.get(l.conversation_id) : undefined; return !!f && l.created_at >= f.at; });
    const sum = (xs: typeof all, k: "input_uncached" | "cache_read" | "output_tokens") => xs.reduce((s, x) => s + (x[k] ?? 0), 0);
    const logDays = all.length ? Math.max(1, (Date.now() - Date.parse(all.reduce((m, x) => (x.created_at < m ? x.created_at : m), all[0].created_at))) / 86400e3) : 1;
    return {
      calls: all.length, convs: new Set(all.map((x) => x.conversation_id)).size, logDays: +logDays.toFixed(1),
      pinnedCalls: pinned.length, pinnedConvs: new Set(pinned.map((x) => x.conversation_id)).size,
      pinnedTokens: { input_uncached: sum(pinned, "input_uncached"), cache_read: sum(pinned, "cache_read"), output: sum(pinned, "output_tokens") },
    };
  };
  const reply = agg("reply_generate"), memo = agg("customer_memo");
  const otherAlt = logs.filter((l) => l.action !== "reply_generate" && l.action !== "customer_memo");
  const otherPinned = otherAlt.filter((l) => { const f = l.conversation_id ? firstHit.get(l.conversation_id) : undefined; return !!f && l.created_at >= f.at; });
  const otherByAction: Record<string, [number, number]> = {};
  for (const l of otherAlt) { const e = (otherByAction[l.action] ??= [0, 0]); e[0]++; }
  for (const l of otherPinned) otherByAction[l.action][1]++;
  console.log(JSON.stringify({ otherAltConversationCalls_total_pinned: otherByAction }));
  // 費用（$/MTok）: DeepSeek v4 pro 不一致 0.66／一致 0.022／出力 1.98（llm-price.ts）・Claude Sonnet 5 入力 2.00／キャッシュ読み 0.20／出力 10.00
  //   Claude の時は DeepSeek のキャッシュ一致の分が Claude のキャッシュ読みになると置く（書き込み 1.25x の分は上限の見込みに足す）
  const t = reply.pinnedTokens;
  const ds = (t.input_uncached * 0.66 + t.cache_read * 0.022 + t.output * 1.98) / 1e6;
  const cl = (t.input_uncached * 2.0 + t.cache_read * 0.2 + t.output * 10) / 1e6;
  const clHigh = (t.input_uncached * 2.5 + t.cache_read * 0.2 + t.output * 10) / 1e6;
  console.log(JSON.stringify({
    days, since, customerMessages: custTotal, prefiltered: cust.length, customerHits: custHits, byCategory: byCat,
    conversationsHit: firstHit.size, staffUnmarkedHits_reference: staffHits, staffByCat, aixScreeningHits: aixHits,
    reply_generate: reply, customer_memo: memo,
    cost_reply_pinned_usd: { deepseek: +ds.toFixed(3), claude: +cl.toFixed(3), claude_cachewrite_upper: +clHigh.toFixed(3), perDay_extra: +((cl - ds) / reply.logDays).toFixed(3) },
  }, null, 1));
  console.log("\n--- お客様の当たりの抜き出し（画面だけ）---");
  for (const r of hitRows.slice(-samples)) console.log(`${r.cat} [${r.word}] ${r.snip}`);
  console.log("\n--- 参考: 印の無いスタッフの通の当たり（本番では見ない）---");
  for (const s of staffSnips) console.log(s);
}
main().catch((e) => { console.error(e); process.exit(1); });
