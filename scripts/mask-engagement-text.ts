// scripts/mask-engagement-text.ts — reply_engagement_signals.customer_reply_text の個人の値を伏せる（2026-11-15 作業員H・竹内さんの OK「個人情報は伏せる」）
//   既定は下見（伏せた後の形だけ出す・元の本文は出さない）。--apply で書く（customer_reply_text だけ・行は消さない・前の値は残さない）。
//   使い方: npx tsx --env-file=<.env.local> scripts/mask-engagement-text.ts --id=<id>[,<id>…] [--apply]
//          npx tsx --env-file=<.env.local> scripts/mask-engagement-text.ts --all [--apply]   （申込の書類・個人の値の網に当たる行を全部）
import { createClient } from "@supabase/supabase-js";
import { maskEngagementText, isApplicationLikeText } from "../app/lib/engagement-text-mask";
import { altPiiSignal } from "../app/lib/alt-pii-gate";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");
const ids = (process.argv.find((a) => a.startsWith("--id="))?.slice(5) ?? "").split(",").filter(Boolean);
const APPLY = process.argv.includes("--apply"), ALL = process.argv.includes("--all");
async function main() {
  const rows: Array<{ id: string; customer_reply_text: string | null }> = [];
  if (ids.length) { const { data, error } = await sb.from("reply_engagement_signals").select("id, customer_reply_text").in("id", ids); if (error) throw new Error(error.message); rows.push(...((data ?? []) as typeof rows)); }
  else if (ALL) {
    for (let i = 0; ; i += 1000) { const { data, error } = await sb.from("reply_engagement_signals").select("id, customer_reply_text").not("customer_reply_text", "is", null).range(i, i + 999); if (error) throw new Error(error.message); rows.push(...((data ?? []) as typeof rows)); if ((data ?? []).length < 1000) break; }
  }
  let n = 0, w = 0;
  for (const r of rows) {
    const t = r.customer_reply_text ?? "";
    const m = maskEngagementText(t);
    if (m === t) continue;
    n++;
    const remain = altPiiSignal(m);
    console.log(`--- ${r.id} 申込の形=${isApplicationLikeText(t)} 伏せた後に残る値=${remain ?? "なし"}\n${m}`);
    if (APPLY && !remain) { const { error } = await sb.from("reply_engagement_signals").update({ customer_reply_text: m }).eq("id", r.id); if (error) throw new Error(error.message); w++; }
  }
  console.log(`対象 ${rows.length}・伏せる ${n}・書いた ${w}${APPLY ? "" : "（下見）"}`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
