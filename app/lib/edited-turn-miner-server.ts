// app/lib/edited-turn-miner-server.ts（サーバー専用・DB を読むだけ・LLM なし・$0）
// 大きく直された番を拾う DB 側。決まりは app/lib/edited-turn-miner.ts（純関数）。
//   読む物: line_watch_turns（返信の番の下書き・返事のまとまりの手打ち・押した AIX・書き手）／messages（お客様の発言・引用の判定の材料・AIX の送信の書き手）／
//           ai_reply_examples（entry_source='aix_action' の ai_draft↔sent_reply）
//   書く物: なし（毎日の見張り /api/cron/line-watch-daily が cron_run_logs の edited-turn-miner に数だけ残す・手で回す scripts/edited-turn-miner.ts は手元の置き場）
//   外す物: テストの会話・申込以降（isPostApplyStatus）・判定が閉じていない番（verdict null）
import type { SupabaseClient } from "@supabase/supabase-js";
import { mineReplyTurn, mineAixExample, staffValuesOf, type MinedTurn } from "@/app/lib/edited-turn-miner";
import { pickJudgeDraft, cleanDraft, staffFactsOf } from "@/app/lib/line-watch-judge";
import { findStaffOnlyFact } from "@/app/lib/staff-confirm-facts";
import { resolveReplyScene, REPLY_SCENE_JA } from "@/app/lib/reply-scene";
import { isTestConversation } from "@/app/lib/test-conversations";
import { isPostApplyStatus } from "@/app/lib/llm-alt-provider";

const DAY = 86_400_000;
type Row = Record<string, unknown>;
type TurnRow = {
  id: number; conversation_id: string; customer_turn_at: string; customer_last_at: string | null; conv_status: string | null;
  draft_first: string | null; draft_first_at: string | null; draft_last: string | null; draft_versions: number | null;
  staff_texts: Array<{ at?: string; text?: string; burst?: boolean }> | null; staff_aix: Array<{ aix_type?: string | null; burst?: boolean }> | null;
  verdict: string | null; verdict_detail: Row | null;
};
type Msg = { conversation_id: string; sender: string; text: string | null; created_at: string; is_aix_generated: boolean | null; staff_writer: string | null };
type Ex = { conversation_id: string | null; sent_at: string | null; created_at: string; aix_action: string | null; ai_draft: string | null; sent_reply: string | null; customer_message: string | null };

async function readAll<T>(q: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>, max = 40_000): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < max; i += 1000) {
    const r = await q(i, i + 999);
    if (r.error) throw new Error(r.error.message);
    const d = (r.data ?? []) as T[];
    out.push(...d);
    if (d.length < 1000) break;
  }
  return out;
}
const chunks = <T,>(a: T[], n: number): T[][] => { const out: T[][] = []; for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n)); return out; };
const ms = (s: string | null | undefined) => (s ? Date.parse(s) : NaN);

export type MinedReport = {
  ok: boolean; since: string; until: string;
  /** 比べた組の数（返信の番＝下書きと手打ち／AIX＝生成文と実送信） */
  pairs: { reply: number; aix: number };
  /** 外した番（申込以降・テスト） */
  skipped: { postApply: number; test: number };
  turns: MinedTurn[];
  /** 会話の名前（試験の伏せに使う・外に出さない） */
  names: Record<string, string | null>;
  errors: string[];
};

