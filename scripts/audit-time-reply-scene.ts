// scripts/audit-time-reply-scene.ts — 竹内さん本人の番で、場面ごとにお客様の時の言葉への返し方（日付で言い直す・期日を約束する・触れない）を数える（読むだけ・LLM なし）
// 2026-11-21 作業員L（台帳 #500 の下ごしらえ）。読む物: 竹内さん本人の送信のある会話の messages・aix_usage_logs（--days 日）。会話の文は出さない（数だけ）。
//   重い読み: 30日は夜（JST 22時以降）。営業時間は --days=3 --max-conv=30 まで（台本が止める）。
// 実行: npx tsx --env-file=.env.local scripts/audit-time-reply-scene.ts [--days=3] [--max-conv=30]
import { createClient } from "@supabase/supabase-js";
import { timeTurnOf, tallyTimeTurns, TIME_SCENE_JA, TIME_HANDLING_JA, type TimeTurn, type TimeScene, type TimeHandling } from "./lib/time-reply-scene";
import { NO_LINE_TEST_CONVERSATION_IDS, STAFF_INTERNAL_CONVERSATION_IDS, YUMA_CONVERSATION_ID } from "../app/lib/test-conversations";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
type M = { sender: string; text: string | null; created_at: string; staff_writer: string | null; is_aix_generated: boolean | null };
(async () => {
  let days = Number(arg("days", "3")) || 3, maxConv = Number(arg("max-conv", "30")) || 30;
  const h = (new Date().getUTCHours() + 9) % 24;
  if (h >= 9 && h < 22 && !process.argv.includes("--force")) { days = Math.min(days, 3); maxConv = Math.min(maxConv, 30); }
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "", { auth: { persistSession: false } });
  const since = new Date(Date.now() - days * 864e5).toISOString();
  const skip = new Set<string>([YUMA_CONVERSATION_ID, ...NO_LINE_TEST_CONVERSATION_IDS, ...STAFF_INTERNAL_CONVERSATION_IDS]);
  const { data: tk } = await sb.from("messages").select("conversation_id").eq("staff_writer", "takeuchi").gte("created_at", since).limit(5000);
  const convs = [...new Set(((tk ?? []) as Array<{ conversation_id: string }>).map((r) => r.conversation_id))].filter((c) => !skip.has(c)).slice(0, maxConv);
  const turns: TimeTurn[] = [];
  let allTurns = 0;
  for (const c of convs) {
    const [m, a] = await Promise.all([
      sb.from("messages").select("sender, text, created_at, staff_writer, is_aix_generated").eq("conversation_id", c).gte("created_at", since).order("created_at").limit(1000),
      sb.from("aix_usage_logs").select("aix_type, sent_at, created_at").eq("conversation_id", c).gte("created_at", since).limit(300),
    ]);
    const ms = (m.data ?? []) as M[];
    const aix = (a.data ?? []) as Array<{ aix_type: string | null; sent_at: string | null; created_at: string }>;
    for (let i = 1; i < ms.length; i++) {
      const x = ms[i];
      if (x.sender !== "staff" || x.is_aix_generated || x.staff_writer !== "takeuchi" || ms[i - 1].sender !== "customer") continue;
      let j = i - 1; const burst: string[] = []; while (j >= 0 && ms[j].sender === "customer") { burst.unshift(String(ms[j].text ?? "")); j--; }
      let k = i; const reply: string[] = []; while (k < ms.length && ms[k].sender !== "customer") { if (!ms[k].is_aix_generated) reply.push(String(ms[k].text ?? "")); k++; }
      const endAt = k < ms.length ? ms[k].created_at : null;
      const propAix = aix.some((y) => { const at = y.sent_at ?? y.created_at; return at >= x.created_at && (!endAt || at < endAt) && /property_(?:send|recommendation)/.test(String(y.aix_type ?? "")); });
      allTurns++;
      const t = timeTurnOf({ customerBurst: burst.join("\n"), atMs: Date.parse(ms[i - 1].created_at), reply: reply.join("\n"), ourPropertyAix: propAix });
      if (t) turns.push(t);
    }
  }
  const tab = tallyTimeTurns(turns);
  console.log(`竹内さん本人の番でお客様が時の言葉を言った番（${days}日・会話 ${convs.length}・竹内さんの番 ${allTurns}）: ${turns.length}番`);
  for (const s of Object.keys(TIME_SCENE_JA) as TimeScene[]) {
    const r = tab[s]; const n = Object.values(r).reduce((x, y) => x + y, 0);
    if (!n) continue;
    console.log(`${TIME_SCENE_JA[s].padEnd(8)} ${n}番: ${(Object.keys(TIME_HANDLING_JA) as TimeHandling[]).map((hh) => `${TIME_HANDLING_JA[hh]} ${r[hh]}`).join("・")}`);
  }
})().catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
