// app/lib/customer-fact-ledger-server.ts — 事実の帳面（customer_fact_ledger）の保存（サーバーの鍵だけ）
//
// 2026-11-03 統括役の指示:
//   ・表は REVOKE（anon/authenticated から読めない）＝ brain-core の共通の client（公開キー）では書けない。サーバーの鍵（SUPABASE_SERVICE_ROLE_KEY）で作った client で書く
//     （aix-commander-server と同じ形）。鍵が無い時（手元の試験）は「帳面なし＝今まで通り」でログに1行。
//   ・書き込みはブレインの保存（analyzeAndSaveBrainMeta が判断を書けた時）と同じ時に1回の upsert だけ（前の読みはしない＝古い判断はブレインの保存の関所 brainWriteBlock が先に止めている）。
//   ・時間切れ（3秒）はその番は書かずに飛ばし、ログに1行。失敗しても返信は止めない（呼ぶ側は待たない）。
//   作った帳面はブレインの分析の中で作り（材料を組む時）、保存まで stashFactLedger で預かる（同じ会話の次の分析が来たら上書き＝最新だけ）。
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { FACT_LEDGER_VERSION, type Fact } from "./customer-fact-ledger";
import { isTestConversation } from "./test-conversations";

let _admin: SupabaseClient | null = null;
let _warned = false;
function admin(): SupabaseClient | null {
  if (_admin) return _admin;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    if (!_warned) { _warned = true; console.log(JSON.stringify({ tag: "fact-ledger:no-key", note: "SUPABASE_SERVICE_ROLE_KEY が無い＝帳面なし（今まで通り）" })); }
    return null;
  }
  _admin = createClient(url, key, { auth: { persistSession: false } });
  return _admin;
}

export type PendingFactLedger = { propertyCustomerId: string | null; facts: Fact[]; analyzedMsgTs: string | null; builtFrom: Record<string, string | null> };
const pending = new Map<string, PendingFactLedger>();
/** 分析の中で作った帳面を、保存の時まで預かる（会話ごとに最新だけ） */
export function stashFactLedger(conversationId: string, p: PendingFactLedger): void {
  if (isTestConversation(conversationId)) return; // 試験・テスト用の会話（YUMA・YUMA2〜5）は帳面を作らない（作業員1 11/03）
  pending.set(conversationId, p);
  if (pending.size > 200) { const first = pending.keys().next().value; if (first) pending.delete(first); }
}
/** ブレインの保存の後に1回だけ呼ぶ（預かった物が無ければ何もしない） */
export async function flushFactLedger(conversationId: string, timeoutMs = 3000): Promise<boolean> {
  const p = pending.get(conversationId);
  if (!p) return false;
  pending.delete(conversationId);
  const sb = admin();
  if (!sb) return false;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const { error } = await sb.from("customer_fact_ledger").upsert({
      conversation_id: conversationId, property_customer_id: p.propertyCustomerId, facts: p.facts, version: FACT_LEDGER_VERSION,
      built_from: p.builtFrom, analyzed_msg_ts: p.analyzedMsgTs, built_at: new Date().toISOString(),
    }, { onConflict: "conversation_id" }).abortSignal(ac.signal);
    if (error) {
      const timedOut = ac.signal.aborted || /abort|timeout/i.test(error.message);
      console.log(JSON.stringify({ tag: timedOut ? "fact-ledger:timeout-skip" : "fact-ledger:save-failed", conversationId: conversationId.slice(0, 8), msg: error.message.slice(0, 120) }));
      return false;
    }
    return true;
  } catch (e) {
    console.log(JSON.stringify({ tag: ac.signal.aborted ? "fact-ledger:timeout-skip" : "fact-ledger:save-failed", conversationId: conversationId.slice(0, 8), msg: (e instanceof Error ? e.message : String(e)).slice(0, 120) }));
    return false;
  } finally { clearTimeout(timer); }
}
