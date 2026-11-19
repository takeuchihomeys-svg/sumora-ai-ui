// app/lib/ask-progress-server.ts — 送り済み・残りの書き戻し（継ぎ目②）。返信・AIX の送信の後に、要件の帳面（last_brain_meta.ask_ledger）に対して
//   送った通と答えた／約束した／残りの要件を conversations.ask_progress に書く（作業員M・2026-11-15・統括役の決定）。
//   11/19 から既定 on（書くだけ・止める ASK_PROGRESS=off）。帳面（meta.ask_ledger）が無い番は何もしない。失敗しても送信は止めない（警告だけ）。last_brain_meta には書かない（ブレイン・log-aix-usage と上書きしあわない）
import type { SupabaseClient } from "@supabase/supabase-js";
import { askProgressOn, askLedgerOf, nextAskProgress, type SentMove } from "./ask-ledger";

export async function recordAskProgress(db: SupabaseClient, conversationId: string | null | undefined, move: SentMove): Promise<void> {
  if (!askProgressOn() || !conversationId) return;
  try {
    const { data, error } = await db.from("conversations").select("last_brain_meta, ask_progress").eq("id", conversationId).maybeSingle();
    if (error || !data) return;
    const row = data as { last_brain_meta?: unknown; ask_progress?: unknown };
    const rec = nextAskProgress(askLedgerOf(row.last_brain_meta), row.ask_progress, move, new Date().toISOString());
    if (!rec) return;
    const { error: e2 } = await db.from("conversations").update({ ask_progress: rec }).eq("id", conversationId);
    if (e2) console.warn(JSON.stringify({ tag: "ask-progress:write-failed", conversationId, error: e2.message }));
    else if (rec.offPlan) console.log(JSON.stringify({ tag: "ask-progress:off-plan", conversationId, offPlan: rec.offPlan }));
  } catch (e) {
    console.warn(JSON.stringify({ tag: "ask-progress:failed", conversationId, error: e instanceof Error ? e.message : String(e) }));
  }
}
