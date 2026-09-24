// generate-pending-drafts の orphaned クエリ（2026-09-24 に updated_at 昇順を足した物）の**先頭**に何が並ぶかを見る（読み取りのみ・お客様名は出さない）
// 実行: npx tsx --env-file=.env.local scripts/peek-orphaned-head.ts [--limit=15]
// 目的: 先頭3件が「クレーム前に continue する行」（DRAFT_SKIP_STATUSES / post-apply の記録）で埋まると、
//       夜に溜まった会話（updated_at が新しい＝末尾）が毎分の3枠に入れない（反証 2026-09-24）
import { createClient } from "@supabase/supabase-js";
import { DRAFT_SKIP_STATUSES } from "../app/lib/conversation-status";
import { loadPostApplyFacts, resolvePostApply } from "../app/lib/post-apply";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? "").split("=").slice(1).join("=") || null;
const limit = Number(arg("limit") ?? "15");

async function main() {
  const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await sb
    .from("conversations")
    .select("id, status, is_post_apply, last_sender, draft_pending_at, draft_attempted_at, updated_at, draft_fail_count, ai_draft")
    .eq("last_sender", "customer")
    .or(`ai_draft.is.null,ai_draft.eq.__TRUNCATED__,ai_draft.eq."[AIX誘導中]"`)
    .or("draft_pending_at.is.null,draft_pending_at.lt." + tenMinutesAgo)
    .or("draft_attempted_at.is.null,draft_attempted_at.lt." + tenMinutesAgo)
    .gte("updated_at", sevenDaysAgo)
    // 2026-09-24 修正後の本番クエリと同じ形（DRAFT_SKIP_STATUSES 全部＋is_post_apply を落とす）。押下・本人確認書類由来の post_apply は残るのでループ側の backoff を見る
    .not("status", "in", `(${[...DRAFT_SKIP_STATUSES].join(",")})`)
    .or("is_post_apply.is.null,is_post_apply.eq.false")
    .or("draft_fail_count.is.null,draft_fail_count.lt.5")
    .order("updated_at", { ascending: true })
    .limit(limit);
  if (error) { console.log(error.message); process.exit(1); }
  const rows = (data ?? []) as Array<{ id: string; status: string | null; is_post_apply: boolean | null; draft_pending_at: string | null; draft_attempted_at: string | null; updated_at: string; draft_fail_count: number | null; ai_draft: string | null }>;
  console.log(`orphaned 候補（updated_at 昇順・先頭 ${rows.length} 件・7日以内）`);
  let blockers = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const skipStatus = DRAFT_SKIP_STATUSES.has((r.status ?? "").trim());
    let postApply = false, reason = "";
    try { const pa = resolvePostApply(await loadPostApplyFacts(sb as never, r.id)); postApply = pa.postApply; reason = String(pa.reason ?? ""); } catch (e) { reason = "read_failed:" + (e instanceof Error ? e.message : String(e)); }
    const preClaimSkip = skipStatus || postApply;
    if (preClaimSkip && i < 3) blockers++;
    console.log(`${String(i + 1).padStart(2)} ${r.updated_at.slice(0, 16)} status=${r.status ?? "null"} post_apply=${postApply ? `yes(${reason})` : "no"} draft=${r.ai_draft === null ? "null" : JSON.stringify(r.ai_draft).slice(0, 14)} pending=${r.draft_pending_at ? "set" : "-"} attempted=${r.draft_attempted_at ? r.draft_attempted_at.slice(0, 16) : "-"} fail=${r.draft_fail_count ?? 0} ${preClaimSkip ? "← クレーム前に continue（毎分同じ枠を占める）" : ""}`);
  }
  console.log(`先頭3枠のうちクレーム前 continue: ${blockers}/3`);
}
main().catch((e) => { console.error(e); process.exit(1); });
