// scripts/audit-trailing-space.ts
// 2026-10-02 ⑫: 下書きの行末の空白（半角・全角・タブ）を出口で落としてよいかの線引き。読むだけ・LLM なし。
//   ①人の実送信（スタッフの手打ち・365日）で行末の空白がある通の数と形（全角の空白で字下げ・飾りにしていないか）を目で読む
//   ②AI の下書き（ai_reply_examples.ai_draft・180日）で行末の空白がある数と、スタッフが送った文で残したか
// 実行: npx tsx --env-file=.env.local scripts/audit-trailing-space.ts [--show=20]
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const SHOW = Number((process.argv.find((a) => a.startsWith("--show=")) ?? "--show=20").slice(7));
const TRAIL_RE = /[ \t　]+(?=\n|$)/;
const vis = (t: string) => t.replace(/　/g, "□").replace(/ /g, "·").replace(/\t/g, "→").replace(/\n/g, "⏎");
(async () => {
  const since = new Date(Date.now() - 365 * 86_400_000).toISOString();
  let n = 0, hit = 0, onlyBlankLines = 0, shown = 0;
  for (let f = 0; f < 600_000; f += 1000) {
    const { data, error } = await sb.from("messages").select("conversation_id, text, is_aix_generated").eq("sender", "staff").gte("created_at", since).range(f, f + 999);
    if (error) throw error;
    for (const r of (data ?? []) as Array<{ conversation_id: string; text: string | null; is_aix_generated: boolean | null }>) {
      const t = r.text ?? "";
      if (!t.trim() || r.is_aix_generated) continue;
      n++;
      if (!TRAIL_RE.test(t)) continue;
      hit++;
      // 行末の空白の後ろに文字が続く行（＝字下げではなく行末）だけか。空白だけの行か
      if (t.split("\n").every((l) => !/[ \t　]+$/.test(l) || l.trim() === "")) onlyBlankLines++;
      if (shown++ < SHOW) { const l = t.split("\n").find((x) => /[ \t　]+$/.test(x)) ?? ""; console.log(`  ${r.conversation_id.slice(0, 8)} 行: ${vis(l.slice(-40))}`); }
    }
    if ((data ?? []).length < 1000) break;
  }
  console.log(`人の手打ち ${n}通・行末の空白あり ${hit}（うち空白だけの行のみ ${onlyBlankLines}）`);
  const s2 = new Date(Date.now() - 180 * 86_400_000).toISOString();
  const { data: ex } = await sb.from("ai_reply_examples").select("ai_draft, sent_reply").gte("created_at", s2).not("ai_draft", "is", null).limit(20000);
  const rows = (ex ?? []) as Array<{ ai_draft: string | null; sent_reply: string | null }>;
  const d = rows.filter((r) => TRAIL_RE.test(r.ai_draft ?? ""));
  console.log(`AI の下書き ${rows.length}・行末の空白あり ${d.length}・送った文にも行末の空白 ${d.filter((r) => TRAIL_RE.test(r.sent_reply ?? "")).length}`);
})();
