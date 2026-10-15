// scripts/audit-brain-cache-1015-materials.ts — 読むだけ。ブレイン（毎回の分析）の素の入力（キャッシュされない user の最後のブロック）が
//   どの材料から来ているかを、見張りの行（line_watch_turns.materials.brain.blocks＝brain:blocks の文字数）で数える。
// 実行: npx tsx --env-file=.env.local scripts/audit-brain-cache-1015-materials.ts [--days=7] [--dump]
import { createClient } from "@supabase/supabase-js";

const arg = (k: string, d = "") => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=").slice(1).join("=");
const days = Number(arg("days", "7")) || 7;
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, (process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)!);

type Blk = { mode?: string; layer?: string; userTotal?: number | null; chars?: Record<string, number> };

async function main() {
  const since = new Date(Date.now() - days * 86400_000);
  const rows: Array<{ conversation_id: string; customer_turn_at: string; materials: unknown }> = [];
  // 6時間ずつ（大きな表の時間切れを避ける）
  for (let t = since.getTime(); t < Date.now(); t += 6 * 3600_000) {
    const { data, error } = await sb.from("line_watch_turns").select("conversation_id, customer_turn_at, materials")
      .gte("customer_turn_at", new Date(t).toISOString()).lt("customer_turn_at", new Date(t + 6 * 3600_000).toISOString())
      .not("materials", "is", null).limit(1000);
    if (error) { console.error(error.message); continue; }
    rows.push(...((data ?? []) as typeof rows));
  }
  if (process.argv.includes("--dump")) { console.log(JSON.stringify(rows.slice(0, 2), null, 1).slice(0, 4000)); return; }
  const blocks: Blk[] = [];
  for (const r of rows) {
    const m = r.materials as Record<string, unknown> | null;
    const b = (m?.brain as Record<string, unknown> | undefined)?.blocks;
    const list = Array.isArray(b) ? b : b ? [b] : [];
    for (const x of list) {
      const s = ((x as Record<string, unknown>).summary ?? x) as Blk;
      if (s && s.layer === "fresh" && typeof s.userTotal === "number") blocks.push(s);
    }
  }
  console.log("turns", rows.length, "fresh blocks", blocks.length);
  const sum: Record<string, number> = {};
  let total = 0;
  for (const b of blocks) {
    total += b.userTotal ?? 0;
    for (const [k, v] of Object.entries(b.chars ?? {})) sum[k] = (sum[k] ?? 0) + (Number(v) || 0);
  }
  const n = blocks.length || 1;
  console.log("avg userTotal(chars)", Math.round(total / n));
  for (const [k, v] of Object.entries(sum).sort((a, b) => b[1] - a[1])) console.log(k.padEnd(18), String(Math.round(v / n)).padStart(7), `${((v / total) * 100).toFixed(1)}%`);
  const scenes: Record<string, number> = {};
  for (const b of blocks) { const s = String((b as Record<string, unknown>).brainScene ?? "?"); scenes[s] = (scenes[s] ?? 0) + 1; }
  console.log("scenes", JSON.stringify(scenes));
}
main().catch((e) => { console.error(e); process.exit(1); });
