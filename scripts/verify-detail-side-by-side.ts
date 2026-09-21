// 同じ資料画像を DeepSeek と Claude Haiku の両方で読み、**中身を全部並べて目で読む**
// 2026-09-21 竹内「引用先の画像を読み取ってちゃんとした文を生成できるようにする」
// 実行: npx tsx --env-file=.env.local scripts/verify-detail-side-by-side.ts [--n=3]
import { createClient } from "@supabase/supabase-js";
import { parseDetailResult, PROPERTY_IMAGE_DETAIL_PROMPT, PROPERTY_IMAGE_ENDPOINT, PROPERTY_IMAGE_MODEL_DEFAULT } from "../app/lib/property-image-read";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const N = Number((process.argv.find((a) => a.startsWith("--n=")) ?? "--n=3").split("=")[1]);

async function deepseek(url: string) {
  const t0 = Date.now();
  const res = await fetch(PROPERTY_IMAGE_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${(process.env.DEEPSEEK_API_KEY ?? "").trim()}` },
    body: JSON.stringify({
      model: PROPERTY_IMAGE_MODEL_DEFAULT, max_tokens: 8000, reasoning_effort: "low",
      messages: [{ role: "user", content: [{ type: "text", text: PROPERTY_IMAGE_DETAIL_PROMPT }, { type: "image_url", image_url: { url } }] }],
    }),
    signal: AbortSignal.timeout(90_000),
  }).catch(() => null);
  if (!res?.ok) return { ms: Date.now() - t0, d: { kind: "other", lines: [] as string[] }, cost: 0 };
  const j = await res.json() as { choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } };
  const cost = ((j.usage?.prompt_tokens ?? 0) / 1e6) * 0.28 + ((j.usage?.completion_tokens ?? 0) / 1e6) * 0.42;
  return { ms: Date.now() - t0, d: parseDetailResult(String(j.choices?.[0]?.message?.content ?? "")), cost };
}
async function claude(url: string) {
  const t0 = Date.now();
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": (process.env.ANTHROPIC_API_KEY ?? "").trim(), "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001", max_tokens: 1500,
      messages: [{ role: "user", content: [{ type: "image", source: { type: "url", url } }, { type: "text", text: PROPERTY_IMAGE_DETAIL_PROMPT }] }],
    }),
    signal: AbortSignal.timeout(60_000),
  }).catch(() => null);
  if (!res?.ok) return { ms: Date.now() - t0, d: { kind: "other", lines: [] as string[] }, cost: 0 };
  const j = await res.json() as { content?: Array<{ type: string; text?: string }>; usage?: { input_tokens?: number; output_tokens?: number } };
  const cost = ((j.usage?.input_tokens ?? 0) / 1e6) * 1.0 + ((j.usage?.output_tokens ?? 0) / 1e6) * 5.0;
  return { ms: Date.now() - t0, d: parseDetailResult(String(j.content?.find((b) => b.type === "text")?.text ?? "")), cost };
}

async function main() {
  const { data } = await sb.from("sent_image_properties")
    .select("image_url, property_name, room_no, created_at").order("created_at", { ascending: false }).limit(80);
  const rows = ((data ?? []) as Array<{ image_url: string; property_name: string; room_no: string | null }>);
  let shown = 0;
  for (const r of rows) {
    if (shown >= N) break;
    const [ds, cl] = await Promise.all([deepseek(r.image_url), claude(r.image_url)]);
    if (ds.d.lines.length === 0 && cl.d.lines.length === 0) continue;   // 見積書などは飛ばす
    shown++;
    console.log("═".repeat(78));
    console.log(`記録されている物件名: ${r.property_name} ${r.room_no ?? ""}`);
    console.log(`── DeepSeek（${ds.ms}ms・$${ds.cost.toFixed(4)}）kind=${ds.d.kind}`);
    for (const l of ds.d.lines) console.log(`   ・${l}`);
    console.log(`── Claude Haiku（${cl.ms}ms・$${cl.cost.toFixed(4)}）kind=${cl.d.kind}`);
    for (const l of cl.d.lines) console.log(`   ・${l}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
