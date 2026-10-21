// scripts/customer-hub.ts — お客様ごとの共通の状態（ハブ・customer-hub.ts）を見る（読むだけ・書かない・LLM なし・名前と番号は伏せる）
// 実行:
//   1会話: npx tsx --env-file=.env.local scripts/customer-hub.ts --conv=<会話id>
//   食い違いの数え: npx tsx --env-file=.env.local scripts/customer-hub.ts --audit [--days=14] [--limit=400] [--json]
import { createClient } from "@supabase/supabase-js";
import { renderCustomerHubFor, auditCustomerHubs, renderHubAudit } from "../app/lib/customer-hub-server";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
(async () => {
  const conv = arg("conv");
  if (conv) {
    const t = await renderCustomerHubFor(sb, conv);
    console.log(t ?? "読めない（会話が無い・材料が読めない）");
    return;
  }
  if (process.argv.includes("--audit")) {
    const days = Number(arg("days") ?? 14);
    const limit = arg("limit") ? Number(arg("limit")) : undefined;
    const s = await auditCustomerHubs(sb, { days, limit, concurrency: 4, onProgress: (n, total) => { if (n % 25 === 0 || n === total) process.stderr.write(`  ${n}/${total}\n`); } });
    console.log(renderHubAudit(s));
    if (process.argv.includes("--json")) console.log(JSON.stringify({ ...s, samples: undefined }, null, 1));
    return;
  }
  console.log("--conv=<会話id> か --audit を付けてください");
})().catch((e) => { console.error(e); process.exit(1); });
