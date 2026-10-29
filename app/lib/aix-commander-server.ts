// app/lib/aix-commander-server.ts — AIX の統括の呼び出し（札を DB から読み・LLM を1回呼ぶ・サーバー専用）
//
// 2026-10-29 作業員1（aix-commander.ts の説明を参照）。札の表 aix_desk_cards は RLS 有効・公開キーでは読めない（お客様の伏せた文が入る）
//   → サーバーの鍵（SUPABASE_SERVICE_ROLE_KEY）で作った client で読む（extension-snapshots-server と同じ形）。鍵が無い時（手元・試験）は札なし＝呼ばない（ログに理由を1行）。
//   札は 1時間だけ手元に置く（毎週作り直す動く材料・毎回は読まない）。LLM は安い型（Haiku・名札 aix_desk_command＝LLM_ALT_ACTIONS で DeepSeek に回せる）。
import type Anthropic from "@anthropic-ai/sdk";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { LLM_ACTION_HEADER, LLM_CONVERSATION_HEADER } from "./llm-usage-recorder";
import { logLlmUsage } from "./llm-usage-log";
import { AIX_COMMANDER_SYSTEM, commanderCandidates, commanderUserText, deskKeyOf, parseCommanderAnswer } from "./aix-commander";

export const AIX_DESK_ACTION = "aix_desk_command";
const MODEL = process.env.AIX_DESK_MODEL ?? "claude-haiku-4-5";
const CARD_TTL_MS = 3_600_000;

let _admin: SupabaseClient | null = null;
function admin(): { sb: SupabaseClient | null; error: string | null } {
  if (_admin) return { sb: _admin, error: null };
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return { sb: null, error: "SUPABASE_SERVICE_ROLE_KEY が無い（札の表はサーバーの鍵だけで読める）" };
  _admin = createClient(url, key, { auth: { persistSession: false } });
  return { sb: _admin, error: null };
}

let cache: { at: number; cards: Map<string, string> } | null = null;
/** 札（鍵→本文）。読めない時は空＋理由 */
export async function loadDeskCards(): Promise<{ cards: Map<string, string>; error: string | null }> {
  if (cache && Date.now() - cache.at < CARD_TTL_MS) return { cards: cache.cards, error: null };
  const { sb, error } = admin();
  if (!sb) {
    // 試験（手元・サーバーの鍵なし）だけ: AIX_DESK_CARDS_FILE（build-aix-desk-cards.ts の手元の写し cards.json）から読む。本番では置かない
    const file = process.env.AIX_DESK_CARDS_FILE;
    if (file && (process.env.LLM_TEST_MODE || process.env.LLM_TEST_FINAL_CLAUDE)) {
      try {
        const { readFileSync } = await import("node:fs");
        const j = JSON.parse(readFileSync(file, "utf8")) as { cards: Record<string, { text: string }> };
        const cards = new Map(Object.entries(j.cards).map(([k, v]) => [k, v.text]));
        cache = { at: Date.now(), cards };
        return { cards, error: null };
      } catch (e) { return { cards: new Map(), error: `AIX_DESK_CARDS_FILE: ${e instanceof Error ? e.message : e}` }; }
    }
    console.warn(JSON.stringify({ tag: "brain:aix-desk-cards", error }));
    return { cards: new Map(), error };
  }
  const { data, error: e } = await sb.from("aix_desk_cards").select("key, card_text");
  if (e) return { cards: new Map(), error: `aix_desk_cards: ${e.message}` };
  const cards = new Map(((data ?? []) as Array<{ key: string; card_text: string }>).map((r) => [r.key, r.card_text]));
  cache = { at: Date.now(), cards };
  return { cards, error: null };
}

export type CommanderRun = {
  ran: boolean;
  skip?: string;
  brainKey: string | null;
  cands: string[];
  pick: string | null;
  also: string[];
  sendBack: "promise" | "not_aix" | null;
  why: string;
  ms: number;
};

/** AIX の統括を1回呼ぶ（呼ぶ側で「ブレインが AIX と決めた番」だけにする） */
export async function runAixCommander(client: Anthropic, o: {
  conversationId: string; brainAction: string; brainCheckPattern: string | null; altActions: readonly string[];
  conversation: string; situationLine: string;
}): Promise<CommanderRun> {
  const t0 = Date.now();
  const base: CommanderRun = { ran: false, brainKey: null, cands: [], pick: null, also: [], sendBack: null, why: "", ms: 0 };
  const { cards, error } = await loadDeskCards();
  if (!cards.size) return { ...base, skip: error ?? "札が無い", ms: Date.now() - t0 };
  const keys = [...cards.keys()];
  const brainKey = deskKeyOf(o.brainAction, o.brainCheckPattern, keys);
  const cands = commanderCandidates(brainKey, o.altActions, keys);
  if (cands.length < 2) return { ...base, brainKey, cands, skip: "比べる候補が1つ以下", ms: Date.now() - t0 };
  const user = commanderUserText({ situationLine: o.situationLine, conversation: o.conversation, cards: cands.map((k) => ({ key: k, text: cards.get(k) ?? "" })) });
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 400,
    temperature: 0,
    system: [{ type: "text", text: AIX_COMMANDER_SYSTEM, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: user }],
  }, { headers: { [LLM_ACTION_HEADER]: AIX_DESK_ACTION, [LLM_CONVERSATION_HEADER]: o.conversationId } });
  logLlmUsage(AIX_DESK_ACTION, res.usage, { conversationId: o.conversationId, model: MODEL });
  const text = res.content.map((b) => (b.type === "text" ? b.text : "")).join("");
  let raw: unknown = null;
  try { raw = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)); } catch { raw = null; }
  const a = parseCommanderAnswer(raw, cands);
  return { ran: true, brainKey, cands, pick: a.pick, also: a.also, sendBack: a.sendBack, why: a.why, ms: Date.now() - t0 };
}
