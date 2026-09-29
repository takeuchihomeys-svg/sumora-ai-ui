// scripts/audit-image-detail-reasoning.ts — 資料の画像の読み取り（property_image_detail）を「推論なし」で読み直し、保存済み（推論 low・max 12,000）の行と比べる
//
// 2026-09-29 竹内「昨日かなり DeepSeek で API 費用を使った」: 9/28 の DeepSeek の費用 $3.5 のうち property_image_detail が 1,024回・$2.98。
//   1回の出力（推論）が平均 6,178 トークン（p90 8,849・上限 12,000 に当たる回あり）で、費用の 9割が出力。
//   売上サポの画像で分析（sheet-read）は推論なし・max 600 で 1件 0.03円になっている（設計知見「DeepSeek の画像で有無を返すだけも推論なしに固定」）。
//   同じ画像で「推論なし・温度0・max 600」が保存済みの行（推論あり）とどれだけ一致するかを、少ない件数で目で読む。
//   ⚠ DB には書かない。本番の読み取りは変えない。鍵は表示しない。件数は --n（既定 8）で最小に
//
// 実行: npx tsx --env-file=.env.local scripts/audit-image-detail-reasoning.ts [--n=8]
import { createClient } from "@supabase/supabase-js";
import { PROPERTY_IMAGE_DETAIL_PROMPT, PROPERTY_IMAGE_ENDPOINT, PROPERTY_IMAGE_MODEL_DEFAULT, parseDetailResult } from "../app/lib/property-image-read";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d = "") => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=").slice(1).join("=");
const N = Number(arg("n", "8"));
const norm = (s: string) => s.replace(/\s+/g, "").replace(/[：]/g, ":");

async function readNoReasoning(imageUrl: string) {
  const apiKey = (process.env.DEEPSEEK_API_KEY ?? "").trim();
  const started = Date.now();
  const res = await fetch(PROPERTY_IMAGE_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: PROPERTY_IMAGE_MODEL_DEFAULT, max_tokens: 600, temperature: 0, thinking: { type: "disabled" },
      messages: [{ role: "user", content: [{ type: "text", text: PROPERTY_IMAGE_DETAIL_PROMPT }, { type: "image_url", image_url: { url: imageUrl } }] }],
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const ms = Date.now() - started;
  if (!res.ok) return { lines: null as string[] | null, ms, usage: null as Record<string, number> | null, err: `HTTP ${res.status}` };
  const j = await res.json() as { choices?: Array<{ message?: { content?: string } }>; usage?: Record<string, number> };
  const parsed = parseDetailResult(String(j.choices?.[0]?.message?.content ?? ""));
  return { lines: parsed.kind === "property" ? parsed.lines : [], kind: parsed.kind, ms, usage: j.usage ?? null, err: null };
}

async function main() {
  if (!process.env.DEEPSEEK_API_KEY) { console.error("DEEPSEEK_API_KEY が無い"); process.exit(1); }
  const { data, error } = await sb.from("property_pickups")
    .select("id, created_at, agent_image_url, page_image_url, image_lines")
    .not("image_lines", "is", null).order("created_at", { ascending: false }).limit(N * 3);
  if (error) { console.error(error.message); process.exit(1); }
  const rows = ((data ?? []) as Array<{ id: number; created_at: string; agent_image_url: string | null; page_image_url: string | null; image_lines: unknown }>)
    .filter((r) => Array.isArray(r.image_lines) && (r.image_lines as unknown[]).length > 0 && (r.agent_image_url || r.page_image_url))
    .slice(0, N);
  let same = 0, total = 0, outTok = 0, inTok = 0, hitTok = 0, msSum = 0, ok = 0;
  for (const r of rows) {
    const url = (r.agent_image_url ?? r.page_image_url) as string;
    const saved = (r.image_lines as string[]).map(String);
    const got = await readNoReasoning(url);
    console.log(`\n■ pickup #${r.id} ${r.created_at.slice(0, 16)} ${got.err ?? `${got.ms}ms out=${got.usage?.completion_tokens ?? "-"} in=${got.usage?.prompt_tokens ?? "-"} hit=${got.usage?.prompt_cache_hit_tokens ?? "-"} kind=${got.kind}`}`);
    if (got.err || !got.lines) continue;
    ok++; msSum += got.ms; outTok += got.usage?.completion_tokens ?? 0; inTok += got.usage?.prompt_cache_miss_tokens ?? 0; hitTok += got.usage?.prompt_cache_hit_tokens ?? 0;
    const g = new Set(got.lines.map(norm));
    const s = new Set(saved.map(norm));
    const both = saved.filter((x) => g.has(norm(x)));
    same += both.length; total += saved.length;
    console.log(`   保存済み（推論あり）${saved.length}行 / 推論なし ${got.lines.length}行 / 同じ行 ${both.length}`);
    for (const x of saved) console.log(`   ${g.has(norm(x)) ? "＝" : "−"} ${x}`);
    for (const x of got.lines) if (!s.has(norm(x))) console.log(`   ＋ ${x}`);
  }
  console.log(`\n=== まとめ: ${ok}/${rows.length} 件読めた・保存済みの行のうち推論なしでも同じ ${same}/${total}・平均 ${ok ? Math.round(msSum / ok) : 0}ms・出力 平均 ${ok ? Math.round(outTok / ok) : 0} トークン（保存済みの平均は 6,000 前後）・入力 未命中 ${inTok} 命中 ${hitTok} ===`);
  console.log(`（＝ 同じ／− 推論なしで落ちた／＋ 推論なしで増えた。件数だけでなく行を目で読むこと）`);
}
main().catch((e) => { console.error(e); process.exit(1); });
