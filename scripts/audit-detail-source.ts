// scripts/audit-detail-source.ts — 資料の中身の読み取りが「文字層／画像／写し」のどれで済むかの監査（読み取りのみ・DeepSeek は呼ばない）
// 実行: npx tsx --env-file=.env.local scripts/audit-detail-source.ts [--days=7]
//
// 2026-09-29 竹内「昨日かなり DeepSeek で API 費用を使った。更に節約できないか調査する」
//   ① 直近 N 日の売上サポの行（property_pickups）を detailSourceFor（純関数）に当て、text / image / none の割合を出す
//      （切り替え前: 「これから text で読む行」の見込み。切り替え後: pdf_text の薄い行が image に落ちているかの確認）
//   ② 同じ pdf_url が 7日以内に image_lines を持っていた行の割合（reusableLinesByPdfUrl）。**写すのは文字層が無い行だけ**（planDetailSource・
//      2026-09-29 検証の反証: 文字層の行に写すと画像読みの揺れと古さを持ち込むだけ）なので、実際に写す行も別に数える
//   ③ llm_usage_logs の property_text_detail / property_image_detail / 送信時の読み直しの回数と費用（切り替えの後に減っているか）
//   ④ image_details の model 別（text:／reuse／image:／pickup_lines／pickup_text:＝出所。旧の "deepseek-flash" は 9/29 より前の画像読み）
//      正常: 切り替え後は property_image_detail の日の回数が「文字層の無い行＋スタッフが手で送った画像」だけ（9/28 型の 1,000回が 数十回に）
import { createClient } from "@supabase/supabase-js";
import { detailSourceFor, countDetailLabels, reusableLinesByPdfUrl, planDetailSource } from "../app/lib/property-detail-source";

/** 公式（audit-image-detail-cost.ts と同じ・あちらは import すると main が走るので写す）。ピーク＝平日 UTC 01-04・06-10（JST 10-13・15-19） */
const OFFICIAL: Record<string, { hit: [number, number]; miss: [number, number]; out: [number, number] }> = {
  "deepseek-flash": { hit: [0.003, 0.006], miss: [0.15, 0.30], out: [0.6, 1.2] },
  "deepseek-v4-pro": { hit: [0.022, 0.044], miss: [0.66, 1.32], out: [1.98, 3.96] },
};
function isDeepseekPeak(iso: string): boolean {
  const d = new Date(iso);
  const dow = d.getUTCDay(); if (dow === 0 || dow === 6) return false;
  const h = d.getUTCHours() + d.getUTCMinutes() / 60;
  return (h >= 1 && h < 4) || (h >= 6 && h < 10);
}
function officialCost(r: { model: string | null; created_at: string; input_uncached: number; cache_read: number; output_tokens: number }): number {
  const p = OFFICIAL[r.model ?? ""] ?? OFFICIAL["deepseek-flash"];
  const i = isDeepseekPeak(r.created_at) ? 1 : 0;
  return (r.cache_read * p.hit[i] + r.input_uncached * p.miss[i] + r.output_tokens * p.out[i]) / 1e6;
}

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d = "") => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=").slice(1).join("=");
const days = Number(arg("days", "7"));
const since = new Date(Date.now() - days * 86_400_000).toISOString();

type P = { id: number; created_at: string; pdf_url: string | null; pdf_text: string | null; pdf_has_text: boolean | null; image_lines: unknown; agent_image_url: string | null; page_image_url: string | null };

