// scripts/audit-episode-boundary-miss.ts — 台帳 #743: 申込の後の条件（探し直し）が最後の案件に残る＝審査落ちの後の切れ目が拾えていない疑いを分ける（読むだけ・LLM なし）
// 2026-11-26 作業員L。DEAL_STAGE_BEFORE_APPLY の比べ（11/25 22:19）で、申込の後の条件 14件のうち 9件が最後の案件の中に残った。
//   1件ごとに、切れ目（episodeBoundaries）の材料が揃っていたかを数だけで見る:
//     段の履歴の「申込→申込前」の戻し・審査の段・status_manual_back_at・通の数（customer-state は新しい 600通だけ読む＝古い否決の報告が落ちる）・
//     申込の後のこちらの通に否決の報告の型（isScreeningRejectedText）が当たるか（当たりの有無だけ・文は読まない・出さない）
//   出すのは会話の頭8字と数・真偽だけ
// 実行: npx tsx --env-file=.env.local scripts/audit-episode-boundary-miss.ts
import { createClient } from "@supabase/supabase-js";
import { computeConversationOutcome } from "../app/lib/deal-outcome-server";
import { isScreeningRejectedText, isApplyingStatus, isPreApplyStatus } from "../app/lib/deal-outcome";
import { CUSTOMER_STATE_MESSAGE_LIMIT } from "../app/lib/customer-state-server";
import { isTestConversation } from "../app/lib/test-conversations";

(async () => {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");
  process.env.DEAL_STAGE_BEFORE_APPLY = "on";
  const { data } = await sb.from("deal_outcomes").select("conversation_id").not("applied_at", "is", null).limit(2000);
  const convs = [...new Set(((data ?? []) as Array<{ conversation_id: string }>).map((r) => r.conversation_id))].filter((c) => !isTestConversation(c));
  const rows: Array<Record<string, unknown>> = [];
  for (const c of convs) {
    const o = await computeConversationOutcome(c, { db: sb as never });
    if (!o) continue;
    const last = o.episodes[o.episodes.length - 1];
    const k = o.episodes.length - 1;
    o.episodes.forEach((e, i) => {
      if (!e.postApplyStageAt?.condition || !e.stageAt.applied) return;
      const isLast = i === k;
      rows.push({ c, i, isLast, appliedAt: e.stageAt.applied, condAt: e.postApplyStageAt.condition, result: e.result, lastResult: last.result });
    });
    await new Promise((r) => setTimeout(r, 100));
  }
  console.log(`# 申込の後の条件（探し直し）がある案件 ${rows.length}（最後の案件 ${rows.filter((r) => r.isLast).length}）\n`);
  console.log("| 会話 | 最後の案件 | 通の数 | 600通を超える | 申込→申込前の戻し（申込の後） | 審査の段 | 手での戻し | 否決の報告の型（申込の後・こちら） | 否決の報告は読む600通の中 | 結果 |");
  console.log("|---|---|---|---|---|---|---|---|---|---|");
  const tally = new Map<string, number>();
  for (const r of rows) {
    const c = r.c as string, aAt = r.appliedAt as string;
    const [{ count }, { data: h }, { data: cv }, { data: staffAfter }, { data: newest }] = await Promise.all([
      sb.from("messages").select("id", { count: "exact", head: true }).eq("conversation_id", c),
      sb.from("conversation_stage_history").select("from_status, to_status, changed_at").eq("conversation_id", c).gte("changed_at", aAt).order("changed_at").limit(200),
      sb.from("conversations").select("status_manual_back_at").eq("id", c).maybeSingle(),
      sb.from("messages").select("text, created_at").eq("conversation_id", c).eq("sender", "staff").gte("created_at", aAt).lte("created_at", r.condAt as string).limit(300),
      sb.from("messages").select("created_at").eq("conversation_id", c).order("created_at", { ascending: false }).range(CUSTOMER_STATE_MESSAGE_LIMIT - 1, CUSTOMER_STATE_MESSAGE_LIMIT - 1),
    ]);
    const hist = (h ?? []) as Array<{ from_status: string | null; to_status: string | null; changed_at: string }>;
    const backs = hist.filter((x) => isApplyingStatus(x.from_status) && isPreApplyStatus(x.to_status)).length;
    const screening = hist.some((x) => x.to_status === "screening");
    const manual = !!(cv as { status_manual_back_at: string | null } | null)?.status_manual_back_at;
    const rejectAt = ((staffAfter ?? []) as Array<{ text: string | null; created_at: string }>).filter((m) => isScreeningRejectedText(m.text)).map((m) => m.created_at)[0] ?? null;
    const oldest600 = ((newest ?? []) as Array<{ created_at: string }>)[0]?.created_at ?? null; // 読む600通の一番古い時刻（600通以下なら無し）
    const rejectInWindow = rejectAt ? (!oldest600 || rejectAt >= oldest600) : null;
    const why = !r.isLast ? "後に新しい案件あり（切れ目の手前の探し直し）"
      : rejectAt && rejectInWindow === false ? "否決の報告が 600通の外（読まれていない）"
      : rejectAt ? "否決の報告はあるが切れ目にならない（形の網か 14日のまとめ）"
      : backs ? "段の戻しはあるが切れ目の印（否決・取り消し・フォーム・審査の段）が無い"
      : "切れ目の材料が無い（否決の報告も段の戻しも無い＝申込の後の別の物件探し）";
    tally.set(why, (tally.get(why) ?? 0) + 1);
    console.log(`| ${c.slice(0, 8)} | ${r.isLast ? "○" : "—"} | ${count ?? "?"} | ${(count ?? 0) > CUSTOMER_STATE_MESSAGE_LIMIT ? "○" : "—"} | ${backs} | ${screening ? "○" : "—"} | ${manual ? "○" : "—"} | ${rejectAt ? "○" : "—"} | ${rejectInWindow == null ? "—" : rejectInWindow ? "○" : "×"} | ${r.result} |`);
    await new Promise((res) => setTimeout(res, 100));
  }
  console.log("\n## 分け");
  for (const [k, n] of [...tally].sort((a, b) => b[1] - a[1])) console.log(`- ${k}: ${n}`);
})().catch((e) => { console.error(e); process.exit(1); });
