// app/lib/conductor-turn-vectors-server.ts — 近い過去の番の表（conductor_turn_vectors）を夜に埋める（⑤(a)・作業員1・11/04・既定 off）
//   竹内さん本人の送信（messages.staff_writer='takeuchi'）から、お客様の発言への一手だけを番にする（replay-build と同じ作り・申込の書類の手前まで）。
//   伏せ: compose-name-mask（その会話のお客様の表示名）＋maskPII。埋め込みは knowledge-utils.generateEmbedding（1536次元）。
//   CONDUCTOR_TURN_VECTORS=on かつ apply の時だけ表に書く（表は竹内さんの了承の後に作る）。それ以外は作れる行の数だけ数えて返す（埋め込みも呼ばない＝費用 0）。
//   1晩の上限 limit（既定 200）・同じ source_key は作り直さない・夜だけ（呼ぶ側の cron）
import type { SupabaseClient } from "@supabase/supabase-js";
import { isTestConversation } from "@/app/lib/test-conversations";
import { maskPII } from "@/app/lib/pii-mask";
import { customerNameTokens, maskCustomerNames } from "@/app/lib/compose-name-mask";
import { textFingerprint } from "@/app/lib/brain-judge-examples";
import { APPLY_DOCS_RE, actualOf, hitsOf, turnVectorRow, conductorTurnVectorsOn, type TurnVectorRow } from "@/app/lib/conductor-turn-vectors";

type Msg = { id: string; conversation_id: string; sender: string; text: string | null; created_at: string; is_aix_generated: boolean | null; line_message_id: string | null; staff_writer: string | null; staff_writer_confidence: string | null };
const COLS = "id, conversation_id, sender, text, created_at, is_aix_generated, line_message_id, staff_writer, staff_writer_confidence";

export type FillResult = { candidates: number; built: number; skippedExisting: number; skippedApplyDocs: number; written: number; dry: boolean; samples?: string[] };

