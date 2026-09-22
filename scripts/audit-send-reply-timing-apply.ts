// 足した【送信と返信のバランス】を実物の会話に当てて、出る文を目で読む（読み取りのみ・全件監査）
// 2026-09-23 竹内「返信したのとAIXも掛け合わせたらより鮮明になる」
//
// 設計知見「監査で止める」「件数だけ見ない・目で読む」。見るのは3つ:
//   ① 何会話で出るか・何文字増えるか
//   ② 出る種類の内訳（実測の分布と合っているか＝当てはめを間違えていないか）
//   ③ 実物を目で読む（言い過ぎ・断定・個人情報が無いか）
//
// 実行: npx tsx --env-file=.env.local scripts/audit-send-reply-timing-apply.ts [SHOW=12]
import { createClient } from "@supabase/supabase-js";
import { buildSendReplyTimingNote } from "../app/lib/send-reply-timing";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
type Msg = { conversation_id: string; sender: string | null; text: string | null; created_at: string };
type Aix = { conversation_id: string; aix_type: string | null; created_at: string };
const pct = (a: number, b: number) => (b === 0 ? "—" : `${((a / b) * 100).toFixed(1)}%`);
const med = (a: number[]) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)] ?? 0;

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
  const SHOW = Number(process.env.SHOW ?? 12);
  const since = new Date(Date.now() - 60 * 86400_000).toISOString();
  const msgs = await page<Msg>("messages", "conversation_id, sender, text, created_at", since);
  const aix = await page<Aix>("aix_usage_logs", "conversation_id, aix_type, created_at", since);
  const byConv = new Map<string, Msg[]>();
  for (const m of msgs) { if (!byConv.has(m.conversation_id)) byConv.set(m.conversation_id, []); byConv.get(m.conversation_id)!.push(m); }
  const aixBy = new Map<string, Aix[]>();
  for (const a of aix) { if (!aixBy.has(a.conversation_id)) aixBy.set(a.conversation_id, []); aixBy.get(a.conversation_id)!.push(a); }
  console.log(`直近60日: 会話 ${byConv.size}件\n`);

  let withNote = 0, waiting = 0, replied = 0, overBalance = 0;
  const lens: number[] = [];
  const kinds = new Map<string, number>();
  const samples: Array<{ conv: string; note: string }> = [];
  for (const [conv, list] of byConv) {
    const seq = list.filter((m) => (m.text ?? "").trim());
    if (seq.length < 2) continue;
    // ⚠ ブレインが走るのはほとんど**お客様が返信した瞬間**。最後のメッセージの時刻を「今」にすると
    //   経過0分ばかりになって監査にならないので、最後のお客様の発言の時点を「今」にする（本番と同じ形）。
    const lastCust = [...seq].reverse().find((m) => m.sender === "customer");
    const now = Date.parse(lastCust?.created_at ?? seq[seq.length - 1].created_at);
    // その時点より前のこちらの送信を見る
    const before = seq.filter((m) => Date.parse(m.created_at) <= now);
    const lastStaff = [...before].reverse().find((m) => m.sender !== "customer");
    const lastStaffAt = lastStaff?.created_at ?? null;
    const aixType = lastStaffAt
      ? (aixBy.get(conv) ?? []).find((a) => Math.abs(Date.parse(a.created_at) - Date.parse(lastStaffAt)) <= 3 * 60_000)?.aix_type ?? null
      : null;
    const note = buildSendReplyTimingNote({
      lastStaffAt, lastStaffAixType: aixType,
      customerRepliedAfter: true,                       // この時点でお客様が返した＝本番の webhook 経路と同じ
      customerRepliedAt: lastCust?.created_at ?? null,
      staffCount: before.filter((m) => m.sender !== "customer").length,
      customerCount: before.filter((m) => m.sender === "customer").length,
      now,
    });
    if (!note) continue;
    withNote++; lens.push(note.length);
    if (note.includes("後に返信した")) { waiting++; kinds.set(aixType ?? "手打ち", (kinds.get(aixType ?? "手打ち") ?? 0) + 1); }
    if (note.includes("反応待ちではない")) replied++;
    if (note.includes("こちらが多く送っている側")) overBalance++;
    samples.push({ conv: conv.slice(0, 8), note });
  }
  console.log(`① 出る会話 ${withNote}件 ／ 1回あたり ${med(lens)}字（約${Math.round(med(lens) / 2.2)}トークン）`);
  console.log(`   内訳: 返信の速さが出た ${waiting}（${pct(waiting, withNote)}）／ 返事あり ${replied}（${pct(replied, withNote)}）／ こちらが多く送っている ${overBalance}（${pct(overBalance, withNote)}）`);
  console.log(`\n② 返信待ちの時の送信の種類`);
  for (const [k, n] of [...kinds].sort((a, b) => b[1] - a[1])) console.log(`   ${String(k).padEnd(26)} ${n}件`);

  console.log(`\n③ 実物（${SHOW}件・言い過ぎ／断定／個人情報が無いか目で読む）`);
  for (const s of samples.slice(0, SHOW)) {
    console.log(`\n   ── ${s.conv}`);
    for (const l of s.note.split("\n").filter((x) => x.trim())) console.log(`   ${l}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
