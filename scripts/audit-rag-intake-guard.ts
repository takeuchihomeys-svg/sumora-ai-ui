// scripts/audit-rag-intake-guard.ts — RAG の入口の歯止め（ragIntakeExcludeReason）を過去の返信の手本（line_reply）全件に当て、外れる行を全部並べる（読むだけ・LLM なし）
// 2026-10-09 竹内さん承認「RAG の案は全部おすすめで承認」→ save-reply-example で AIX の番の文・申込以降の中身を rag_excluded で保存する前に、誤外し0を目で確かめる
// 実行: npx tsx --env-file=.env.local scripts/audit-rag-intake-guard.ts [--all]   （--all で全行・既定は理由ごとに全件を1行ずつ）
import { createClient } from "@supabase/supabase-js";
import { ragIntakeExcludeReason, inApplyWindow } from "../app/lib/rag-garbage";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
const one = (s: string | null | undefined, n = 150) => String(s ?? "").replace(/\s+/g, " ").slice(0, n);

async function pageAll<T>(table: string, cols: string, f?: (q: any) => any): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; ; i += 1000) {
    let q = sb.from(table).select(cols).order("id").range(i, i + 999);
    if (f) q = f(q);
    const r = await q; if (r.error) throw new Error(r.error.message);
    out.push(...((r.data ?? []) as T[])); if ((r.data ?? []).length < 1000) break;
  }
  return out;
}

async function main() {
  const outs = await pageAll<{ conversation_id: string; applied_at: string | null; ended_at: string | null }>("deal_outcomes", "id, conversation_id, applied_at, ended_at");
  const win = new Map<string, Array<{ applied_at: string | null; ended_at: string | null }>>();
  for (const o of outs) (win.get(o.conversation_id) ?? win.set(o.conversation_id, []).get(o.conversation_id)!).push(o);
  const rows = await pageAll<{ id: string; created_at: string; sent_at: string | null; conversation_id: string | null; is_starred: boolean; sent_reply: string | null; customer_message: string | null }>(
    "ai_reply_examples", "id, created_at, sent_at, conversation_id, is_starred, sent_reply, customer_message", (q) => q.eq("entry_source", "line_reply"));
  const by = new Map<string, typeof rows>();
  for (const r of rows) {
    const at = r.sent_at ?? r.created_at;
    const reason = ragIntakeExcludeReason({ entrySource: "line_reply", sentReply: r.sent_reply, inPostApplyWindow: !!r.conversation_id && inApplyWindow(win.get(r.conversation_id) ?? [], at) }, {});
    if (!reason) continue;
    (by.get(reason) ?? by.set(reason, []).get(reason)!).push(r);
  }
  const total = [...by.values()].reduce((a, b) => a + b.length, 0);
  console.log(`返信の手本 line_reply ${rows.length}行のうち 入口で外れる ${total}行`);
  for (const [reason, list] of [...by.entries()].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`\n■ ${reason} ${list.length}行（⭐${list.filter((x) => x.is_starred).length}）`);
    for (const r of list.sort((a, b) => a.created_at.localeCompare(b.created_at))) console.log(`  ${r.id.slice(0, 8)} ${r.created_at.slice(0, 10)} ${r.is_starred ? "⭐" : "  "} 客「${one(r.customer_message, 40)}」→ ${one(r.sent_reply)}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
