// AIX の記録を「日にち」で渡すか「時刻」まで渡すかを決めるための実測（読み取りのみ）
// 2026-09-23 竹内「送信の履歴 日にちで分かるようにしたと思うんやけど 時間でもしたらどうかな？」
//   足す前に、時刻が無いと何が分からないのかを数える（設計知見「材料を足す前に測る」）。
// 実行: npx tsx --env-file=.env.local scripts/peek-aix-time-granularity.ts [DAYS=60]
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
type Aix = { conversation_id: string; aix_type: string | null; created_at: string };
type Msg = { conversation_id: string; sender: string | null; created_at: string };
const jstDay = (iso: string) => new Date(new Date(iso).getTime() + 9 * 3600_000).toISOString().slice(0, 10);
const med = (a: number[]) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)] ?? 0;
const pct = (a: number, b: number) => (b === 0 ? "—" : `${((a / b) * 100).toFixed(1)}%`);

async function page<T>(table: string, cols: string, since: string): Promise<T[]> {
  const out: T[] = [];
  for (let p = 0; p < 60; p++) {
    const { data, error } = await sb.from(table).select(cols).gte("created_at", since).order("created_at").range(p * 1000, p * 1000 + 999);
    if (error) { console.error(`${table}: ${error.message}`); break; }
    const r = (data ?? []) as T[]; out.push(...r); if (r.length < 1000) break;
  }
  return out;
}

async function main() {
  const days = Number(process.env.DAYS ?? 60);
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const aix = await page<Aix>("aix_usage_logs", "conversation_id, aix_type, created_at", since);
  const msgs = await page<Msg>("messages", "conversation_id, sender, created_at", since);
  console.log(`直近${days}日: AIX 押下 ${aix.length}件 ／ メッセージ ${msgs.length}通\n`);

  // ① 同じ日に同じ AIX を2回以上押しているか（日にちだけだと区別できない回）
  const byConvType = new Map<string, string[]>();
  for (const a of aix) {
    const k = `${a.conversation_id}|${a.aix_type ?? "?"}`;
    if (!byConvType.has(k)) byConvType.set(k, []);
    byConvType.get(k)!.push(a.created_at);
  }
  let sameDayDup = 0, multiDay = 0, single = 0;
  for (const ts of byConvType.values()) {
    if (ts.length === 1) { single++; continue; }
    const days = new Set(ts.map(jstDay));
    if (days.size < ts.length) sameDayDup++; else multiDay++;
  }
  const totalPairs = sameDayDup + multiDay + single;
  console.log(`① 同じ会話×同じAIX の組 ${totalPairs}`);
  console.log(`   1回だけ                    ${String(single).padStart(4)}（${pct(single, totalPairs)}）`);
  console.log(`   複数回・全部ちがう日        ${String(multiDay).padStart(4)}（${pct(multiDay, totalPairs)}）`);
  console.log(`   **複数回・同じ日が混ざる**  ${String(sameDayDup).padStart(4)}（${pct(sameDayDup, totalPairs)}）← 日にちだけだと区別できない`);

  // ② 直近の AIX からお客様の次の発言までの間隔（「送った直後で反応待ちか」の判断に要る）
  const byConvA = new Map<string, string[]>();
  for (const a of aix) { if (!byConvA.has(a.conversation_id)) byConvA.set(a.conversation_id, []); byConvA.get(a.conversation_id)!.push(a.created_at); }
  const byConvM = new Map<string, Msg[]>();
  for (const m of msgs) { if (!byConvM.has(m.conversation_id)) byConvM.set(m.conversation_id, []); byConvM.get(m.conversation_id)!.push(m); }
  const gaps: number[] = [];
  let sameDayReply = 0, withinHour = 0, noReplySameDay = 0;
  for (const [cid, ts] of byConvA) {
    const cust = (byConvM.get(cid) ?? []).filter((m) => m.sender === "customer");
    for (const t of ts) {
      const at = Date.parse(t);
      const next = cust.find((m) => Date.parse(m.created_at) > at);
      if (!next) continue;
      const h = (Date.parse(next.created_at) - at) / 3600_000;
      gaps.push(h);
      if (jstDay(next.created_at) === jstDay(t)) sameDayReply++; else noReplySameDay++;
      if (h <= 1) withinHour++;
    }
  }
  console.log(`\n② AIX を押してからお客様が返すまで（${gaps.length}回）`);
  console.log(`   中央値 ${med(gaps).toFixed(1)}時間 ／ 1時間以内 ${pct(withinHour, gaps.length)} ／ 同じ日のうちに返信 ${pct(sameDayReply, gaps.length)} ／ 翌日以降 ${pct(noReplySameDay, gaps.length)}`);
  console.log(`   → 同じ日に返ってくるのが ${pct(sameDayReply, gaps.length)} なので、「今日押した」だけでは`);
  console.log(`      「送った直後で反応待ち」なのか「朝に送って夕方返ってきた」のかが分からない`);

  // ③ 押した AIX と、その日のうちの次の押下までの間隔
  const sameDayGaps: number[] = [];
  for (const ts of byConvA.values()) {
    const sorted = ts.slice().sort();
    for (let i = 1; i < sorted.length; i++) {
      if (jstDay(sorted[i]) !== jstDay(sorted[i - 1])) continue;
      sameDayGaps.push((Date.parse(sorted[i]) - Date.parse(sorted[i - 1])) / 3600_000);
    }
  }
  console.log(`\n③ 同じ日に続けて押した間隔（${sameDayGaps.length}回）: 中央値 ${med(sameDayGaps).toFixed(1)}時間 ／ 1時間以内 ${pct(sameDayGaps.filter((h) => h <= 1).length, sameDayGaps.length)}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
