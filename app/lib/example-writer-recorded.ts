// app/lib/example-writer-recorded.ts — 返信の手本（ai_reply_examples）の書き手を、文の書き方の推定でなく送信の記録（messages.staff_writer）で決める
//   2026-11-15 作業員I（竹内さん 11/15「ちゃんと竹内の LINE から学習する」・頼み5「手本と近い番を引く所が竹内さんの番を先に引く作りか」）。
//   今: 手本の並べ替えは writerFromText（文の書き方の推定）で 竹内 +0.12／従業員 −0.12（EXAMPLE_WRITER_BOOST・既定 on）。
//       ai_reply_examples に書き手の列は無く、送信の記録（messages.staff_writer・確か sure）は使っていない。近い番（match_conductor_focus）は p_writer='takeuchi' の既定で竹内さんだけ＝直す所なし。
//   ここ: EXAMPLE_WRITER_RECORDED=on の時だけ、手本の送った時刻の前後5分の、同じ会話のこちらの手打ちの送信の書き手（sure）を先に使い、無ければ今まで通り文の推定（既定 off）
// テスト: app/lib/__tests__/example-writer-recorded.test.ts
import { writerFromText } from "./staff-writer";

type Env = Record<string, string | undefined>;
export function exampleWriterRecordedOn(env: Env = typeof process !== "undefined" ? process.env : {}): boolean {
  // 2026-11-21 作業員G: 既定 on（②の組 grp-reply-1121 で確かな悪化0）。止める EXAMPLE_WRITER_RECORDED=off
  return (env.EXAMPLE_WRITER_RECORDED ?? "").trim().toLowerCase() !== "off";
}
export type RecordedWriter = "takeuchi" | "employee";
/** 並べ替えの足し: 記録の書き手があればそれで（竹内 +0.12・従業員 −0.12）、無ければ文の推定（今と同じ値） */
export function writerBoostOf(recorded: RecordedWriter | null | undefined, sentReply: string | null | undefined, env: Env = typeof process !== "undefined" ? process.env : {}): number {
  if ((env.EXAMPLE_WRITER_BOOST ?? "").toLowerCase() === "off") return 0;
  const w = recorded ?? writerFromText(sentReply ?? "").writer;
  return w === "takeuchi" ? 0.12 : w === "employee" ? -0.12 : 0;
}
/** 手本の送った時刻に一番近い、同じ会話のこちらの手打ちの送信（前後 windowMs・確か sure）の書き手 */
export function nearestRecordedWriter(sentAtIso: string | null | undefined, msgs: ReadonlyArray<{ created_at: string; staff_writer: string | null; staff_writer_confidence: string | null; is_aix_generated?: boolean | null }>, windowMs = 5 * 60_000): RecordedWriter | null {
  const t = sentAtIso ? Date.parse(sentAtIso) : NaN;
  if (!Number.isFinite(t)) return null;
  let best: { d: number; w: RecordedWriter } | null = null;
  for (const m of msgs) {
    if (m.is_aix_generated || m.staff_writer_confidence !== "sure" || (m.staff_writer !== "takeuchi" && m.staff_writer !== "employee")) continue;
    const d = Math.abs(Date.parse(m.created_at) - t);
    if (d <= windowMs && (!best || d < best.d)) best = { d, w: m.staff_writer };
  }
  return best?.w ?? null;
}
type Sb = { from: (t: string) => any }; // eslint-disable-line @typescript-eslint/no-explicit-any
/** 手本の id → 記録の書き手（読めない時は空の Map＝今まで通り文の推定に落ちる） */
export async function loadRecordedWriters(sb: Sb, exampleIds: ReadonlyArray<string>): Promise<Map<string, RecordedWriter>> {
  const out = new Map<string, RecordedWriter>();
  const ids = [...new Set(exampleIds.filter(Boolean))].slice(0, 40);
  if (!ids.length) return out;
  try {
    const { data: ex } = await sb.from("ai_reply_examples").select("id, conversation_id, sent_at").in("id", ids);
    const rows = ((ex ?? []) as Array<{ id: string; conversation_id: string | null; sent_at: string | null }>).filter((r) => r.conversation_id && r.sent_at);
    await Promise.all(rows.map(async (r) => {
      const t = Date.parse(r.sent_at!);
      const { data: ms } = await sb.from("messages").select("created_at, staff_writer, staff_writer_confidence, is_aix_generated").eq("conversation_id", r.conversation_id!).eq("sender", "staff")
        .gte("created_at", new Date(t - 5 * 60_000).toISOString()).lte("created_at", new Date(t + 5 * 60_000).toISOString()).limit(20);
      const w = nearestRecordedWriter(r.sent_at, (ms ?? []) as never);
      if (w) out.set(r.id, w);
    }));
  } catch { /* 読めない時は文の推定のまま */ }
  return out;
}
