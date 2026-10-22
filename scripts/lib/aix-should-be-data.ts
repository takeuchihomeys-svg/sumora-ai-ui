// scripts/lib/aix-should-be-data.ts — 「本来の AIX」当てはめの検証用に DB を読むだけ（書かない・送らない・LLM なし）
//   竹内さんの AIX の送信（ラベル＝押したボタン×ピッカー）と、スタッフ・竹内さんの手打ちの送信（AIX でない）を読む
import type { SupabaseClient } from "@supabase/supabase-js";
import { catalogKeyOfPress } from "../../app/lib/aix-catalog";
import { isTestConversation } from "../../app/lib/test-conversations";

export type OwnerAixSend = { id: string; conv: string; at: string; key: string; source: string; text: string; writer: string };
export type HandTyped = { conv: string; at: string; text: string; writer: string; ground: string };

const P = (s: string) => Date.parse(s);

async function pageAll<T>(sb: SupabaseClient, table: string, cols: string, apply: (q: any) => any): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await apply(sb.from(table).select(cols)).order("created_at", { ascending: true }).range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < 1000) break;
  }
  return out;
}

type Usage = { id: string; conversation_id: string; aix_type: string | null; check_pattern: string | null; send_mode: string | null; app_sub_mode: string | null; picker_choices: unknown; generated_text: string | null; line_message_id: string | null; created_at: string };
type Msg = { conversation_id: string; sender: string; text: string | null; created_at: string; line_message_id: string | null; is_aix_generated: boolean | null; staff_writer: string | null; staff_writer_confidence: string | null };

/** 読む: AIX の押下（全期間）と、その期間のメッセージ */
export async function loadShouldBeData(sb: SupabaseClient, o: { sinceDays?: number } = {}): Promise<{ owner: OwnerAixSend[]; staffAix: OwnerAixSend[]; hand: HandTyped[] }> {
  const since = new Date(Date.now() - (o.sinceDays ?? 150) * 86_400_000).toISOString();
  const usages = (await pageAll<Usage>(sb, "aix_usage_logs", "id, conversation_id, aix_type, check_pattern, send_mode, app_sub_mode, picker_choices, generated_text, line_message_id, created_at", (q) => q.gte("created_at", since).not("aix_type", "is", null)))
    .filter((u) => !isTestConversation(u.conversation_id));
  const msgs = (await pageAll<Msg>(sb, "messages", "conversation_id, sender, text, created_at, line_message_id, is_aix_generated, staff_writer, staff_writer_confidence", (q) => q.gte("created_at", since)))
    .filter((m) => !isTestConversation(m.conversation_id));
  const byLm = new Map<string, Msg>();
  const byConv = new Map<string, Msg[]>();
  for (const m of msgs) { if (m.line_message_id) byLm.set(m.line_message_id, m); (byConv.get(m.conversation_id) ?? byConv.set(m.conversation_id, []).get(m.conversation_id)!).push(m); }
  const writerOf = (m: Msg | undefined) => (m?.staff_writer === "takeuchi" && m.staff_writer_confidence === "sure" ? "takeuchi" : m?.staff_writer === "employee" ? "employee" : m?.staff_writer ? `${m.staff_writer}?` : "unknown");
  const owner: OwnerAixSend[] = [], staffAix: OwnerAixSend[] = [];
  for (const u of usages) {
    const m = u.line_message_id ? byLm.get(u.line_message_id) : undefined;
    const text = (u.generated_text ?? m?.text ?? "").trim();
    if (!text) continue;
    const pk = catalogKeyOfPress({ aix_type: u.aix_type, check_pattern: u.check_pattern, send_mode: u.send_mode, app_sub_mode: u.app_sub_mode, picker_choices: u.picker_choices, text });
    const row = { id: u.id, conv: u.conversation_id, at: u.created_at, key: pk.key, source: pk.source, text, writer: writerOf(m) };
    (row.writer === "takeuchi" ? owner : staffAix).push(row);
  }
  const pressedLms = new Set(usages.map((u) => u.line_message_id).filter(Boolean) as string[]);
  const hand: HandTyped[] = [];
  for (const [conv, list] of byConv) {
    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      if (m.sender === "customer" || m.is_aix_generated || (m.line_message_id && pressedLms.has(m.line_message_id)) || !(m.text ?? "").trim()) continue;
      const ground = list.slice(0, i).filter((x) => P(x.created_at) > P(m.created_at) - 4 * 86_400_000).map((x) => x.text ?? "").join("\n");
      hand.push({ conv, at: m.created_at, text: String(m.text), writer: writerOf(m), ground });
    }
  }
  return { owner, staffAix, hand };
}
