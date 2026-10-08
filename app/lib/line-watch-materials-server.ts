// app/lib/line-watch-materials-server.ts — 見張り（line_watch_turns.materials）に材料の要約・出さなかった下書きを書く所。
// 判断は line-watch-materials.ts（純関数）。ここは集めて、少し待ってまとめて1回書くだけ。失敗しても投げない（本処理を止めない）。
// 2026-10-08 竹内「大丈夫」（返信の質 8巡目・記録）。戻す: LINE_WATCH_MATERIALS=off
//   ・列 materials が本番に無い間は、最初の失敗で書くのをやめる（このインスタンスの間）
//   ・テストの起動（LLM_TEST_MODE / LLM_TEST_FINAL_CLAUDE）では書かない（再生の材料を今の番に混ぜない）
import { supabase } from "@/app/lib/supabase";
import {
  lineWatchMaterialsEnabled, summarizeMaterialLog, mergeWatchMaterials, openTurnKey, suppressedDraftSummary,
  type WatchSource, type MaterialSummary,
} from "@/app/lib/line-watch-materials";

type Pending = { source: WatchSource; key: string; summary: MaterialSummary; at: string };
const buffers = new Map<string, Pending[]>();
let columnMissing = false;
const FLUSH_DELAY_MS = 1500;

function writable(): boolean {
  if (columnMissing || !lineWatchMaterialsEnabled()) return false;
  if (process.env.LLM_TEST_MODE || process.env.LLM_TEST_FINAL_CLAUDE) return false;
  return true;
}

async function keepAlive(p: Promise<unknown>): Promise<void> {
  try { const m = await import("@vercel/functions"); m.waitUntil(p); } catch { /* Vercel 以外 */ }
}

async function flush(conversationId: string): Promise<void> {
  const items = buffers.get(conversationId) ?? [];
  buffers.delete(conversationId);
  if (items.length === 0 || !writable()) return;
  try {
    const { data: staff } = await supabase.from("messages").select("sender, created_at").eq("conversation_id", conversationId)
      .neq("sender", "customer").order("created_at", { ascending: false }).limit(1);
    let q = supabase.from("messages").select("sender, created_at").eq("conversation_id", conversationId).eq("sender", "customer");
    const lastStaff = (staff ?? [])[0] as { sender: string; created_at: string } | undefined;
    if (lastStaff) q = q.gt("created_at", lastStaff.created_at);
    const { data: cust } = await q.order("created_at", { ascending: true }).limit(1);
    const turn = openTurnKey([...(lastStaff ? [lastStaff] : []), ...((cust ?? []) as Array<{ sender: string; created_at: string }>)]);
    if (!turn) return;
    const { data: row, error: readErr } = await supabase.from("line_watch_turns").select("materials")
      .eq("conversation_id", conversationId).eq("customer_turn_at", turn).maybeSingle();
    if (readErr && /materials/.test(readErr.message)) { columnMissing = true; console.warn("[line-watch-materials] 列 materials が無いので書かない:", readErr.message); return; }
    const materials = mergeWatchMaterials((row as { materials?: unknown } | null)?.materials ?? null, items);
    const { error } = await supabase.from("line_watch_turns").upsert(
      { conversation_id: conversationId, customer_turn_at: turn, materials },
      { onConflict: "conversation_id,customer_turn_at" },
    );
    if (error) {
      if (/materials/.test(error.message)) columnMissing = true;
      console.warn("[line-watch-materials] write failed:", error.message);
      return;
    }
    console.log(JSON.stringify({ tag: "line-watch:materials", conversationId, turn, keys: items.map((i) => `${i.source}.${i.key}`) }));
  } catch (e) {
    console.warn("[line-watch-materials] failed:", e instanceof Error ? e.message : String(e));
  }
}

/** 材料の要約を1つ控える（少し待ってから同じ会話の分をまとめて書く） */
export function noteWatchMaterials(conversationId: string | null | undefined, source: WatchSource, key: string, summary: MaterialSummary): void {
  if (!conversationId || !writable()) return;
  const list = buffers.get(conversationId);
  const item = { source, key, summary, at: new Date().toISOString() };
  if (list) { list.push(item); return; }
  buffers.set(conversationId, [item]);
  void keepAlive(new Promise<void>((r) => setTimeout(r, FLUSH_DELAY_MS)).then(() => flush(conversationId)));
}

/**
 * 既存のログ（console.log(JSON.stringify({ tag, ... }))）の置き換え: 同じ1行をログに出し、知っている tag なら見張りにも要約を控える。
 *   conversationId がログの中に無い時は第2引数で渡す。第2引数が ""（空）の時はログだけ（見張りに控えない）。
 */
export function logWatchMaterial(json: string, conversationId?: string | null): void {
  console.log(json);
  try {
    if (conversationId === "" || !writable()) return;
    const obj = JSON.parse(json) as Record<string, unknown>;
    const s = summarizeMaterialLog(obj);
    if (!s) return;
    const conv = conversationId ?? (typeof obj.conversationId === "string" ? obj.conversationId : null);
    noteWatchMaterials(conv, s.source, s.key, s.summary);
  } catch { /* 控えは諦める */ }
}

/** 生成したが出さなかった下書き（直前の送信とほぼ同じ・返信でない文）を控える */
export function noteWatchSuppressedDraft(conversationId: string | null | undefined, text: string, reason: string): void {
  if (!text?.trim()) return;
  noteWatchMaterials(conversationId, "suppressed", "draft", suppressedDraftSummary(text, reason));
}
