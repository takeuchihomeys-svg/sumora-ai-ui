// scripts/audit-image-detail-cost.ts — 資料の画像の読み取り（property_image_detail・DeepSeek）の費用と、文字層で足りる割合の監査（読み取りのみ）
// 実行: npx tsx --env-file=.env.local scripts/audit-image-detail-cost.ts [--day=2026-09-28]
//
// 2026-09-29 竹内「昨日かなり DeepSeek で API 費用を使った。更に節約できないか調査する」
//   ① 公式料金（api-docs.deepseek.com/quick_start/pricing・ピーク＝UTC 01-04/06-10 の平日は2倍）で 1日の DeepSeek の実額を推定
//   ② property_image_detail の費用の内訳（入力／キャッシュ／出力＝推論）
//   ③ 売上サポの行（property_pickups）で、画像から読んだ行（image_lines）の値が PDF の文字層（pdf_text）にどれだけ載っているか
//   ④ 同じ画像・同じ物件を何度読んだか（送信時の読み取り image_details との重なり）
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d = "") => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=").slice(1).join("=");
const day = arg("day", "2026-09-28");
const from = new Date(`${day}T00:00:00+09:00`).toISOString();
const to = new Date(`${day}T23:59:59.999+09:00`).toISOString();

/** 公式（2026-09-29 取得・$/M）。ピークは平日 UTC 01:00-04:00・06:00-10:00（JST 10-13・15-19） */
const OFFICIAL: Record<string, { hit: [number, number]; miss: [number, number]; out: [number, number] }> = {
  "deepseek-flash": { hit: [0.003, 0.006], miss: [0.15, 0.30], out: [0.6, 1.2] },
  "deepseek-v4-pro": { hit: [0.022, 0.044], miss: [0.66, 1.32], out: [1.98, 3.96] },
};
export function isDeepseekPeak(iso: string): boolean {
  const d = new Date(iso);
  const dow = d.getUTCDay(); if (dow === 0 || dow === 6) return false;
  const h = d.getUTCHours() + d.getUTCMinutes() / 60;
  return (h >= 1 && h < 4) || (h >= 6 && h < 10);
}
export function officialCost(r: { model: string | null; created_at: string; input_uncached: number; cache_read: number; output_tokens: number }): number {
  const p = OFFICIAL[r.model ?? ""] ?? OFFICIAL["deepseek-flash"];
  const i = isDeepseekPeak(r.created_at) ? 1 : 0;
  return (r.cache_read * p.hit[i] + r.input_uncached * p.miss[i] + r.output_tokens * p.out[i]) / 1e6;
}

type Row = { created_at: string; model: string | null; action: string | null; env: string | null; status: number; input_uncached: number; cache_read: number; output_tokens: number; duration_ms: number };

