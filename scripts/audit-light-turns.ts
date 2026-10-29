// scripts/audit-light-turns.ts — 統括③の「軽い番」を過去の会話で数える（読むだけ・LLM なし）
//   直近 N 日のお客様の番（連投のまとまり）ごとに brain-depth.decideBrainDepth を当て、軽い番でスタッフが実際に何をしたか
//   （AIX を押した／手打ちで返した（字数）／何もしない）と、その番のブレインの呼び出しの数・費用の目安を数える。
// 使い方: npx tsx --env-file=.env.local scripts/audit-light-turns.ts [--days=30]
import { createClient } from "@supabase/supabase-js";
import { decideBrainDepth } from "../app/lib/brain-depth";
import { isAckOnlyTurn } from "../app/lib/ack-topic-scope";
import { buildPromiseQueue } from "../app/lib/promise-queue";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const days = Number(process.argv.find((a) => a.startsWith("--days="))?.slice(7) ?? 30);
type M = { conversation_id: string; sender: string; text: string | null; created_at: string; is_aix_generated: boolean | null };
(async () => {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const msgs: M[] = [];
  for (let off = 0; ; off += 1000) {
    const { data, error } = await sb.from("messages").select("conversation_id, sender, text, created_at, is_aix_generated").gte("created_at", since).order("created_at").range(off, off + 999);
    if (error) throw error;
    msgs.push(...((data ?? []) as M[]));
    if (!data || data.length < 1000) break;
  }
  const { data: logs } = await sb.from("aix_usage_logs").select("conversation_id, aix_type, created_at").gte("created_at", since).limit(20000);
  const usage: Array<{ conversation_id: string | null; action: string; created_at: string; input_uncached: number | null; cache_read: number | null; cache_write: number | null; output_tokens: number | null; model: string | null }> = [];
  for (let off = 0; ; off += 1000) { const { data } = await sb.from("llm_usage_logs").select("conversation_id, action, created_at, input_uncached, cache_read, cache_write, output_tokens, model").gte("created_at", since).like("action", "brain%").eq("env", "production").range(off, off + 999); usage.push(...((data ?? []) as typeof usage)); if (!data || data.length < 1000) break; }
  // Sonnet の単価（$/1M・入力3・キャッシュ読み0.3・書き3.75・出力15）でおおよそ
  const usd = (u: (typeof usage)[number]) => ((u.input_uncached ?? 0) * 3 + (u.cache_read ?? 0) * 0.3 + (u.cache_write ?? 0) * 3.75 + (u.output_tokens ?? 0) * 15) / 1e6;
  const { data: picks } = await sb.from("property_pickups").select("conversation_id, created_at, expired_at, status").gte("created_at", new Date(Date.now() - (days + 14) * 86_400_000).toISOString()).limit(50000);
  const { data: views } = await sb.from("viewing_history").select("conversation_id, scheduled_date").gte("scheduled_date", since.slice(0, 10)).limit(5000);
  const jstDay = (iso: string) => new Date(Date.parse(iso) + 9 * 3_600_000).toISOString().slice(0, 10);
  const byConv = new Map<string, M[]>();
  for (const m of msgs) { const a = byConv.get(m.conversation_id) ?? []; a.push(m); byConv.set(m.conversation_id, a); }
  const stat: Record<string, { n: number; aix: Record<string, number>; reply: number; replyShort: number; none: number; brainCalls: number; usd: number }> = {};
  for (const [conv, ms] of byConv) {
    for (let i = 0; i < ms.length; i++) {
      if (ms[i].sender !== "customer" || (i > 0 && ms[i - 1].sender === "customer")) continue;
      let j = i; while (j + 1 < ms.length && ms[j + 1].sender === "customer") j++;
      const turn = ms.slice(i, j + 1); const t = turn.map((m) => m.text ?? "").join("\n");
      const lastStaff = [...ms.slice(0, i)].reverse().find((m) => m.sender !== "customer" && (m.text ?? "").trim())?.text ?? "";
      const prevCust = [...ms.slice(0, i)].reverse().find((m) => m.sender === "customer");
      const stampOnly = turn.every((m) => /^\s*\[(?:スタンプ|画像)\]\s*$/.test(m.text ?? "") || !(m.text ?? "").trim());
      const d = decideBrainDepth({ turnText: t, stampOnly, ackOnly: !stampOnly && isAckOnlyTurn(t), closedBefore: /ご検討|何卒よろしく|出次第|お待ちしており|ご連絡お待ち/.test(lastStaff), pickupReady: null, openPromises: 0, gapHours: prevCust ? (Date.parse(turn[0].created_at) - Date.parse(prevCust.created_at)) / 3_600_000 : null });
      let key = `${d.depth}:${d.reason}`;
      if (d.depth === "light") {
        // 統括③の「深く読むかの網」: 開いている約束（探し続ける約束は除く）・送れる候補・内覧の当日。どれかあれば軽くしない
        const tMs = Date.parse(turn[0].created_at);
        const hist = ms.slice(0, i).map((m) => ({ sender: m.sender, text: m.text, createdAt: m.created_at, isAix: m.is_aix_generated }));
        const qlogs = (logs ?? []).filter((l) => l.conversation_id === conv && Date.parse(l.created_at) < tMs).map((l) => ({ aixType: String(l.aix_type), sentAt: l.created_at }));
        const open = buildPromiseQueue(hist, qlogs, tMs).filter((p) => p.status === "pending" && !p.watch).length;
        const ready = (picks ?? []).some((p) => p.conversation_id === conv && p.status === "pending" && Date.parse(p.created_at) < tMs && (!p.expired_at || Date.parse(p.expired_at) > tMs));
        const vday = (views ?? []).some((v) => v.conversation_id === conv && v.scheduled_date === jstDay(turn[0].created_at));
        key = open ? "light→網:約束あり" : ready ? "light→網:送れる候補" : vday ? "light→網:内覧の当日" : "light:本当に軽い";
      }
      const st = (stat[key] ??= { n: 0, aix: {}, reply: 0, replyShort: 0, none: 0, brainCalls: 0, usd: 0 });
      st.n++;
      const tEnd = Date.parse(turn[turn.length - 1].created_at), until = j + 1 < ms.length ? Date.parse(ms[j + 1].created_at) + 2 * 3_600_000 : tEnd + 6 * 3_600_000;
      const next = ms[j + 1];
      const pressed = (logs ?? []).filter((l) => l.conversation_id === conv && Date.parse(l.created_at) > tEnd && Date.parse(l.created_at) <= until).map((l) => String(l.aix_type));
      if (pressed.length) for (const p of new Set(pressed)) st.aix[p] = (st.aix[p] ?? 0) + 1;
      else if (next && next.sender !== "customer" && !next.is_aix_generated) { st.reply++; if (Array.from(next.text ?? "").length <= 60) st.replyShort++; }
      else st.none++;
      const us = usage.filter((u) => u.conversation_id === conv && Date.parse(u.created_at) >= Date.parse(turn[0].created_at) && Date.parse(u.created_at) <= until);
      st.brainCalls += us.length; st.usd += us.reduce((a, u) => a + usd(u), 0);
    }
  }
  const rows = Object.entries(stat).sort((a, b) => b[1].n - a[1].n);
  console.log(`直近${days}日・お客様の番の深さ（記録だけの判定を過去に当てた）`);
  for (const [k, v] of rows) {
    const top = Object.entries(v.aix).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([a, n]) => `${a} ${n}`).join("・");
    console.log(`${k.padEnd(18)} 番 ${String(v.n).padStart(5)}｜AIX ${Object.values(v.aix).reduce((s, x) => s + x, 0)}（${top}）｜手打ち ${v.reply}（60字以下 ${v.replyShort}）｜何もしない ${v.none}｜ブレインの呼び出し ${v.brainCalls}（1番 ${(v.brainCalls / v.n).toFixed(2)}・約 ${v.usd.toFixed(2)}）`);
  }
})();
