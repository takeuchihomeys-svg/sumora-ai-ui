/**
 * 学習土台の欠落点検
 *
 *   npx tsx --env-file=.env.local scripts/foundation-audit.ts
 *   npx tsx --env-file=.env.local scripts/foundation-audit.ts --record
 *
 * ★ テスト／改善のたびに回す。足りない土台を番号で出し、--record で learn_improvements に残す。
 */
import { createClient } from "@supabase/supabase-js";
import { auditLearnFoundations, formatFoundationAudit } from "../app/lib/learn-foundation-audit";
import { saveImprovement } from "../app/lib/learn-improvements";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
);
const doRecord = process.argv.includes("--record");
const siteArg = (process.argv.find((a) => a.startsWith("--site=")) || "").replace("--site=", "") || "all";
const site = siteArg === "itandi" || siteArg === "realpro" ? siteArg : "all";

void (async () => {
  console.log(`site=${site}`);
  const a = await auditLearnFoundations(sb, { site: site as "all" | "realpro" | "itandi" });
  for (const line of formatFoundationAudit(a)) console.log(line);

  if (doRecord) {
    console.log("\n■ 足りない土台を強化記録へ");
    for (const f of a.items.filter((x) => !x.ok)) {
      const r = await saveImprovement({
        area: "学習",
        title: `土台不足 ${f.id}`,
        why: f.line,
        how: f.next,
        effect: `${f.id} が ✓ になる`,
        verify: "npx tsx --env-file=.env.local scripts/foundation-audit.ts",
        version: "2.8.35",
      });
      console.log(`  ${f.id}: ${r.ok ? (r.skipped || "saved") : r.error || "fail"}`);
    }
  }

  if (a.missing_n > 0) process.exitCode = 2;
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
