// 「申込以降」の印（is_post_apply=true）が付いているのに status が申込前のままの会話を applying へ前進させる（データ修復）
//
// 2026-09-23 課題②: 段階を持つ場所が DB に3つ（status／is_post_apply／brain_strategy.checkpoint_stage）あり、
//   page.tsx の「申込以降」トグルは is_post_apply を立てるだけで status を進めない（解除時だけ proposing に戻す）。
//   実物: is_post_apply=true 51件のうち status が申込前のまま 26件（51.0%）。
//   コード側の昇格条件（app/lib/applying-promotion.ts）は新しい出来事でしか動かないので、過去の遅れはここで直す。
//
// 【触らない物】
//   ・status_manual_back_at がある会話（スタッフが手で戻した判断が正・9280fa49 のような手戻し）
//   ・closed_* / contract 等の終わりの状態（PRE_APPLY_STATUSES 以外）
//
// 実行（既定は dry-run・書き込みなし）: npx tsx --env-file=.env.local scripts/repair-applying-status.ts
//   書き込む時:                           npx tsx --env-file=.env.local scripts/repair-applying-status.ts --apply
//   本名・電話番号は出力しない
import { createClient } from "@supabase/supabase-js";
import { PRE_APPLY_STATUSES } from "../app/lib/application-form-detect";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const APPLY = process.argv.includes("--apply");
const short = (id: string) => id.slice(0, 8);
const fmt = (iso: string | null | undefined) => (iso ? iso.slice(0, 16).replace("T", " ") : "-");

type Conv = { id: string; status: string | null; is_post_apply: boolean | null; status_manual_back_at: string | null; brain_strategy: Record<string, unknown> | null; updated_at: string | null };

async function main() {
  const { data, error } = await sb.from("conversations")
    .select("id, status, is_post_apply, status_manual_back_at, brain_strategy, updated_at")
    .eq("is_post_apply", true)
    .in("status", PRE_APPLY_STATUSES);
  if (error) { console.error(error.message); process.exit(1); }
  const rows = (data ?? []) as Conv[];
  const skippedManual = rows.filter((c) => c.status_manual_back_at);
  const targets = rows.filter((c) => !c.status_manual_back_at);

  console.log(`=== is_post_apply=true かつ status が申込前: ${rows.length}件（手戻しの印あり ${skippedManual.length}件は触らない → 対象 ${targets.length}件）${APPLY ? "【書き込みモード】" : "【dry-run】"} ===`);
  for (const c of skippedManual) console.log(`  触らない [${short(c.id)}] status=${c.status} 手戻し=${fmt(c.status_manual_back_at)} brain=${String(c.brain_strategy?.checkpoint_stage ?? "-")}`);

  // 根拠（フォーム文・本人確認書類・AIX【申込へ】）を添えて1件ずつ出す（目で読む）
  const ids = targets.map((c) => c.id);
  const { data: pushes } = await sb.from("aix_usage_logs").select("conversation_id, created_at").eq("aix_type", "application_push").in("conversation_id", ids);
  const { data: idDocs } = await sb.from("messages").select("conversation_id, created_at").eq("image_type", "id_document").in("conversation_id", ids);
  const pushBy = new Map<string, string[]>(); for (const p of (pushes ?? []) as { conversation_id: string; created_at: string }[]) pushBy.set(p.conversation_id, [...(pushBy.get(p.conversation_id) ?? []), p.created_at]);
  const idBy = new Map<string, number>(); for (const d of (idDocs ?? []) as { conversation_id: string }[]) idBy.set(d.conversation_id, (idBy.get(d.conversation_id) ?? 0) + 1);

  let done = 0;
  for (const c of targets.sort((a, b) => (a.updated_at ?? "").localeCompare(b.updated_at ?? ""))) {
    const brain = String(c.brain_strategy?.checkpoint_stage ?? "-");
    const pushList = (pushBy.get(c.id) ?? []).sort();
    console.log(`  ${APPLY ? "進める" : "対象"} [${short(c.id)}] ${c.status} → applying  brain=${brain} 申込へ=${pushList.length}${pushList.length ? `（最終 ${fmt(pushList[pushList.length - 1])}）` : ""} 本人確認書類=${idBy.get(c.id) ?? 0} 最終更新=${fmt(c.updated_at)}`);
    if (!APPLY) continue;
    const { data: updated, error: upErr } = await sb.from("conversations")
      // ⚠ updated_at は書かない（反証者の指摘）: 休眠中の会話が一覧の最上位に並び、daily-brief の「今日更新」・brain-sweep の48h窓に入って
      //   要対応でない会話に分析・通知が飛ぶ（2026-09-12 Sky・AKANE と同じ形）。status と stage_history だけ書く
      .update({ status: "applying" })
      .eq("id", c.id)
      .eq("is_post_apply", true)
      .is("status_manual_back_at", null)
      .in("status", PRE_APPLY_STATUSES)
      .select("id");
    if (upErr) { console.error(`    失敗 [${short(c.id)}]`, upErr.message); continue; }
    if ((updated ?? []).length === 0) { console.log(`    変更なし [${short(c.id)}]（実行中に状態が変わった）`); continue; }
    const { error: stErr } = await sb.from("conversation_stage_history").insert({ conversation_id: c.id, from_status: c.status, to_status: "applying", trigger: "repair:post_apply_flag" });
    if (stErr) console.warn(`    履歴の記録に失敗 [${short(c.id)}]`, stErr.message);
    done++;
  }
  console.log(`\n${APPLY ? `進めた ${done}/${targets.length}件` : `dry-run: 対象 ${targets.length}件（--apply で書き込む）`}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
