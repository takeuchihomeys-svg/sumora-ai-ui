/**
 * 送った画像の値（sent_image_properties.facts）の空の欄を、同じ画像の書き写しの読み（image_details.lines）から埋める（2026-11-22 作業員G・#509 ③・LLM なし）
 *   npx tsx --env-file=.env.local scripts/backfill-sent-facts-from-detail.ts --days=14 [--channel=recommendation]           # 前と後の埋まりを数える（書かない）
 *   npx tsx --env-file=.env.local scripts/backfill-sent-facts-from-detail.ts --days=14 --write                               # 書く（夜・22時〜翌8時）
 */
import { supabase } from "../app/lib/supabase-server";
import { factsPatchFromDetail } from "../app/lib/sent-facts-from-detail";

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? null;
const write = process.argv.includes("--write");
const FIELDS = ["floor_plan", "built_ym", "building_age", "status", "floor"];

(async () => {
  const days = Math.min(Number(arg("days") ?? 14) || 14, 120);
  const ch = arg("channel");
  let q = supabase.from("sent_image_properties").select("image_url, channel, facts").gte("created_at", new Date(Date.now() - days * 864e5).toISOString()).not("facts", "is", null).limit(3000);
  if (ch) q = q.eq("channel", ch);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as Array<{ image_url: string; channel: string | null; facts: Record<string, unknown> }>;
  const urls = rows.map((r) => r.image_url);
  const lines = new Map<string, string[]>();
  for (let i = 0; i < urls.length; i += 100) {
    const { data: d } = await supabase.from("image_details").select("image_url, lines").eq("kind", "property").in("image_url", urls.slice(i, i + 100));
    for (const r of (d ?? []) as Array<{ image_url: string; lines: string[] | null }>) if (r.lines?.length && !lines.has(r.image_url)) lines.set(r.image_url, r.lines);
  }
  const before: Record<string, number> = {}, after: Record<string, number> = {};
  let patched = 0, written = 0;
  const samples: string[] = [];
  for (const r of rows) {
    const patch = factsPatchFromDetail(r.facts, lines.get(r.image_url) ?? null);
    const merged = { ...r.facts, ...patch };
    for (const f of FIELDS) { if (r.facts[f] != null && r.facts[f] !== "") before[f] = (before[f] ?? 0) + 1; if (merged[f] != null && merged[f] !== "") after[f] = (after[f] ?? 0) + 1; }
    if (Object.keys(patch).length) {
      patched++;
      if (samples.length < 5) samples.push(`${r.image_url.slice(-30)} ${JSON.stringify(patch)}`);
      if (write) { const { error: e } = await supabase.from("sent_image_properties").update({ facts: merged }).eq("image_url", r.image_url); if (!e) written++; }
    }
  }
  console.log(`${days}日${ch ? `・${ch}` : ""}: ${rows.length}件（書き写しの読みがある ${[...lines.keys()].length}件）・埋める行 ${patched}${write ? `・書いた ${written}` : ""}`);
  for (const f of FIELDS) console.log(`  ${f}: 前 ${before[f] ?? 0} → 後 ${after[f] ?? 0}（/${rows.length}）`);
  for (const s of samples) console.log(`  例 ${s}`);
})().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
