// scripts/line-watch-gen-note-check.ts — 見張りの下書きの控え（トリガー）の抜けを数える（読むだけ・LLM なし・費用 0）
//
// 2026-10-28 作業員1: LINE_WATCH_GEN_NOTE=on の間、generate-reply は保存した下書きを materials.reply.generated にも控える。
//   「materials に生成の控えがあるのに draft_first が空」の番＝トリガーの控えが抜けた番（ロックの待ち 200ms で諦めた・保存と同時に番が閉じた 等）。
//   呼び出し元（caller: auto＝自動の下書き・manual＝画面のボタン 等）ごとに数える。判定（line-watch-judge）は変えない。
// 実行: npx tsx --env-file=.env.local scripts/line-watch-gen-note-check.ts [--days=7] [--list]
import { createClient } from "@supabase/supabase-js";
import { isTestConversation } from "../app/lib/test-conversations";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const DAYS = Number(arg("days", "7"));
const LIST = process.argv.includes("--list");
type Row = { id: number; conversation_id: string; customer_turn_at: string; draft_first: string | null; draft_sentinel: string | null; materials: { reply?: { generated?: { text?: string; caller?: string; at?: string } } } | null };

(async () => {
  const since = new Date(Date.now() - DAYS * 86400_000).toISOString();
  const rows: Row[] = [];
  for (let f = 0; ; f += 1000) {
    const r = await sb.from("line_watch_turns").select("id, conversation_id, customer_turn_at, draft_first, draft_sentinel, materials").gte("customer_turn_at", since).order("id").range(f, f + 999);
    if (r.error) throw new Error(r.error.message);
    rows.push(...((r.data ?? []) as Row[]));
    if ((r.data ?? []).length < 1000) break;
  }
  const withGen = rows.filter((t) => !isTestConversation(t.conversation_id) && t.materials?.reply?.generated?.text);
  const lost = withGen.filter((t) => !t.draft_first && !t.draft_sentinel);
  const by = new Map<string, { n: number; lost: number }>();
  for (const t of withGen) { const c = t.materials?.reply?.generated?.caller ?? "?"; const v = by.get(c) ?? { n: 0, lost: 0 }; v.n++; if (!t.draft_first && !t.draft_sentinel) v.lost++; by.set(c, v); }
  console.log(`# 見張りの下書きの控えの抜け（直近${DAYS}日）`);
  console.log(`生成の控え（materials.reply.generated）がある番 ${withGen.length}・そのうちトリガーの下書きが空 ${lost.length}`);
  if (!withGen.length) console.log("（LINE_WATCH_GEN_NOTE が off か、まだ控えが無い）");
  for (const [c, v] of by) console.log(`- ${c}: ${v.n}番・抜け ${v.lost}`);
  if (LIST) for (const t of lost) console.log(`- #${t.id} ${t.customer_turn_at.slice(5, 16)} ${t.materials?.reply?.generated?.caller} ${String(t.materials?.reply?.generated?.text ?? "").replace(/\s+/g, " ").slice(0, 60)}`);
  process.exit(0);
})();
