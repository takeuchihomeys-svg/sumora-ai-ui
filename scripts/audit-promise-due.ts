// scripts/audit-promise-due.ts — 約束の期限（PROMISE_DUE_NOTE）を本番の会話の「まだ果たしていない約束」に当てる（読むだけ・LLM なし）
//   直近14日に動いた会話ごとに trackPromises → 期限の語がある約束の文と、読めた期限（あと／今日／過ぎ）を並べる（目で読む）。
//   実行: npx tsx --env-file=.env.local scripts/audit-promise-due.ts
import { supabase } from "../app/lib/supabase-server";
import { trackPromises } from "../app/lib/promise-tracker";
import { promiseDueLabel } from "../app/lib/promise-due";

(async () => {
  const since = new Date(Date.now() - 14 * 86400e3).toISOString();
  const { data: convs } = await supabase.from("conversations").select("id").gte("updated_at", since).range(0, 999);
  let open = 0, withWord = 0, read = 0;
  for (const c of (convs ?? []) as Array<{ id: string }>) {
    const { data: msgs } = await supabase.from("messages").select("sender, text, created_at, is_aix_generated").eq("conversation_id", c.id).gte("created_at", since).order("created_at").range(0, 999);
    const tr = trackPromises(((msgs ?? []) as Array<{ sender: string; text: string | null; created_at: string; is_aix_generated: boolean | null }>).map((m) => ({ sender: m.sender, text: m.text, createdAt: m.created_at, isAix: m.is_aix_generated })));
    for (const p of tr.open) {
      open++;
      if (!p.hasDeadline) continue;
      withWord++;
      const l = promiseDueLabel(p.sentence, Date.parse(p.at), Date.now());
      if (l) read++;
      console.log(`${c.id.slice(0, 8)} ${p.at.slice(5, 16)} 【${p.status}】${p.kind} → ${l ?? "（読めない）"} ｜「${p.sentence}」`);
    }
  }
  console.log(`\nまだ果たしていない約束 ${open}・期限の語あり ${withWord}・期限の日が読めた ${read}`);
  process.exit(0);
})();
