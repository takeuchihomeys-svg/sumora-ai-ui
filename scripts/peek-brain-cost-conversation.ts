// お客様1人（会話）の今日の LLM 費用の内訳を見る（読み取りのみ・お客様名は出力しない）
// 実行: npx tsx --env-file=.env.local scripts/peek-brain-cost-conversation.ts --name=<名前の一部> [--days=1]
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? "").split("=").slice(1).join("=") || null;
const name = arg("name") ?? "";
const days = Number(arg("days") ?? "1");

// 単価（$/1M）: 入力・キャッシュ読み・5分書き・1時間書き・出力
const PRICE: Record<string, [number, number, number, number, number]> = {
  haiku: [1, 0.1, 1.25, 2, 5], sonnet: [3, 0.3, 3.75, 6, 15], opus: [5, 0.5, 6.25, 10, 25],
};
type Row = { created_at: string; route: string | null; action: string | null; model: string | null; status: number | null; stream: boolean | null; stop_reason: string | null;
  input_uncached: number; cache_read: number; cache_write_5m: number; cache_write_1h: number; cache_write: number; output_tokens: number; thinking_tokens: number; duration_ms: number | null; conversation_id: string | null };
function usd(r: Row): number {
  const m = (r.model ?? "").toLowerCase();
  const p = PRICE[m.includes("haiku") ? "haiku" : m.includes("opus") ? "opus" : "sonnet"];
  const w5 = r.cache_write_5m || (r.cache_write_1h ? 0 : r.cache_write) || 0;
  return (r.input_uncached * p[0] + r.cache_read * p[1] + w5 * p[2] + (r.cache_write_1h || 0) * p[3] + (r.output_tokens + (r.thinking_tokens || 0)) * p[4]) / 1e6;
}
const jst = (s: string) => new Date(new Date(s).getTime() + 9 * 3600_000).toISOString().slice(5, 16).replace("T", " ");

async function main() {
  if (!name) { console.log("--name= が要る"); process.exit(1); }
  const { data: convs, error } = await sb.from("conversations").select("id, customer_name, updated_at").ilike("customer_name", `%${name}%`).limit(5);
  if (error) { console.log("conversations を読めない:", error.message); process.exit(1); }
  const ids = (convs ?? []).map((c) => c.id as string);
  console.log(`会話: ${ids.length}件 → ${ids.map((i) => i.slice(0, 8)).join(", ")}`);
  if (!ids.length) return;
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const { data: logs } = await sb.from("llm_usage_logs").select("created_at, route, action, model, status, stream, stop_reason, input_uncached, cache_read, cache_write_5m, cache_write_1h, cache_write, output_tokens, thinking_tokens, duration_ms, conversation_id")
    .in("conversation_id", ids).gte("created_at", since).order("created_at", { ascending: true }).limit(500);
  const rows = (logs ?? []) as Row[];
  let total = 0;
  console.log(`\n=== この会話の ${days}日分の呼び出し ${rows.length}件 ===`);
  console.log("時刻(JST)  | route / action | model | 未キャッシュ | 読み | 5分書 | 1h書 | 出力 | 思考 | $ | 秒");
  for (const r of rows) {
    const c = usd(r); total += c;
    console.log(`${jst(r.created_at)} | ${(r.route ?? "").replace("/api/", "")} / ${r.action ?? "-"} | ${(r.model ?? "").replace("claude-", "").slice(0, 14)} | ${r.input_uncached} | ${r.cache_read} | ${r.cache_write_5m} | ${r.cache_write_1h} | ${r.output_tokens} | ${r.thinking_tokens} | ${c.toFixed(3)} | ${((r.duration_ms ?? 0) / 1000).toFixed(0)}${r.status && r.status >= 400 ? " ✗" + r.status : ""}`);
  }
  console.log(`合計: $${total.toFixed(3)}`);
  // action ごと
  const byAction = new Map<string, { n: number; usd: number; uncached: number; read: number; w1h: number; out: number }>();
  for (const r of rows) {
    const k = `${(r.route ?? "").replace("/api/", "")}/${r.action ?? "-"}/${(r.model ?? "").includes("haiku") ? "H" : (r.model ?? "").includes("opus") ? "O" : "S"}`;
    const a = byAction.get(k) ?? { n: 0, usd: 0, uncached: 0, read: 0, w1h: 0, out: 0 };
    a.n++; a.usd += usd(r); a.uncached += r.input_uncached; a.read += r.cache_read; a.w1h += r.cache_write_1h; a.out += r.output_tokens + (r.thinking_tokens || 0);
    byAction.set(k, a);
  }
  console.log("\n=== 経路ごと ===");
  for (const [k, a] of [...byAction.entries()].sort((x, y) => y[1].usd - x[1].usd)) console.log(`${k}: ${a.n}回 $${a.usd.toFixed(3)} 未キャッシュ${a.uncached} 読み${a.read} 1h書${a.w1h} 出力${a.out}`);

  // 比べる: 今日の全会話の「会話あたり費用」
  const { data: all } = await sb.from("llm_usage_logs").select("conversation_id, model, input_uncached, cache_read, cache_write_5m, cache_write_1h, cache_write, output_tokens, thinking_tokens")
    .gte("created_at", since).not("conversation_id", "is", null).limit(20000);
  const per = new Map<string, number>();
  for (const r of (all ?? []) as Row[]) per.set(r.conversation_id as string, (per.get(r.conversation_id as string) ?? 0) + usd(r));
  const vals = [...per.values()].sort((a, b) => a - b);
  const med = vals.length ? vals[Math.floor(vals.length / 2)] : 0;
  console.log(`\n=== 同じ ${days}日で会話IDの付いた費用: ${vals.length}会話 合計 $${vals.reduce((a, b) => a + b, 0).toFixed(2)} 中央値 $${med.toFixed(3)} 最大 $${(vals[vals.length - 1] ?? 0).toFixed(3)} ===`);
  const rank = vals.filter((v) => v > total).length;
  console.log(`この会話は上から ${rank + 1} 番目`);
}
main().catch((e) => { console.error(e); process.exit(1); });