async function main() {
  const picks: P[] = [];
  for (let off = 0; ; off += 500) {
    const { data, error } = await sb.from("property_pickups").select("id, created_at, pdf_url, pdf_text, pdf_has_text, image_lines, agent_image_url, page_image_url")
      .gte("created_at", since).order("created_at", { ascending: true }).range(off, off + 499);
    if (error) throw new Error(error.message);
    picks.push(...((data ?? []) as P[]));
    if (!data || data.length < 500) break;
  }
  // ① どこから読むか
  const by = { text: 0, image: 0, none: 0 };
  const labelHist = new Map<number, number>();
  const thin: Array<{ id: number; len: number; labels: number }> = [];
  for (const p of picks) {
    const src = detailSourceFor(p.pdf_text, !!(p.agent_image_url || p.page_image_url));
    by[src]++;
    const n = countDetailLabels(p.pdf_text ?? "");
    labelHist.set(n, (labelHist.get(n) ?? 0) + 1);
    if (p.pdf_has_text && src !== "text") thin.push({ id: p.id, len: (p.pdf_text ?? "").length, labels: n });
  }
  console.log(`=== 直近${days}日の売上サポの行 ${picks.length} 件: どこから読むか（detailSourceFor） ===`);
  console.log(`text（文字層で読む）: ${by.text}  image（画像で読む）: ${by.image}  none（読む物なし）: ${by.none}`);
  console.log(`見出しの種類数の分布: ${[...labelHist.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}:${v}`).join(" ")}`);
  if (thin.length) console.log(`pdf_has_text=true なのに文字層が薄い（画像に落ちる）行: ${thin.length} 件 例 ${JSON.stringify(thin.slice(0, 5))}`);

  // ② 同じ物件の写し（各行の時点で、それより前の 7日以内に同じ pdf_url の image_lines があったか）
  let reusable = 0, reused = 0;
  const seen: Array<{ pdf_url: string | null; image_lines: unknown; created_at: string | null }> = [];
  for (const p of picks) {
    const at = Date.parse(p.created_at);
    const prev = p.pdf_url ? reusableLinesByPdfUrl(seen, at).get(p.pdf_url) ?? null : null;
    if (prev) reusable++;
    if (planDetailSource(p.pdf_text, !!(p.agent_image_url || p.page_image_url), prev).source === "reuse") reused++;
    seen.push({ pdf_url: p.pdf_url, image_lines: p.image_lines, created_at: p.created_at });
  }
  console.log(`同じ pdf_url の 7日以内の行があった行: ${reusable} / ${picks.length}（${picks.length ? Math.round(reusable / picks.length * 100) : 0}%）・そのうち実際に写す（文字層が無い）行: ${reused}`);

  // ③ llm_usage_logs（production）
  type Row = { created_at: string; model: string | null; action: string | null; status: number; error_type: string | null; input_uncached: number; cache_read: number; output_tokens: number; duration_ms: number };
  const rows: Row[] = [];
  for (let off = 0; ; off += 1000) {
    const { data, error } = await sb.from("llm_usage_logs").select("created_at, model, action, status, error_type, input_uncached, cache_read, output_tokens, duration_ms")
      .gte("created_at", since).in("action", ["property_image_detail", "property_text_detail"]).eq("env", "production").order("created_at", { ascending: true }).range(off, off + 999);
    if (error) throw new Error(error.message);
    rows.push(...((data ?? []) as Row[]));
    if (!data || data.length < 1000) break;
  }
  const dayKey = (iso: string) => new Date(new Date(iso).getTime() + 9 * 3600e3).toISOString().slice(0, 10);
  const agg = new Map<string, { n: number; usd: number; fail: number; ms: number; out: number }>();
  for (const r of rows) {
    const k = `${dayKey(r.created_at)} ${r.action}`;
    const v = agg.get(k) ?? { n: 0, usd: 0, fail: 0, ms: 0, out: 0 };
    v.n++; v.usd += officialCost(r); if (r.status !== 200 || r.error_type) v.fail++; v.ms += r.duration_ms; v.out += r.output_tokens;
    agg.set(k, v);
  }
  console.log(`\n=== llm_usage_logs（production・JST 日別）property_image_detail / property_text_detail ===`);
  console.log("日 action | 回 | 失敗 | 公式$ | 平均秒 | 平均出力トークン");
  for (const [k, v] of [...agg.entries()].sort()) console.log(`${k} | ${v.n} | ${v.fail} | ${v.usd.toFixed(3)} | ${(v.ms / v.n / 1000).toFixed(1)} | ${Math.round(v.out / v.n)}`);
  console.log("\n正常の目安（切り替え後）: text が大半・image は文字層の無い行＋スタッフが手で送った画像だけ・text の平均出力 300 前後・失敗 0〜数件");

  // ④ image_details の出所（model 列）
  const byModel = new Map<string, number>();
  for (let off = 0; ; off += 1000) {
    const { data, error } = await sb.from("image_details").select("model").gte("read_at", since).range(off, off + 999);
    if (error) { console.warn("image_details を読めない:", error.message); break; }
    for (const r of (data ?? []) as Array<{ model: string | null }>) byModel.set(r.model ?? "(null)", (byModel.get(r.model ?? "(null)") ?? 0) + 1);
    if (!data || data.length < 1000) break;
  }
  console.log(`\n=== image_details（read_at 直近${days}日）の出所（model 列） ===`);
  for (const [k, v] of [...byModel.entries()].sort((a, b) => b[1] - a[1])) console.log(`${k} | ${v}`);
  console.log("目安: text:／pickup_lines／pickup_text: が大半・image: は文字層の無い行＋スタッフが手で送った画像・\"deepseek-flash\"（出所なし）は 9/29 より前の行だけ");
}

main().catch((e) => { console.error(e); process.exit(1); });
