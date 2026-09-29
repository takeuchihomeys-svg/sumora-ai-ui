// scripts/audit-llm-unnamed.ts — llm_usage_logs の「名前なし（action=null）」の Claude 呼び出しの正体と費用を表にする（読み取りのみ）
//
// 2026-09-29 竹内「昨日かなり DeepSeek で API 費用を使った。更に節約できないか調査する」:
//   本番7日で action=null の Sonnet 1,556回・Haiku 2,705回があり、どの処理かは route × system の先頭80字でしか読めなかった。
//   この監査で ①action × model ②名前なしを route × sys_head で割る ③DeepSeek の日別 ④ブレイン系の名札の付き方 を出す。
//   名札（x-sumora-llm-action）を付けた後は ② が空に近づくのが正常（残った物が「まだ名前の無い呼び出し」）。
//
// 単価（$/M・公式）:
//   Anthropic: Sonnet 入力3／5分書き3.75／1h書き6／読み0.3／出力15、Haiku 1／1.25／2／0.1／5、Opus 5／6.25／10／0.5／25
//   DeepSeek（api-docs.deepseek.com/quick_start/pricing）: flash 未命中0.15／命中0.003／出力0.6、v4-pro 0.66／0.022／1.98。
//     ピーク（UTC 01-04・06-10 の平日＝JST 10-13・15-19）は2倍。画像は1枚 ≈1,600 トークンが入力に足される
//
// 実行: npx tsx --env-file=.env.local scripts/audit-llm-unnamed.ts [--days=7] [--env=production] [--top=60]
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d = "") => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=").slice(1).join("=");
const days = Number(arg("days", "7"));
const envFilter = arg("env", "production");
const top = Number(arg("top", "60"));
const n = (v: unknown) => (typeof v === "number" ? v : Number(v ?? 0)) || 0;
const PRICE: Record<string, [number, number, number, number, number]> = {
  "claude-sonnet-5": [3, 3.75, 6, 0.3, 15], "claude-sonnet-4-6": [3, 3.75, 6, 0.3, 15],
  "claude-haiku-4-5-20251001": [1, 1.25, 2, 0.1, 5], "claude-haiku-4-5": [1, 1.25, 2, 0.1, 5],
  "claude-opus-5": [5, 6.25, 10, 0.5, 25],
};
const DS: Record<string, [number, number, number]> = { "deepseek-flash": [0.15, 0.003, 0.6], "deepseek-v4-pro": [0.66, 0.022, 1.98] };
export const isDeepseekPeak = (iso: string) => { const d = new Date(iso); const h = d.getUTCHours(); const w = d.getUTCDay(); return w >= 1 && w <= 5 && ((h >= 1 && h < 4) || (h >= 6 && h < 10)); };
export function estimateUsd(r: Record<string, unknown>): number {
  const m = String(r.model);
  const p = PRICE[m];
  if (p) return (n(r.input_uncached) * p[0] + n(r.cache_write_5m) * p[1] + n(r.cache_write_1h) * p[2] + n(r.cache_read) * p[3] + n(r.output_tokens) * p[4]) / 1e6;
  const d = DS[m];
  if (d) return (n(r.input_uncached) * d[0] + n(r.cache_read) * d[1] + n(r.output_tokens) * d[2]) / 1e6 * (isDeepseekPeak(String(r.created_at)) ? 2 : 1);
  return 0;
}
async function page(sinceIso: string) {
  const out: Array<Record<string, unknown>> = [];
  for (let p = 0; p < 80; p++) {
    let q = sb.from("llm_usage_logs")
      .select("created_at, route, model, status, error_type, env, action, conversation_id, sys_head, sys_key_full, input_uncached, cache_read, cache_write_5m, cache_write_1h, output_tokens, duration_ms, cache_breakpoints")
      .gte("created_at", sinceIso).order("created_at", { ascending: false }).range(p * 1000, p * 1000 + 999);
    if (envFilter) q = q.eq("env", envFilter);
    const { data, error } = await q;
    if (error) { console.log(`⚠ ${error.message}`); break; }
    const r = (data ?? []) as unknown as Array<Record<string, unknown>>;
    if (r.length === 0) break; out.push(...r); if (r.length < 1000) break;
  }
  return out;
}
type B = { c: number; usd: number; inU: number; read: number; w5: number; w1: number; out: number; routes: Map<string, number>; conv: number; noCache: number; err: number };
const mk = (): B => ({ c: 0, usd: 0, inU: 0, read: 0, w5: 0, w1: 0, out: 0, routes: new Map(), conv: 0, noCache: 0, err: 0 });
function add(b: B, r: Record<string, unknown>) {
  b.c++; b.usd += estimateUsd(r); b.inU += n(r.input_uncached); b.read += n(r.cache_read); b.w5 += n(r.cache_write_5m); b.w1 += n(r.cache_write_1h); b.out += n(r.output_tokens);
  const rt = String(r.route ?? "-"); b.routes.set(rt, (b.routes.get(rt) ?? 0) + 1);
  if (r.conversation_id) b.conv++; if (n(r.cache_breakpoints) === 0) b.noCache++; if (r.error_type) b.err++;
}
function line(k: string, b: B) {
  const tot = b.inU + b.read + b.w5 + b.w1;
  const hit = tot ? (b.read / tot * 100).toFixed(0) : "-";
  const routes = [...b.routes.entries()].sort((a, c) => c[1] - a[1]).slice(0, 3).map(([r, c]) => `${r}:${c}`).join(" ");
  console.log(`${String(b.c).padStart(5)}回 $${b.usd.toFixed(2).padStart(6)} 命中${String(hit).padStart(3)}% 1回入力${String(b.c ? Math.round(tot / b.c) : 0).padStart(6)} 出力/回${String(b.c ? Math.round(b.out / b.c) : 0).padStart(5)} 会話ID${String(b.conv).padStart(4)} 失敗${String(b.err).padStart(3)}  ${k}${routes ? `\n        routes: ${routes}` : ""}`);
}
const jstDay = (iso: string) => new Date(new Date(iso).getTime() + 9 * 3600_000).toISOString().slice(0, 10);
function table(title: string, rows: Array<Record<string, unknown>>, key: (r: Record<string, unknown>) => string, sortByUsd = true, limit = top) {
  console.log(`\n=== ${title} ===`);
  const m = new Map<string, B>();
  for (const r of rows) { const k = key(r); const b = m.get(k) ?? mk(); add(b, r); m.set(k, b); }
  const entries = [...m.entries()].sort((a, c) => (sortByUsd ? c[1].usd - a[1].usd : (a[0] < c[0] ? -1 : 1))).slice(0, limit);
  for (const [k, b] of entries) line(k, b);
}
async function main() {
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const rows = await page(since);
  console.log(`=== 材料: ${rows.length}件 env=${envFilter || "全部"} ${rows.length ? rows[rows.length - 1].created_at : "-"} 〜 ${rows.length ? rows[0].created_at : "-"} ===`);
  console.log(`合計（推定）$${rows.reduce((s, r) => s + estimateUsd(r), 0).toFixed(2)}  Claude $${rows.filter((r) => String(r.model).startsWith("claude")).reduce((s, r) => s + estimateUsd(r), 0).toFixed(2)}  DeepSeek $${rows.filter((r) => String(r.model).startsWith("deepseek")).reduce((s, r) => s + estimateUsd(r), 0).toFixed(2)}`);
  table("① action × model", rows, (r) => `${r.action ?? "(名前なし)"} ｜ ${r.model}`);
  const un = rows.filter((r) => !r.action && String(r.model).startsWith("claude"));
  table("② 名前なし（action=null）の Claude を model × route × sys_head で割る", un, (r) => `${String(r.model).replace("claude-", "").slice(0, 12)} ｜ ${String(r.route ?? "-")} ｜ ${String(r.sys_head ?? "(system なし)").slice(0, 70)}`);
  table("③ 名前なしの Claude の日別（名札を付けた後は減る）", un, (r) => jstDay(String(r.created_at)), false, 60);
  const ds = rows.filter((r) => String(r.model).startsWith("deepseek"));
  table("④ DeepSeek の日別 × action", ds, (r) => `${jstDay(String(r.created_at))} ｜ ${r.action ?? "(名前なし)"} ｜ ${r.model}`, false, 400);
  const brainMarker = (r: Record<string, unknown>) => /スモラAI|会話全体の戦略|記録係/.test(String(r.sys_head ?? ""));
  table("⑤ ブレイン系（system の先頭の語）の名札の付き方（日別）", rows.filter((r) => String(r.model).startsWith("claude") && (brainMarker(r) || String(r.action ?? "").startsWith("brain"))), (r) => `${jstDay(String(r.created_at))} ｜ ${r.action ?? "(名前なし)"}`, false, 200);
  // DeepSeek の画像の読み取り: 出力（推論）が費用の大半か
  const pid = ds.filter((r) => r.action === "property_image_detail");
  if (pid.length) {
    const outTok = pid.reduce((s, r) => s + n(r.output_tokens), 0), inTok = pid.reduce((s, r) => s + n(r.input_uncached), 0);
    const sorted = pid.map((r) => n(r.output_tokens)).sort((a, b) => a - b);
    console.log(`\n=== ⑥ property_image_detail ${pid.length}回: 出力 ${outTok} トークン（p50 ${sorted[Math.floor(sorted.length / 2)]}・p90 ${sorted[Math.floor(sorted.length * 0.9)]}・max ${sorted[sorted.length - 1]}）／未命中入力 ${inTok}／ピーク時間帯 ${pid.filter((r) => isDeepseekPeak(String(r.created_at))).length}回／失敗 ${pid.filter((r) => r.error_type).length}回 ===`);
  }
}
if (process.argv[1]?.endsWith("audit-llm-unnamed.ts")) main().catch((e) => { console.error(e); process.exit(1); });
