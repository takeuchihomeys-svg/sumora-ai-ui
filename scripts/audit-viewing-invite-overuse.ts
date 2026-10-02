// scripts/audit-viewing-invite-overuse.ts
// 2026-10-02 ⑫ 22巡の分類（B: 内覧調整の出しすぎ・flow2_t04「4階以外の他の階も見れたりしますか」・flow2_t07「管理人さん次第でまた内覧いきたい」（ペットの確認待ち）・viewing_17）:
//   本番 30日のブレインの判断が AIX【内覧調整】の番を、①こちらの確認の約束がまだ果たされていない ②お客様の発言が内覧についての質問 で分け、
//   スタッフが実際に内覧調整を押したか（返信で済ませたか）を数える。読むだけ・LLM なし。線は「スタッフが内覧調整を押した割合が低い」所だけ採る
// 実行: npx tsx --env-file=.env.local scripts/audit-viewing-invite-overuse.ts [--days=30]
import { createClient } from "@supabase/supabase-js";
import { staffWindowOf, type WindowMsg, type WindowPress } from "../app/lib/line-watch-judge";
import { isTestConversation } from "../app/lib/test-conversations";
import { pendingConfirmationBeforeTurn, customerAsksAboutViewing } from "../app/lib/viewing-invite-guard";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const DAYS = Number((process.argv.find((a) => a.startsWith("--days=")) ?? "--days=30").slice(7));
type M = WindowMsg & { conversation_id: string };
type P = WindowPress & { conversation_id: string };
async function readAll<T>(q: (f: number, t: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = []; for (let i = 0; i < 400_000; i += 1000) { const r = await q(i, i + 999); if (r.error) throw new Error(r.error.message); const d = (r.data ?? []) as T[]; out.push(...d); if (d.length < 1000) break; } return out;
}
(async () => {
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  const [msgs, presses, decs] = await Promise.all([
    readAll<M>((f, t) => sb.from("messages").select("conversation_id, sender, created_at, text, is_aix_generated").gte("created_at", since).order("created_at").order("id").range(f, t)),
    readAll<P>((f, t) => sb.from("aix_usage_logs").select("conversation_id, aix_type, check_pattern, created_at").gte("created_at", since).not("aix_type", "is", null).order("created_at").range(f, t)),
    readAll<{ conversation_id: string; analyzed_msg_ts: string | null; suggested_action: string | null; suggested_reply_mode: string | null }>((f, t) => sb.from("brain_decision_logs").select("conversation_id, analyzed_msg_ts, suggested_action, suggested_reply_mode").gte("created_at", since).eq("suggested_action", "viewing_invite").order("created_at").range(f, t)),
  ]);
  const by = <T extends { conversation_id: string }>(rows: T[]) => { const mp = new Map<string, T[]>(); for (const r of rows) { if (!mp.has(r.conversation_id)) mp.set(r.conversation_id, []); mp.get(r.conversation_id)!.push(r); } return mp; };
  const mBy = by(msgs), pBy = by(presses);
  const seen = new Set<string>();
  const cells: Record<string, { n: number; invite: number; other: number; text: number; ex: string[] }> = {};
  for (const d of decs) {
    if (!d.analyzed_msg_ts || isTestConversation(d.conversation_id)) continue;
    const key = `${d.conversation_id}|${d.analyzed_msg_ts}`; if (seen.has(key)) continue; seen.add(key);
    const ms = mBy.get(d.conversation_id) ?? [];
    const w = staffWindowOf({ customerTurnAt: d.analyzed_msg_ts, msgs: ms, presses: pBy.get(d.conversation_id) ?? [] });
    if (!w.closed) continue;
    const bp = w.presses.filter((p) => p.burst).map((p) => p.aix_type);
    const bt = w.texts.filter((t) => t.burst);
    if (!bp.length && !bt.length) continue;
    const before = ms.filter((m) => m.created_at < d.analyzed_msg_ts!);
    const turn = ms.filter((m) => m.sender === "customer" && m.created_at >= d.analyzed_msg_ts!).slice(0, 4).map((m) => m.text ?? "").join("\n");
    const pend = pendingConfirmationBeforeTurn(before.map((m) => ({ sender: m.sender, text: m.text ?? "" })));
    const ask = customerAsksAboutViewing(turn);
    const k = `${pend ? "確認待ち" : "確認待ちなし"}×${ask ? "内覧の質問" : "質問でない"}`;
    const c = (cells[k] ??= { n: 0, invite: 0, other: 0, text: 0, ex: [] });
    c.n++;
    if (bp.includes("viewing_invite")) c.invite++; else if (bp.length) c.other++; else c.text++;
    if (c.ex.length < 4 && !bp.includes("viewing_invite") && (pend || ask)) c.ex.push(`${turn.replace(/\n/g, " ").slice(0, 60)} → ${bt.map((t) => t.text).join(" ").replace(/\n/g, " ").slice(0, 60)}`);
  }
  console.log(`本番 ${DAYS}日・ブレインが AIX【内覧調整】の番（スタッフが返事をした番）`);
  for (const [k, c] of Object.entries(cells)) {
    console.log(`  ${k}: ${c.n}番 → スタッフが内覧調整 ${c.invite}・他の AIX ${c.other}・手打ちだけ ${c.text}`);
    for (const e of c.ex) console.log(`     ${e}`);
  }
})();