export async function fillConductorTurnVectors(sb: SupabaseClient, o: { days?: number; limit?: number; apply?: boolean; samples?: number } = {}): Promise<FillResult> {
  const days = Math.min(120, Math.max(7, o.days ?? 90)), limit = Math.min(400, Math.max(10, o.limit ?? 200));
  const write = !!o.apply && conductorTurnVectorsOn();
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const { data: tk, error } = await sb.from("messages").select(COLS).eq("staff_writer", "takeuchi").eq("staff_writer_confidence", "sure").neq("sender", "customer")
    .gte("created_at", since).order("created_at", { ascending: false }).limit(limit * 4);
  if (error) throw new Error(`messages: ${error.message}`);
  const sends = ((tk ?? []) as Msg[]).filter((m) => !isTestConversation(m.conversation_id));
  // 表がある時だけ、もう入っている番を外す（dry は表が無くても動く）
  let existing = new Set<string>();
  if (write) {
    const keys = sends.map((s) => `msg:${s.id}`);
    for (let i = 0; i < keys.length; i += 200) {
      const { data } = await sb.from("conductor_turn_vectors").select("source_key").in("source_key", keys.slice(i, i + 200));
      for (const r of (data ?? []) as Array<{ source_key: string }>) existing.add(r.source_key);
    }
  }
  const res: FillResult = { candidates: sends.length, built: 0, skippedExisting: 0, skippedApplyDocs: 0, written: 0, dry: !write };
  const rows: Array<TurnVectorRow & { embedding: number[] }> = [];
  const seen = new Set<string>();
  const { generateEmbedding } = await import("@/app/lib/knowledge-utils");
  for (const s of sends) {
    if (res.built >= limit) break;
    if (existing.has(`msg:${s.id}`)) { res.skippedExisting++; continue; }
    const { data: prev } = await sb.from("messages").select(COLS).eq("conversation_id", s.conversation_id).lt("created_at", s.created_at).order("created_at", { ascending: false }).limit(12);
    const pv = (prev ?? []) as Msg[];
    if (!pv.length || pv[0].sender !== "customer") continue; // お客様の発言への一手だけ
    const turn: Msg[] = []; for (const m of pv) { if (m.sender !== "customer") break; turn.push(m); }
    const turnAt = turn[turn.length - 1]?.created_at ?? s.created_at;
    const key = `${s.conversation_id}|${turnAt}`;
    if (seen.has(key)) continue; seen.add(key);
    if (APPLY_DOCS_RE.test([...pv.map((m) => m.text ?? ""), s.text ?? ""].join("\n"))) { res.skippedApplyDocs++; continue; }
    const { data: conv } = await sb.from("conversations").select("customer_name, property_customer_id, status").eq("id", s.conversation_id).maybeSingle();
    const c = (conv ?? {}) as { customer_name?: string | null; property_customer_id?: string | null; status?: string | null };
    const tokens = customerNameTokens([c.customer_name ?? null]);
    const mask = (t: string) => maskPII(maskCustomerNames(t, tokens));
    const custText = [...turn].reverse().map((m) => m.text ?? "").join("\n");
    // こちらの一手（AIX の種類・ピッカー）
    let aixType: string | null = null, checkPattern: string | null = null;
    if (s.is_aix_generated && s.line_message_id) {
      const { data: al } = await sb.from("aix_usage_logs").select("aix_type, check_pattern").eq("line_message_id", s.line_message_id).limit(1).maybeSingle();
      aixType = (al as { aix_type?: string } | null)?.aix_type ?? "aix_unknown"; checkPattern = (al as { check_pattern?: string | null } | null)?.check_pattern ?? null;
    }
    // 直前のこちらの送信の種類
    const last = pv.find((m) => m.sender !== "customer" && (m.text ?? "").trim());
    let lastKind: string | null = null;
    if (last) {
      if (last.is_aix_generated && last.line_message_id) {
        const { data: la } = await sb.from("aix_usage_logs").select("aix_type").eq("line_message_id", last.line_message_id).limit(1).maybeSingle();
        lastKind = `AIX:${(la as { aix_type?: string } | null)?.aix_type ?? "aix_unknown"}`;
      } else lastKind = "返信";
    }
    // 見張りの番（場面・ブレインの答え）があれば当たりも
    const { data: w } = await sb.from("line_watch_turns").select("scene_key, brain_reply_mode, brain_action, conv_status").eq("conversation_id", s.conversation_id).eq("customer_turn_at", turnAt).maybeSingle();
    const wt = (w ?? null) as { scene_key: string | null; brain_reply_mode: string | null; brain_action: string | null; conv_status: string | null } | null;
    const actual = actualOf({ isAix: !!s.is_aix_generated, aixType, checkPattern });
    const row = turnVectorRow({
      sendId: s.id, conversationId: s.conversation_id, propertyCustomerId: c.property_customer_id ?? null,
      scene: wt?.scene_key ?? null, stage: wt?.conv_status ?? c.status ?? null, customerMasked: mask(custText), lastStaffKind: lastKind,
      fp: turn.map((m) => textFingerprint(m.text ?? "")).filter((x): x is string => !!x), actual, hits: hitsOf(actual, wt ? { brainMode: wt.brain_reply_mode, brainAction: wt.brain_action } : null),
      writer: s.staff_writer, turnAt,
    });
    res.built++;
    // 手元の確かめだけ: 伏せの効いた状況の文を数行（cron は渡さない＝返さない）
    if (o.samples && (res.samples ??= []).length < o.samples) res.samples.push(row.situation);
    if (!write) continue; // dry: 埋め込みを呼ばない（費用 0）
    const emb = await generateEmbedding(row.situation);
    if (!emb) continue;
    rows.push({ ...row, embedding: emb });
    if (rows.length >= 50) { await flush(sb, rows.splice(0)); res.written += 50; }
  }
  if (write && rows.length) { const n = rows.length; await flush(sb, rows.splice(0)); res.written += n; }
  return res;
}

async function flush(sb: SupabaseClient, rows: Array<TurnVectorRow & { embedding: number[] }>): Promise<void> {
  const { error } = await sb.from("conductor_turn_vectors").upsert(rows.map((r) => ({ ...r, embedding: JSON.stringify(r.embedding) })), { onConflict: "source_key" });
  if (error) throw new Error(`conductor_turn_vectors: ${error.message}`);
}
