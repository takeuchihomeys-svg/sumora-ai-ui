// scripts/audit-ack-after-promise-silent.ts — 3巡目（10/07）: こちらの約束（ピックアップ・確認・見積書）の直後のお客様のお礼・了承だけの番に、スタッフは
//   ①短い受けを手打ちしたか ②何も打たずに約束を AIX で果たしたか（その間のお客様の発言なし）を数える（読むだけ・LLM なし）
//   約束の文は行動台帳と同じ読み（buildActionLedger の lastStaffEntry=promised）・お礼だけは analyzeSubstance.isAckOnly＋ZWJ の絵文字を落として読む
// 実行: npx tsx --env-file=.env.local scripts/audit-ack-after-promise-silent.ts [--days=120] [--show]
import { createClient } from "@supabase/supabase-js";
import { buildActionLedger } from "../app/lib/action-ledger";
import { analyzeSubstance } from "../app/lib/reply-context";
import { isTestConversation } from "../app/lib/test-conversations";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const DAYS = Number((process.argv.find((a) => a.startsWith("--days=")) ?? "--days=120").slice(7));
const SHOW = process.argv.includes("--show");
type M = { conversation_id: string; sender: string; text: string | null; created_at: string; is_aix_generated: boolean | null; line_message_id: string | null };
async function readAll<T>(q: (f: number, t: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = []; for (let i = 0; i < 1_000_000; i += 1000) { const r = await q(i, i + 999); if (r.error) throw new Error(r.error.message); const d = (r.data ?? []) as T[]; out.push(...d); if (d.length < 1000) break; } return out;
}
const ZWJ_EMOJI = /[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}\u{FE0F}\u{200D}♪♡☆★]/gu;
(async () => {
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  const msgs = await readAll<M>((f, t) => sb.from("messages").select("conversation_id, sender, text, created_at, is_aix_generated, line_message_id").gte("created_at", since).order("conversation_id").order("created_at").range(f, t));
  const apply = await readAll<{ conversation_id: string; created_at: string }>((f, t) => sb.from("aix_usage_logs").select("conversation_id, created_at").eq("aix_type", "application_push").gte("created_at", since).range(f, t));
  const applyAt = new Map<string, string>(); for (const a of apply) if (!applyAt.has(a.conversation_id) || a.created_at < applyAt.get(a.conversation_id)!) applyAt.set(a.conversation_id, a.created_at);
  const by = new Map<string, M[]>(); for (const m of msgs) { if (isTestConversation(m.conversation_id)) continue; (by.get(m.conversation_id) ?? by.set(m.conversation_id, []).get(m.conversation_id)!).push(m); }
  const tally = new Map<string, { text: number; silentAix: number; silentOther: number; textGapH: number[]; aixGapH: number[] }>();
  const shows: string[] = [];
  for (const [cid, ms] of by) {
    for (let i = 1; i < ms.length; i++) {
      const m = ms[i];
      if (m.sender !== "customer" || ms[i - 1].sender === "customer") continue;
      if (applyAt.has(cid) && applyAt.get(cid)! <= m.created_at) continue;
      // お客様の連投
      let j = i; while (j + 1 < ms.length && ms[j + 1].sender === "customer") j++;
      const turn = ms.slice(i, j + 1).map((x) => x.text ?? "").join("\n");
      if (/\[画像\]|https?:/.test(turn)) continue;
      const cleaned = turn.replace(ZWJ_EMOJI, "");
      if (!analyzeSubstance(cleaned, [cleaned]).isAckOnly) continue;
      const before = ms.slice(Math.max(0, i - 15), i);
      const ledger = buildActionLedger({ messages: before.map((x) => ({ sender: x.sender, text: x.text ?? "", createdAt: x.created_at, isAix: !!x.is_aix_generated, lineMessageId: x.line_message_id })), now: Date.parse(m.created_at) });
      const e = ledger.facts.lastStaffEntry;
      if (!e || e.status !== "promised") continue;
      const kind = e.kind;
      const next = ms.slice(j + 1).find((x) => x.sender !== "customer");
      const nextCust = ms.slice(j + 1).find((x) => x.sender === "customer");
      if (!next) continue;
      const t = tally.get(kind) ?? { text: 0, silentAix: 0, silentOther: 0, textGapH: [], aixGapH: [] };
      const gapH = (Date.parse(next.created_at) - Date.parse(ms[j].created_at)) / 3_600_000;
      if (nextCust && nextCust.created_at < next.created_at) { /* 次のお客様の発言が先＝この番には返していない */ t.silentOther++; }
      else if (next.is_aix_generated || /^\[画像\]$/.test((next.text ?? "").trim())) { t.silentAix++; t.aixGapH.push(gapH); }
      else { t.text++; t.textGapH.push(gapH); if (SHOW && shows.length < 40) shows.push(`[${kind}] 客「${turn.replace(/\n/g, " ").slice(0, 40)}」→ 人「${(next.text ?? "").replace(/\n/g, " / ").slice(0, 80)}」(${gapH.toFixed(1)}h)`); }
      tally.set(kind, t);
    }
  }
  const med = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)].toFixed(1) : "-");
  console.log(`約束の直後のお礼・了承だけの番（${DAYS}日・申込前・テスト除く）`);
  for (const [k, t] of tally) {
    const n = t.text + t.silentAix + t.silentOther;
    console.log(`  ${k.padEnd(24)} n=${n}｜手打ちの受け ${t.text}（${Math.round((t.text / n) * 100)}%・中央 ${med(t.textGapH)}h）｜打たずに AIX/資料で果たす ${t.silentAix}（${Math.round((t.silentAix / n) * 100)}%・中央 ${med(t.aixGapH)}h）｜返さずお客様が続けた ${t.silentOther}`);
  }
  for (const s of shows) console.log("   " + s);
})().catch((e) => { console.error(e); process.exit(1); });
