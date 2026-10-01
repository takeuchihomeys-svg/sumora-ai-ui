// scripts/audit-promise-calendar-timing.ts
// 実行: npx tsx --env-file=.env.local scripts/audit-promise-calendar-timing.ts           （読み取りのみ・変わる行を表示）
//       APPLY=1 …… 未完了の行だけ見出し・件名を新しい形に書き換える（本番の書き込み。竹内さんの了承の後に流す）
//
// 2026-10-01 竹内（和樹事例）「『引き続き新着で…お送り』という約束は『新着が出たら送る』約束として扱う」:
//   カレンダーの【必ず】物件ピックアップ送付 の行（送信時の記録から作った約束）に、promise-timing.classifyPickupPromiseTiming を
//   notes の「約束: 「…」」の文で当て、新しい見出し（【新着待ち】等・【今日中】なし）に変わる行を数える。
//   約束は消さない・完了にしない・置いた日（start_at）は変えない（変えるのは title と notes の1行目だけ）
import { createClient } from "@supabase/supabase-js";
import { classifyPickupPromiseTiming, PICKUP_TIMING_LABEL, WAIT_TIMINGS } from "../app/lib/promise-timing";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const APPLY = process.env.APPLY === "1";
type Row = { id: number; title: string; notes: string | null; start_at: string; is_done: boolean; customer_name: string | null };

async function main() {
  const { data, error } = await sb.from("calendar_events").select("id, title, notes, start_at, is_done, customer_name")
    .eq("event_type", "property_send").like("notes", "【必ず】%").order("id").limit(5000);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as Row[];
  const count = new Map<string, number>();
  const changes: Array<{ r: Row; title: string; head: string; timing: string; reason: string }> = [];
  for (const r of rows) {
    const lines = (r.notes ?? "").split("\n");
    const sentence = (lines.find((l) => l.startsWith("約束: ")) ?? "").replace(/^約束: 「?/, "").replace(/」$/, "");
    const { timing, reason } = classifyPickupPromiseTiming(sentence);
    const k = `${r.is_done ? "完了" : "未完了"} ${timing}`;
    count.set(k, (count.get(k) ?? 0) + 1);
    if (!WAIT_TIMINGS.has(timing) && timing !== "date") continue;
    const t = PICKUP_TIMING_LABEL[timing];
    const head = `【必ず】${t.label}${t.mark}`;
    if (lines[0] === head) continue;
    const name = (r.customer_name ?? "").trim();
    changes.push({ r, title: name ? `${name} ${t.label}` : t.label, head, timing, reason });
  }
  console.log(`== カレンダーの【必ず】物件ピックアップの行 ${rows.length}件 ==`);
  for (const [k, v] of [...count].sort()) console.log(`  ${k}: ${v}`);
  console.log(`\n== 見出しが変わる行 ${changes.length}件（うち未完了 ${changes.filter((c) => !c.r.is_done).length}件） ==`);
  for (const c of changes) {
    const sentence = ((c.r.notes ?? "").split("\n").find((l) => l.startsWith("約束: ")) ?? "").slice(0, 90);
    console.log(`  ${c.r.is_done ? "完了  " : "未完了"} id ${c.r.id} [${c.timing}/${c.reason}] 「${c.r.title}」→「${c.title}」｜${sentence}`);
  }
  if (APPLY) {
    let n = 0;
    for (const c of changes.filter((x) => !x.r.is_done)) {
      const lines = (c.r.notes ?? "").split("\n");
      lines[0] = c.head;
      const { error: e } = await sb.from("calendar_events").update({ title: c.title, notes: lines.join("\n") }).eq("id", c.r.id).eq("is_done", false);
      if (e) console.error(`  id ${c.r.id} 失敗: ${e.message}`); else n++;
    }
    console.log(`\nAPPLY: 未完了 ${n}件を書き換えた`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