/** [sinceMs, untilMs) の番を読んで、大きく直された番を拾う */
export async function mineEditedTurns(sb: SupabaseClient, o: { sinceMs: number; untilMs: number; aix?: boolean }): Promise<MinedReport> {
  const since = new Date(o.sinceMs).toISOString(), until = new Date(o.untilMs).toISOString();
  const errors: string[] = [];
  const skipped = { postApply: 0, test: 0 };
  const turns: MinedTurn[] = [];
  const names: Record<string, string | null> = {};
  let replyPairs = 0, aixPairs = 0;

  // ── 返信の番（line_watch_turns）
  let rows: TurnRow[] = [];
  try {
    rows = await readAll<TurnRow>((f, t) => sb.from("line_watch_turns")
      .select("id, conversation_id, customer_turn_at, customer_last_at, conv_status, draft_first, draft_first_at, draft_last, draft_versions, staff_texts, staff_aix, verdict, verdict_detail")
      .gte("customer_turn_at", since).lt("customer_turn_at", until).not("verdict", "is", null).order("customer_turn_at").order("id").range(f, t));
  } catch (e) { errors.push(`line_watch_turns: ${e instanceof Error ? e.message : String(e)}`); }
  rows = rows.filter((r) => { if (isTestConversation(r.conversation_id)) { skipped.test++; return false; } if (isPostApplyStatus(r.conv_status)) { skipped.postApply++; return false; } return true; });

  // ── AIX の生成文と実送信
  let exs: Ex[] = [];
  if (o.aix !== false) {
    try {
      exs = await readAll<Ex>((f, t) => sb.from("ai_reply_examples").select("conversation_id, sent_at, created_at, aix_action, ai_draft, sent_reply, customer_message")
        .eq("entry_source", "aix_action").not("ai_draft", "is", null).gte("created_at", since).lt("created_at", until).order("created_at").range(f, t));
    } catch (e) { errors.push(`ai_reply_examples: ${e instanceof Error ? e.message : String(e)}`); }
    exs = exs.filter((x) => { if (!x.conversation_id || isTestConversation(x.conversation_id)) { skipped.test++; return false; } return true; });
  }

  const convIds = [...new Set([...rows.map((r) => r.conversation_id), ...exs.map((x) => x.conversation_id as string)])];
  const msgs = new Map<string, Msg[]>();
  const status = new Map<string, string | null>();
  const msgSince = new Date(o.sinceMs - 3 * DAY).toISOString();
  for (const ids of chunks(convIds, 40)) {
    try {
      const [m, c] = await Promise.all([
        readAll<Msg>((f, t) => sb.from("messages").select("conversation_id, sender, text, created_at, is_aix_generated, staff_writer").in("conversation_id", ids).gte("created_at", msgSince).lt("created_at", new Date(o.untilMs + DAY).toISOString()).order("conversation_id").order("created_at").range(f, t)),
        sb.from("conversations").select("id, customer_name, status").in("id", ids),
      ]);
      for (const x of m) { const a = msgs.get(x.conversation_id) ?? []; a.push(x); msgs.set(x.conversation_id, a); }
      if (c.error) errors.push(`conversations: ${c.error.message}`);
      for (const x of (c.data ?? []) as Array<{ id: string; customer_name: string | null; status: string | null }>) { names[x.id] = x.customer_name; status.set(x.id, x.status); }
    } catch (e) { errors.push(`messages: ${e instanceof Error ? e.message : String(e)}`); }
  }

  for (const r of rows) {
    // 2026-10-16 確かめる人: 番の時は申込前でも、今は申込以降の会話は外す（AIX の例と同じく今の状態で見る＝DeepSeek に出す前の止めと揃える。14日で6番）
    if (isPostApplyStatus(status.get(r.conversation_id) ?? null)) { skipped.postApply++; continue; }
    const picked = pickJudgeDraft(r);
    const draft = picked.src === "last" || picked.src === "first" ? cleanDraft(picked.draft).text : null;
    if (!draft) continue;
    const burst = (r.staff_texts ?? []).filter((x) => x.burst !== false && (x.text ?? "").trim());
    const sent = burst.map((x) => String(x.text ?? "")).join("\n").trim();
    const pressed = (r.staff_aix ?? []).filter((x) => x.burst !== false && x.aix_type).map((x) => String(x.aix_type));
    if (!sent && !pressed.length) continue;
    replyPairs++;
    const list = msgs.get(r.conversation_id) ?? [];
    const lastAt = ms(r.customer_last_at ?? r.customer_turn_at);
    const customer = list.filter((m) => m.sender === "customer" && ms(m.created_at) >= ms(r.customer_turn_at) - 1000 && ms(m.created_at) <= lastAt + 1000).map((m) => m.text ?? "").join("\n");
    const ground = list.filter((m) => ms(m.created_at) <= lastAt + 1000).map((m) => m.text ?? "").join("\n");
    const d = (r.verdict_detail ?? {}) as { staff_writer?: string | null; reason?: string };
    // 人しか知らない事（引用でない・下書きに同じ型が無い物）
    const human = new Set<string>();
    if (sent) {
      const draftFacts = new Set(staffFactsOf(draft, ground).map((f) => f.kind));
      for (const f of staffFactsOf(sent, ground)) if (!draftFacts.has(f.kind)) human.add(f.kind);
      const sf = findStaffOnlyFact(sent), df = findStaffOnlyFact(draft);
      if (sf && sf.kind !== df?.kind && sf.kind !== "phone_call_promise") human.add(sf.kind);
      for (const v of staffValuesOf(draft, sent, ground)) human.add(v);
      if (d.reason === "text_but_staff_fact" && !human.size) human.add("check_reported");
    }
    const scene = resolveReplyScene({ customerText: customer }).scene;
    const t = mineReplyTurn({
      conv: r.conversation_id, at: r.customer_last_at ?? r.customer_turn_at, scene, sceneJa: REPLY_SCENE_JA[scene], writer: d.staff_writer ?? null,
      customer, draft, sent, pressed, humanKinds: [...human],
    });
    if (t) turns.push(t);
  }

  for (const x of exs) {
    const cid = x.conversation_id as string;
    if (isPostApplyStatus(status.get(cid) ?? null)) { skipped.postApply++; continue; }
    aixPairs++;
    const at = x.sent_at ?? x.created_at;
    // 書き手: 送った時刻 ±3分の AIX の文（staff_writer）
    const list = msgs.get(cid) ?? [];
    // 番までの会話（スタッフが入れた値が会話に既にあったかを見る）
    const ground = [x.customer_message ?? "", ...list.filter((m) => ms(m.created_at) < ms(at) - 5_000).map((m) => m.text ?? "")].join("\n");
    const w = list.find((m) => m.sender !== "customer" && m.is_aix_generated && Math.abs(ms(m.created_at) - ms(at)) <= 3 * 60_000)?.staff_writer ?? null;
    const t = mineAixExample({ conv: cid, at, aixAction: String(x.aix_action ?? ""), writer: w, customer: x.customer_message ?? "", draft: x.ai_draft ?? "", sent: x.sent_reply ?? "", ground });
    if (t) turns.push(t);
  }
  return { ok: errors.length === 0, since, until, pairs: { reply: replyPairs, aix: aixPairs }, skipped, turns, names, errors };
}
