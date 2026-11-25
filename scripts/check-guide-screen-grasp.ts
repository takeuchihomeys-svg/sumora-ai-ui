/**
 * 手順書×画面照会 F57 点検（改善完了の関所）
 *
 *   使い方: npx tsx --env-file=.env.local scripts/check-guide-screen-grasp.ts
 *
 * ★ 「コードを入れた」だけでは完了にしない。本番 search_audits の段印を読む。
 */
import { createClient } from "@supabase/supabase-js";
import { auditGuideScreenGrasp, GUIDE_SCREEN_PHASES } from "../app/lib/guide-screen-grasp";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
);

async function main() {
  console.log("■ 段定義（完了線の正本）");
  for (const p of GUIDE_SCREEN_PHASES) {
    console.log(`  ${p.id}\tneed=${p.need}\t${p.label}`);
  }

  const { data: audits } = await sb
    .from("search_audits")
    .select("id,created_at,ext_version,mode,steps")
    .eq("site", "realpro")
    .order("created_at", { ascending: false })
    .limit(5);

  console.log("\n■ 直近監査（F57）");
  for (const a of audits || []) {
    const r = auditGuideScreenGrasp({ steps: Array.isArray(a.steps) ? a.steps : [] });
    console.log(
      `  #${a.id} ${a.ext_version} ${a.mode} → ${r.improve_complete ? "完了✓" : "未完"} ${r.done}/${r.total}`
        + (r.missing.length ? ` 欠=${r.missing.join("・")}` : ""),
    );
  }

  const latest = audits?.[0];
  if (!latest) {
    console.log("\n監査なし");
    process.exit(1);
  }
  const r = auditGuideScreenGrasp({ steps: Array.isArray(latest.steps) ? latest.steps : [] });
  console.log("\n■ 最新の判定");
  console.log(" ", r.line);
  console.log("  次:", r.next);
  console.log("  改善完了と言ってよいか:", r.improve_complete ? "YES" : "NO（コード配線だけでは不可）");
  process.exit(r.improve_complete ? 0 : 2);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
