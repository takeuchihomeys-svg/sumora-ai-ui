// scripts/outcome-loss-reason.ts — 失注の理由を DeepSeek で読む（段4・作っただけ・まだ動かしていない 2026-10-08）
//   ⚠ 竹内さんの決定①: 理由は弱い参考（件数の集計だけ）。ブレイン・学習・返信には渡さない。
//   対象: deal_outcomes の lost で lost_type が declined_elsewhere / move_cancelled・lost_reason_source が deepseek でない行だけ。
//   渡す物: 失注の時刻より前・申込前（deepseek_cutoff_at の線より前）のお客様の発言の最後の5通だけ・名前・電話等は maskPII で伏せる。申込中の文は渡さない。
//   費用: 1件 約1千字 → 全件でも数円。
// 実行:
//   npx tsx --env-file=.env.local scripts/outcome-loss-reason.ts                 # 既定: 送る文を見せるだけ（LLM を呼ばない）
//   npx tsx --env-file=.env.local scripts/outcome-loss-reason.ts --call          # DeepSeek を呼んで結果を見せる（書かない）
//   npx tsx --env-file=.env.local scripts/outcome-loss-reason.ts --call --apply  # 書く（lost_reason・lost_reason_source='deepseek'・lost_reason_note）
import { createClient } from "@supabase/supabase-js";
import { maskPII } from "../app/lib/pii-mask";
import { callDeepSeekRead } from "../app/lib/vision-alt-provider";
import { LOSS_REASON_SYSTEM, buildLossReasonUserText, parseLossReason } from "../app/lib/deal-loss-reason";
import { lossReasonNeedsText, type LostType } from "../app/lib/deal-outcome";

const CALL = process.argv.includes("--call");
const APPLY = process.argv.includes("--apply");
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);

async function main() {
  const { data, error } = await sb.from("deal_outcomes").select("id, conversation_id, episode_no, lost_type, lost_at, lost_reason_source").eq("result", "lost").in("lost_type", ["declined_elsewhere", "move_cancelled"]);
  if (error) throw new Error(error.message);
  const rows = ((data ?? []) as Array<{ id: number; conversation_id: string; episode_no: number; lost_type: LostType; lost_at: string | null; lost_reason_source: string | null }>)
    .filter((r) => lossReasonNeedsText(r.lost_type) && r.lost_reason_source !== "deepseek" && r.lost_at);
  const { data: names } = await sb.from("conversations").select("customer_name").limit(2000);
  const known = ((names ?? []) as Array<{ customer_name: string | null }>).map((n) => n.customer_name).filter((x): x is string => !!x);
  console.log(`対象 ${rows.length}件（${CALL ? "DeepSeek を呼ぶ" : "送る文を見せるだけ"}${APPLY ? "・書く" : ""}）`);
  for (const r of rows) {
    const { data: conv } = await sb.from("conversations").select("deepseek_cutoff_at").eq("id", r.conversation_id).maybeSingle();
    const cutoff = (conv as { deepseek_cutoff_at?: string | null } | null)?.deepseek_cutoff_at ?? null;
    const until = cutoff && Date.parse(cutoff) < Date.parse(r.lost_at!) ? cutoff : r.lost_at!;
    const { data: msgs } = await sb.from("messages").select("text, created_at").eq("conversation_id", r.conversation_id).eq("sender", "customer")
      .lte("created_at", until).order("created_at", { ascending: false }).limit(5);
    const texts = ((msgs ?? []) as Array<{ text: string | null }>).reverse().map((m) => maskPII(String(m.text ?? ""), known)).filter((t) => t.trim() && !/^\s*\[画像\]/.test(t));
    if (!texts.length) continue;
    const user = buildLossReasonUserText(texts);
    if (!CALL) { console.log(`\n■ ${r.conversation_id.slice(0, 8)}#${r.episode_no} ${r.lost_type}\n${user}`); continue; }
    const read = await callDeepSeekRead(LOSS_REASON_SYSTEM, user, { maxTokens: 120, timeoutMs: 30_000 }, parseLossReason);
    console.log(`${r.conversation_id.slice(0, 8)}#${r.episode_no} ${r.lost_type} → ${read.value ? `${read.value.reason}「${read.value.quote}」` : "読めず"}`);
    if (APPLY && read.value) {
      const { error: uErr } = await sb.from("deal_outcomes").update({ lost_reason: read.value.reason, lost_reason_source: "deepseek", lost_reason_note: read.value.quote }).eq("id", r.id).eq("locked", false);
      if (uErr) console.warn(`  書けず: ${uErr.message}`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
