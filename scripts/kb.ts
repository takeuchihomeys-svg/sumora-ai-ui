// scripts/kb.ts — 設計知見を引く（MCP が落ちている時の経路・読み取りのみ）
// 実行: npx tsx --env-file=.env.local scripts/kb.ts --q="自然文の問い" [--tags=RAG,場面] [--limit=8] [--full]
//   2026-10-06（⑯・RAG）--q は埋め込みの近さ＋語＋札＋新しさで並べる（design-knowledge-rag.ts hybridRank・退役した行は出さない）。
//   2026-10-07（3巡目）--scene=<場面>（ack|considering|question|conditions|property_share|cost|viewing|apply か 短いお礼・検討中…）で
//   返信の場面の札「場面:〇〇」・題の型の行に点を足す（問い45で recall@5 0.78→0.96・scripts/kb-scene-rag-eval.ts）。例: --scene=検討中 --q="締めの一文"
//   2026-10-07 段（優先順位）: 並びに段の点（P1 +0.1・P3 −0.1）。P0（絶対・最優先）は問いに関係する時、--scene でも上位 k の外の別枠「★」で先頭に出す。
//   --max-p=1 で P0〜P1（今の決まり）だけ。--no-pin で別枠を出さない（前と同じ形の出力）。段は app/lib/design-knowledge-priority.ts
//   旧の部分一致は --substring（問い24で recall@5 0.04 → 合わせ技 0.88・scripts/kb-rag-eval.ts）
import { createClient } from "@supabase/supabase-js";
import { searchKb, searchKbPinned } from "../app/lib/design-knowledge-rag-server";
import { effectivePriority } from "../app/lib/design-knowledge-priority";
import { formatHit, KB_SCENES, type KbScene, type Scored } from "../app/lib/design-knowledge-rag";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");

const arg = (k: string, d = "") => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=").slice(1).join("=");
const tags = arg("tags").split(",").map((s) => s.trim()).filter(Boolean);
const q = arg("q");
const limit = Number(arg("limit", "10"));
const full = process.argv.includes("--full");
const sceneArg = arg("scene");
const scene = (Object.keys(KB_SCENES) as KbScene[]).find((k) => k === sceneArg || KB_SCENES[k].tag === sceneArg || KB_SCENES[k].tag === `場面:${sceneArg}`) ?? null;
if (sceneArg && !scene) { console.error(`場面が分かりません: ${sceneArg}（${Object.entries(KB_SCENES).map(([k, v]) => `${k}=${v.tag}`).join(" ")}）`); process.exit(1); }

async function main() {
  if (q && !process.argv.includes("--substring")) {
    const k = Number(arg("limit", "8"));
    const maxP = arg("max-p") === "" ? 3 : Number(arg("max-p"));
    const noPin = process.argv.includes("--no-pin");
    let pinned: Scored[] = [], hits: Scored[];
    if (noPin && maxP >= 3) hits = await searchKb(sb, q, { k, tags, scene });
    else {
      const r = await searchKbPinned(sb, q, { k: maxP >= 3 ? k : 10_000, tags, scene });
      pinned = noPin ? [] : r.pinned;
      const rest = noPin ? [...r.pinned.map((s) => ({ ...s, pinned: false })), ...r.hits] : r.hits;
      hits = rest.filter((h) => (h.priority ?? 2) <= maxP).slice(0, k);
    }
    if (pinned.length) console.log(`=== ★ 絶対・最優先（P0・どの場面でも先に守る）${pinned.length}件 ===`);
    for (const h of pinned) {
      console.log("\n" + formatHit(h));
      if (full) console.log(`  ${String(h.row.insight).slice(0, 4000)}`);
    }
    console.log(`${pinned.length ? "\n" : ""}=== 設計知見 ${hits.length}件（自然文: ${q}${tags.length ? "・札 " + tags.join("/") : ""}${scene ? "・" + KB_SCENES[scene].tag : ""}${maxP < 3 ? `・P${maxP} まで` : ""}）===`);
    for (const h of hits) {
      console.log("\n" + formatHit(h));
      if (full) { console.log(`  ${String(h.row.insight).slice(0, 4000)}`); if (h.row.rationale) console.log(`  --根拠-- ${String(h.row.rationale).slice(0, 2500)}`); }
    }
    return;
  }
  let query = sb.from("system_design_thinking")
    .select("title, insight, rationale, tags, created_at")
    .eq("is_current", true).order("created_at", { ascending: false }).limit(limit);
  if (tags.length) query = query.overlaps("tags", tags);
  if (q) query = query.or(`title.ilike.%${q}%,insight.ilike.%${q}%`);
  const { data, error } = await query;
  if (error) { console.error(error.message); process.exit(1); }
  console.log(`=== 設計知見 ${data?.length ?? 0}件 (tags=${tags.join("/") || "なし"} q=${q || "なし"}) ===`);
  for (const d of data ?? []) {
    console.log(`\n■ ${d.title}  ［P${effectivePriority(d as { title: string; insight: string; tags: string[] | null; priority?: number | null })}］`);
    console.log(`  [tags] ${(d.tags as string[] ?? []).join(" / ")}`);
    console.log(`  ${String(d.insight).slice(0, full ? 4000 : 700)}`);
    if (full && d.rationale) console.log(`  --根拠-- ${String(d.rationale).slice(0, 2500)}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
