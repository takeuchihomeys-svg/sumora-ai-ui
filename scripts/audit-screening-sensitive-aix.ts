// scripts/audit-screening-sensitive-aix.ts — 審査の事情（screening-sensitive）が当たった会話で、AIX・物件の経路のどの名札が
//   DeepSeek 等（Claude 以外）に回っていたか・Claude に固定するといくら増えるかを数える（読むだけ・LLM なし・$0）
// 実行: npx tsx --env-file=.env.local scripts/audit-screening-sensitive-aix.ts [--days=30]
//   画面に出すのは名札ごとの回数・会話数・費用だけ（本文は出さない）
import { createClient } from "@supabase/supabase-js";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;

async function pageAll<T>(q: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>, max = 400_000): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; from < max; from += 1000) {
    const { data, error } = await q(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...((data ?? []) as T[]));
    if (!data || (data as unknown[]).length < 1000) break;
  }
  return out;
}

type Row = { route: string | null; action: string | null; conversation_id: string | null; model: string | null; input_uncached: number; cache_read: number; cache_write: number; cache_write_5m: number; cache_write_1h: number; output_tokens: number; created_at: string; status: number; error_type: string | null; env: string | null };

async function main() {
  const { screeningSensitiveInMessages, SCREENING_SENSITIVE_PREFILTER, SCREENING_CHECK_PATTERNS } = await import("../app/lib/screening-sensitive");
  const { altUsageUsd, claudeUsageUsd, claudePriceOf } = await import("../app/lib/llm-price");
  const { screeningPiiPinsAction } = await import("../app/lib/screening-sensitive");
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { auth: { persistSession: false } });
  const days = Number(arg("days", "30"));
  const since = new Date(Date.now() - days * 86400e3).toISOString();

  const rows = await pageAll<Row>((a, b) => db.from("llm_usage_logs")
    .select("route, action, conversation_id, model, input_uncached, cache_read, cache_write, cache_write_5m, cache_write_1h, output_tokens, created_at, status, error_type, env")
    .gte("created_at", since).not("model", "ilike", "claude%").eq("env", "production").range(a, b));
  const alt = rows.filter((r) => r.status === 200 && !r.error_type);
  console.log(`Claude 以外（本番・成功）${days}日: ${alt.length}回`);

  // 会話ごとの当たり（会話の全期間・本番の loadScreeningSensitive と同じ材料）
  const convs = [...new Set(alt.map((r) => r.conversation_id).filter((c): c is string => !!c))];
  const hit = new Map<string, string>();
  for (let i = 0; i < convs.length; i += 100) {
    const ids = convs.slice(i, i + 100);
    const cust = await pageAll<{ conversation_id: string; text: string | null; sender: string }>((a, b) => db.from("messages").select("conversation_id, text, sender")
      .in("conversation_id", ids).eq("sender", "customer").or(SCREENING_SENSITIVE_PREFILTER).range(a, b));
    const aix = await pageAll<{ conversation_id: string; generated_text: string | null; check_pattern: string | null }>((a, b) => db.from("aix_usage_logs").select("conversation_id, generated_text, check_pattern")
      .in("conversation_id", ids).in("check_pattern", [...SCREENING_CHECK_PATTERNS]).range(a, b));
    for (const id of ids) {
      const h = screeningSensitiveInMessages([
        ...cust.filter((m) => m.conversation_id === id),
        ...aix.filter((m) => m.conversation_id === id).map((m) => ({ sender: "staff", text: m.generated_text, checkPattern: m.check_pattern })),
      ]);
      if (h) hit.set(id, h.category);
    }
  }
  console.log(`会話: ${convs.length}・うち審査の事情あり ${hit.size}`);

  const sonnet = claudePriceOf("claude-sonnet-5");
  const by = new Map<string, { all: number; hitCalls: number; hitConvs: Set<string>; altUsd: number; claudeNoCache: number; claudeCached: number }>();
  for (const r of alt) {
    const k = r.action ?? "(なし)";
    const e = by.get(k) ?? { all: 0, hitCalls: 0, hitConvs: new Set<string>(), altUsd: 0, claudeNoCache: 0, claudeCached: 0 };
    e.all++;
    if (r.conversation_id && hit.has(r.conversation_id)) {
      e.hitCalls++; e.hitConvs.add(r.conversation_id);
      e.altUsd += altUsageUsd(r);
      const totalIn = (r.input_uncached ?? 0) + (r.cache_read ?? 0) + (r.cache_write ?? 0);
      // 上限: 全部キャッシュ無しの入力 / 下限寄り: DeepSeek でキャッシュに当たった分は Claude でも読み（×0.1）
      e.claudeNoCache += claudeUsageUsd({ input_uncached: totalIn, output_tokens: r.output_tokens }, sonnet);
      e.claudeCached += claudeUsageUsd({ input_uncached: (r.input_uncached ?? 0) + (r.cache_write ?? 0), cache_read: r.cache_read, output_tokens: r.output_tokens }, sonnet);
    }
    by.set(k, e);
  }
  const list = [...by.entries()].sort((a, b) => b[1].all - a[1].all);
  // Claude に固定して費用が増える名札＝aix/action の本文（経路が /api/aix/action）と画像の物件オススメ。
  //   reply_generate（前の直しで固定済み）・customer_memo（読まない）・condition_summary／pref_*（事情の節・発言を落とすだけ）・jev:*（呼ばない）は費用が増えない
  const aixNames = new Set(alt.filter((r) => r.route === "/api/aix/action").map((r) => r.action ?? ""));
  aixNames.add("property_recommendation");
  const pinned = new Set([...aixNames].filter((a) => a && screeningPiiPinsAction(a)));
  let dAlt = 0, dNo = 0, dC = 0;
  console.log("名札\t全回数\t当たり会話の回数\t会話数\t固定\tDeepSeek$\tClaude$(キャッシュ無)\tClaude$(キャッシュ有)");
  for (const [k, e] of list) {
    const p = pinned.has(k);
    if (p) { dAlt += e.altUsd; dNo += e.claudeNoCache; dC += e.claudeCached; }
    console.log(`${k}\t${e.all}\t${e.hitCalls}\t${e.hitConvs.size}\t${p ? "★" : ""}\t${e.altUsd.toFixed(3)}\t${e.claudeNoCache.toFixed(3)}\t${e.claudeCached.toFixed(3)}`);
  }
  // 経路（route）× 名札（当たり会話の分だけ）: どの入口の箱（時刻の線の印）の中で呼ばれたか
  const rk = new Map<string, number>();
  for (const r of alt) if (r.conversation_id && hit.has(r.conversation_id)) { const k = `${r.route ?? "-"}\t${r.action ?? "-"}`; rk.set(k, (rk.get(k) ?? 0) + 1); }
  console.log("--- 当たり会話: 経路 × 名札");
  for (const [k, n] of [...rk.entries()].sort((a, b) => b[1] - a[1])) console.log(`${k}\t${n}`);
  console.log(`固定する名札の増分（${days}日）: 上限 $${(dNo - dAlt).toFixed(2)}（$${((dNo - dAlt) / days).toFixed(3)}/日）・キャッシュ有 $${(dC - dAlt).toFixed(2)}（$${((dC - dAlt) / days).toFixed(3)}/日）`);
}
main().catch((e) => { console.error(e); process.exit(1); });
