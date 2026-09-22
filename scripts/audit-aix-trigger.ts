// 「どういう状況でそのAIXが押されているか」を実データから学ぶ（読み取りのみ）
// 2026-09-23 竹内「送った意味をちゃんと理解できているのか。AIXのボタンのそれぞれの送ったことの意味を
//   ちゃんと理解すれば、状況とそこでAIX押してること分かればもっと精度高くなる。成約データや直近のLINEから学習する」
//
// 今ブレインが持っているのは「そのボタンが何を生成するか」（AIX_CAPABILITY_MAP）と
// 「次に何を押すか」（次打ちマップ）と「成約率」（勝率表）だけで、
// **押す直前にお客様が何を言っていたか**＝どういう場面で押すのかが入っていない。
//
// 設計知見「想像で作らない・実物を読む」「必須にしてよいのは過半数が守っている形だけ」に従い、
//   まず実物を集めて読む。頻出語ではなく**実際の発言**を出す。
//
// 実行: npx tsx --env-file=.env.local scripts/audit-aix-trigger.ts [DAYS=180] [SHOW=6]
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
type Msg = { conversation_id: string; sender: string | null; text: string | null; created_at: string };
type Aix = { conversation_id: string; aix_type: string | null; created_at: string };
const norm = (s: string) => s.replace(/\s+/g, " ").trim();
const pct = (a: number, b: number) => (b === 0 ? "—" : `${((a / b) * 100).toFixed(1)}%`);
const WON = new Set(["closed_won", "contract", "approved", "screening", "applying"]);

async function page<T>(table: string, cols: string, since: string): Promise<T[]> {
  const out: T[] = [];
  for (let p = 0; p < 80; p++) {
    const { data, error } = await sb.from(table).select(cols).gte("created_at", since).order("created_at").range(p * 1000, p * 1000 + 999);
    if (error) { console.error(`${table}: ${error.message}`); break; }
    const r = (data ?? []) as T[]; out.push(...r); if (r.length < 1000) break;
  }
  return out;
}

async function main() {
  const days = Number(process.env.DAYS ?? 180);
  const SHOW = Number(process.env.SHOW ?? 6);
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const msgs = await page<Msg>("messages", "conversation_id, sender, text, created_at", since);
  const aix = await page<Aix>("aix_usage_logs", "conversation_id, aix_type, created_at", since);
  const { data: convData } = await sb.from("conversations").select("id, status").limit(5000);
  const statusOf = new Map(((convData ?? []) as Array<{ id: string; status: string | null }>).map((c) => [c.id, (c.status ?? "").trim()]));
  console.log(`直近${days}日: メッセージ ${msgs.length}通 ／ AIX ${aix.length}件\n`);

  const byConv = new Map<string, Msg[]>();
  for (const m of msgs) { if (!byConv.has(m.conversation_id)) byConv.set(m.conversation_id, []); byConv.get(m.conversation_id)!.push(m); }

  /** 押下ごとに「直前のお客様の発言」と「押した後のお客様の反応」を作る */
  type Row = { type: string; conv: string; won: boolean; before: string; after: string; beforeH: number | null };
  const rows: Row[] = [];
  for (const a of aix) {
    const t = Date.parse(a.created_at);
    const seq = byConv.get(a.conversation_id) ?? [];
    const before = [...seq].reverse().find((m) => m.sender === "customer" && Date.parse(m.created_at) < t);
    const after = seq.find((m) => m.sender === "customer" && Date.parse(m.created_at) > t);
    if (!before) continue;
    rows.push({
      type: a.aix_type ?? "?", conv: a.conversation_id, won: WON.has(statusOf.get(a.conversation_id) ?? ""),
      before: norm(before.text ?? ""), after: norm(after?.text ?? ""),
      beforeH: (t - Date.parse(before.created_at)) / 3600_000,
    });
  }
  console.log(`直前のお客様の発言がある押下 ${rows.length}件\n`);

  const types = [...new Set(rows.map((r) => r.type))]
    .sort((a, b) => rows.filter((r) => r.type === b).length - rows.filter((r) => r.type === a).length);

  for (const ty of types) {
    const xs = rows.filter((r) => r.type === ty);
    if (xs.length < 10) continue;
    const wonN = xs.filter((r) => r.won).length;
    const hrs = xs.map((r) => r.beforeH ?? 0).sort((x, y) => x - y);
    console.log(`\n${"═".repeat(72)}`);
    console.log(`■ ${ty}（${xs.length}件 ／ 成約側の会話 ${pct(wonN, xs.length)} ／ お客様の発言から押すまで中央値 ${(hrs[Math.floor(hrs.length / 2)] ?? 0).toFixed(1)}時間）`);
    // 直前の発言を短い順に並べると型が見える（長文は条件フォームなど）
    const short = xs.filter((r) => r.before.length <= 60).map((r) => r.before);
    const long = xs.filter((r) => r.before.length > 60).map((r) => r.before);
    console.log(`  直前のお客様の発言: 短い(60字以下) ${short.length}件 ／ 長い ${long.length}件`);
    console.log(`  【押す直前にお客様が言っていたこと（実物）】`);
    for (const s of short.slice(0, SHOW)) console.log(`    ・${s.slice(0, 70)}`);
    if (long.length) console.log(`    ・（長文）${long[0].slice(0, 70)}…`);
    const afters = xs.map((r) => r.after).filter(Boolean);
    if (afters.length) {
      console.log(`  【押した後にお客様が返したこと（実物・${afters.length}件）】`);
      for (const s of afters.slice(0, 3)) console.log(`    ・${s.slice(0, 70)}`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
