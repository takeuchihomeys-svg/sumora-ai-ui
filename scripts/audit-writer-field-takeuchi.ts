// scripts/audit-writer-field-takeuchi.ts — 書き手に「作っていない」欄（配線が無い・スイッチ off）の値が、竹内さん本人の次の通に入っていた割合（読むだけ・LLM なし・台帳 #466）
// 2026-11-26 作業員L（統括役の頼み: 作っていない欄のどれが竹内さんの文に一番効くかを、竹内さん本人の文に入っていた割合で並べて上位1つを試験の組の案に）
//   番＝ブレインの今の答え（conversations.last_brain_meta）の後に、竹内さん本人（messages.staff_writer=takeuchi）が手打ちで送った最初の通。
//   欄の値の頭の語が通に入っていたか（scripts/lib/writer-field-metrics の inDraftOf と同じ見方＝下書きの代わりに竹内さんの通）。出すのは数だけ
// 実行: npx tsx --env-file=.env.local scripts/audit-writer-field-takeuchi.ts [--days=30] [--fields=focus_sub,fact_source,near,aim]
import { createClient } from "@supabase/supabase-js";
import { DELIVERY_FIELDS } from "../app/lib/delivery-check";
import { inDraftOf } from "./lib/writer-field-metrics";
import { isTestConversation } from "../app/lib/test-conversations";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
(async () => {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "", { auth: { persistSession: false } });
  const days = Number(arg("days", "30")), keys = arg("fields", "focus_sub,fact_source,near,aim").split(",");
  const since = new Date(Date.now() - days * 864e5).toISOString();
  const { data, error } = await sb.from("conversations").select("id, brain_analyzed_at, last_brain_meta").gte("brain_analyzed_at", since).order("brain_analyzed_at", { ascending: false }).limit(400);
  if (error) throw new Error(error.message);
  const rows = ((data ?? []) as Array<{ id: string; brain_analyzed_at: string; last_brain_meta: Record<string, unknown> | null }>).filter((r) => r.last_brain_meta && !isTestConversation(r.id));
  const tally = new Map<string, { val: number; judged: number; hit: number }>();
  let turns = 0;
  for (const r of rows) {
    const { data: m } = await sb.from("messages").select("text, staff_writer, is_aix_generated").eq("conversation_id", r.id).eq("sender", "staff").gt("created_at", r.brain_analyzed_at).order("created_at").limit(3);
    const t = ((m ?? []) as Array<{ text: string | null; staff_writer: string | null; is_aix_generated: boolean | null }>).find((x) => !x.is_aix_generated && x.staff_writer === "takeuchi");
    if (!t?.text) continue;
    turns++;
    for (const f of DELIVERY_FIELDS.filter((x) => keys.includes(x.key))) {
      const v = f.value(r.last_brain_meta!);
      if (!v || /^(?:timeout|none|null|-)$/i.test(String(v).trim())) continue;
      const e = tally.get(f.key) ?? { val: 0, judged: 0, hit: 0 };
      e.val++;
      const h = inDraftOf(f.key, String(v), t.text);
      if (h !== null) { e.judged++; if (h) e.hit++; }
      tally.set(f.key, e);
    }
    await new Promise((res) => setTimeout(res, 60));
  }
  console.log(`# 作っていない欄の値が竹内さん本人の次の通に入っていた割合（${days}日・ブレインの答えの後に竹内さんが手打ちした番 ${turns}）\n`);
  console.log("| 欄 | 値のある番 | 測れた番 | 入っていた | 割合 |\n|---|---|---|---|---|");
  for (const [k, e] of [...tally].sort((a, b) => (b[1].judged ? b[1].hit / b[1].judged : -1) - (a[1].judged ? a[1].hit / a[1].judged : -1))) console.log(`| ${k} | ${e.val} | ${e.judged} | ${e.hit} | ${e.judged ? Math.round((e.hit / e.judged) * 1000) / 10 : "—"}% |`);
})().catch((e) => { console.error(e); process.exit(1); });