async function main() {
  const rows: Row[] = [];
  for (let off = 0; ; off += 1000) {
    const { data, error } = await sb.from("llm_usage_logs").select("created_at, model, action, env, status, input_uncached, cache_read, output_tokens, duration_ms")
      .gte("created_at", from).lte("created_at", to).like("model", "deepseek%").eq("env", "production").order("created_at", { ascending: true }).range(off, off + 999);
    if (error) throw new Error(error.message);
    rows.push(...((data ?? []) as Row[]));
    if (!data || data.length < 1000) break;
  }
  // ① 公式料金で
  const byAction = new Map<string, { n: number; usd: number; usdIn: number; usdHit: number; usdOut: number; peakN: number }>();
  for (const r of rows) {
    const k = `${r.action} | ${r.model}`;
    const v = byAction.get(k) ?? { n: 0, usd: 0, usdIn: 0, usdHit: 0, usdOut: 0, peakN: 0 };
    const p = OFFICIAL[r.model ?? ""] ?? OFFICIAL["deepseek-flash"]; const i = isDeepseekPeak(r.created_at) ? 1 : 0;
    v.n++; v.usd += officialCost(r); v.usdIn += r.input_uncached * p.miss[i] / 1e6; v.usdHit += r.cache_read * p.hit[i] / 1e6; v.usdOut += r.output_tokens * p.out[i] / 1e6; v.peakN += i;
    byAction.set(k, v);
  }
  console.log(`=== ${day}（JST・production）DeepSeek 公式料金での推定 ===`);
  console.log("action | n | peak回 | 合計$ | 入力(未命中)$ | 命中$ | 出力(推論込み)$");
  let total = 0;
  for (const [k, v] of [...byAction.entries()].sort((a, b) => b[1].usd - a[1].usd)) { total += v.usd; console.log(`${k} | ${v.n} | ${v.peakN} | ${v.usd.toFixed(3)} | ${v.usdIn.toFixed(3)} | ${v.usdHit.toFixed(3)} | ${v.usdOut.toFixed(3)}`); }
  console.log(`合計 $${total.toFixed(2)}（全部オフピークなら $${(rows.reduce((s, r) => { const p = OFFICIAL[r.model ?? ""] ?? OFFICIAL["deepseek-flash"]; return s + (r.cache_read * p.hit[0] + r.input_uncached * p.miss[0] + r.output_tokens * p.out[0]) / 1e6; }, 0)).toFixed(2)}・全部ピークなら $${(rows.reduce((s, r) => { const p = OFFICIAL[r.model ?? ""] ?? OFFICIAL["deepseek-flash"]; return s + (r.cache_read * p.hit[1] + r.input_uncached * p.miss[1] + r.output_tokens * p.out[1]) / 1e6; }, 0)).toFixed(2)}）`);

  // 7日
  const since7 = new Date(new Date(to).getTime() - 7 * 86400e3).toISOString();
  const rows7: Row[] = [];
  for (let off = 0; ; off += 1000) {
    const { data, error } = await sb.from("llm_usage_logs").select("created_at, model, action, env, status, input_uncached, cache_read, output_tokens, duration_ms")
      .gte("created_at", since7).lte("created_at", to).like("model", "deepseek%").eq("env", "production").order("created_at", { ascending: true }).range(off, off + 999);
    if (error) throw new Error(error.message);
    rows7.push(...((data ?? []) as Row[]));
    if (!data || data.length < 1000) break;
  }
  const w = new Map<string, { n: number; usd: number }>();
  for (const r of rows7) { const v = w.get(r.action ?? "null") ?? { n: 0, usd: 0 }; v.n++; v.usd += officialCost(r); w.set(r.action ?? "null", v); }
  console.log(`\n=== 直近7日（〜${day}・production）DeepSeek 公式料金 ===`);
  for (const [k, v] of [...w.entries()].sort((a, b) => b[1].usd - a[1].usd)) console.log(`${k} | ${v.n} | $${v.usd.toFixed(2)}`);
  console.log(`7日合計 $${[...w.values()].reduce((s, v) => s + v.usd, 0).toFixed(2)}`);

  // ③ 文字層で足りる割合
  type P = { id: number; pdf_text: string | null; image_lines: unknown; agent_image_url: string | null; page_image_url: string | null; pdf_url: string | null; conversation_id: string | null };
  const picks: P[] = [];
  for (let off = 0; ; off += 500) {
    const { data, error } = await sb.from("property_pickups").select("id, pdf_text, image_lines, agent_image_url, page_image_url, pdf_url, conversation_id").gte("created_at", from).lte("created_at", to).range(off, off + 499);
    if (error) throw new Error(error.message);
    picks.push(...((data ?? []) as P[]));
    if (!data || data.length < 500) break;
  }
  const norm = (s: string) => s.replace(/\s+/g, "").replace(/[：]/g, ":").toLowerCase();
  let lines = 0, inText = 0, rowsAll = 0, rowsAllIn = 0;
  const missByKey = new Map<string, number>();
  const samplesMiss: string[] = [];
  for (const p of picks) {
    const ls = Array.isArray(p.image_lines) ? (p.image_lines as unknown[]).map(String) : [];
    if (ls.length === 0) continue;
    rowsAll++;
    const t = norm(p.pdf_text ?? "");
    let allIn = true;
    for (const l of ls) {
      lines++;
      const [key, ...rest] = l.split(/[:：]/);
      const val = norm(rest.join(":"));
      // 値の語（「・」「、」「/」区切り）が全部文字層にあれば「文字層で足りる」
      const parts = val.split(/[・、,\/／]/).map((x) => x.trim()).filter((x) => x.length >= 1);
      const ok = parts.length > 0 && parts.every((x) => t.includes(x));
      if (ok) inText++; else { allIn = false; missByKey.set(key.trim(), (missByKey.get(key.trim()) ?? 0) + 1); if (samplesMiss.length < 25) samplesMiss.push(`#${p.id} ${l}`); }
    }
    if (allIn) rowsAllIn++;
  }
  console.log(`\n=== ③ 画像から読んだ行（image_lines）の値が PDF の文字層にあるか（${day}） ===`);
  console.log(`行: ${inText}/${lines}（${Math.round(100 * inText / Math.max(1, lines))}%）が文字層にそのまま載っている。物件: ${rowsAllIn}/${rowsAll} は全行が文字層にある`);
  console.log("文字層に無い行の項目別:", [...missByKey.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, n]) => `${k}=${n}`).join(" "));
  console.log("文字層に無い行の例:\n  " + samplesMiss.join("\n  "));

  // ④ 送信時の読み取り（image_details）との重なり: 当日の image_details のうち conversation_id あり・売上サポ以外
  const { data: det } = await sb.from("image_details").select("image_url, conversation_id, read_at, kind").gte("read_at", from).lte("read_at", to).limit(3000);
  const detRows = (det ?? []) as Array<{ image_url: string; conversation_id: string | null; read_at: string | null; kind: string }>;
  const pickUrls = new Set(picks.map((p) => p.agent_image_url ?? p.page_image_url).filter(Boolean));
  console.log(`\n=== ④ image_details（read_at が当日）: ${detRows.length} 行、うち売上サポの画像 ${detRows.filter((d) => pickUrls.has(d.image_url)).length}、それ以外 ${detRows.filter((d) => !pickUrls.has(d.image_url)).length}（kind: ${[...new Set(detRows.filter((d) => !pickUrls.has(d.image_url)).map((d) => d.kind))].join(",")}）`);
  // 送信時の読み取りの対象＝スタッフが送った画像（messages）
  const { count: staffImgs } = await sb.from("messages").select("id", { count: "exact", head: true }).gte("created_at", from).lte("created_at", to).eq("sender", "staff").not("image_url", "is", null);
  console.log(`スタッフが送った画像（messages・当日）: ${staffImgs} 枚 → 送信時の読み取り（ensureImageDetail・25秒）の上限回数`);
}
main().catch((e) => { console.error(e); process.exit(1); });
