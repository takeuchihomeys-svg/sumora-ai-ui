// scripts/audit-silent-followup-rows.ts — #805: やることリストの「追い」の行（STAFF_TODO_SILENT_FOLLOWUP）が出る番の数と、そのうちスタッフが実際に追いを送った数（読むだけ・LLM なし）
// 2026-11-28 作業員A（統括役の決め (a): SILENT_SINCE_OURS_LINE は off のまま・#805 の本番の顔はやることリスト・on にするかは push の後の数日分の数で決める）
//   行の条件は app/lib/staff-todo-list.ts ④-2 と同じ（純関数 scripts/lib/silent-followup-count.ts）。AIX 要対応・お約束の行がある会話は外せていない＝行の数は上限。
//   申込以降・失注・テストの会話は今の会話の状態で外す。読み: messages（窓＋2日）と conversations の状態だけ＝軽い（昼でもよい）
//   実行: npx tsx --env-file=.env.local scripts/audit-silent-followup-rows.ts [--days=7] [--since=2026-11-29T00:00:00+09:00] [--json=<file>]
import { writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { silentEpisodesOf, SF_OUTCOME_JA, type SfMsg, type SfOutcome } from "./lib/silent-followup-count";
import { isTestConversation } from "../app/lib/test-conversations";
import { DRAFT_SKIP_STATUSES } from "../app/lib/conversation-status";
import { jstMDHm } from "../app/lib/jst-date";

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? "";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "", { auth: { persistSession: false } });

(async () => {
  const nowMs = Date.now();
  const sinceMs = arg("since") ? Date.parse(arg("since")) : nowMs - Number(arg("days") || 7) * 86_400_000;
  if (!Number.isFinite(sinceMs)) throw new Error("--since が読めない");
  const readFrom = new Date(sinceMs - 3 * 86_400_000).toISOString(); // 行が出る24時間前の通と、窓 49時間のお客様の通まで
  let msgs: Array<SfMsg & { conversation_id: string }> = [];
  for (let o = 0; o < 50_000; o += 1000) {
    const { data, error } = await sb.from("messages").select("conversation_id, sender, text, created_at, staff_writer, is_aix_generated").gte("created_at", readFrom).order("created_at").range(o, o + 999);
    if (error) throw error;
    msgs = msgs.concat((data ?? []) as typeof msgs);
    if ((data ?? []).length < 1000) break;
  }
  const byConv = new Map<string, SfMsg[]>();
  for (const m of msgs) { if (isTestConversation(m.conversation_id)) continue; (byConv.get(m.conversation_id) ?? byConv.set(m.conversation_id, []).get(m.conversation_id)!).push(m); }
  const ids = [...byConv.keys()];
  const status = new Map<string, { status: string | null; is_post_apply: boolean | null }>();
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await sb.from("conversations").select("id, status, is_post_apply").in("id", ids.slice(i, i + 200));
    if (error) throw error;
    for (const c of data ?? []) status.set(c.id as string, { status: (c.status as string | null) ?? null, is_post_apply: (c.is_post_apply as boolean | null) ?? null });
  }
  const skippedConv = { post_apply_or_closed: 0 };
  const rows: Array<{ conv: string; day: string } & ReturnType<typeof silentEpisodesOf>[number]> = [];
  for (const [cid, ms] of byConv) {
    const st = status.get(cid);
    if (st && (st.is_post_apply || DRAFT_SKIP_STATUSES.has((st.status ?? "").trim()) || st.status === "closed_lost")) { skippedConv.post_apply_or_closed++; continue; }
    for (const ep of silentEpisodesOf(ms, nowMs)) {
      if (Date.parse(ep.rowFrom) < sinceMs) continue;
      rows.push({ conv: cid.slice(0, 8), day: jstMDHm(ep.rowFrom).split(" ")[0], ...ep });
    }
  }
  const count = (rs: typeof rows) => { const c: Record<SfOutcome, number> = { followed_in_window: 0, followed_late: 0, customer_back_first: 0, open_in_window: 0, none_after_window: 0 }; for (const r of rs) c[r.outcome]++; return c; };
  const all = count(rows);
  const followed = rows.filter((r) => r.outcome === "followed_in_window");
  console.log(`■ 追いの行（STAFF_TODO_SILENT_FOLLOWUP の条件・AIX 要対応／お約束の行の会話は外せていない＝上限）: ${new Date(sinceMs).toISOString()} から ${rows.length}行（会話 ${new Set(rows.map((r) => r.conv)).size}）・申込以降／失注で外した会話 ${skippedConv.post_apply_or_closed}`);
  for (const k of Object.keys(all) as SfOutcome[]) console.log(`  ${SF_OUTCOME_JA[k]}: ${all[k]}`);
  const decided = rows.length - all.open_in_window;
  console.log(`  → 行が出た番のうちスタッフが行の出ている間に追った: ${followed.length}/${decided}（窓の中の ${all.open_in_window} は除く）・うち竹内さん本人 ${followed.filter((r) => r.followWriter === "takeuchi").length}・AIX ${followed.filter((r) => r.followAix).length}・追いの後72時間以内に戻った ${followed.filter((r) => r.backAfterFollow).length}`);
  const days = [...new Set(rows.map((r) => r.day))].sort();
  console.log("\n■ 日ごと（行が出始めた日・JST）: 行／行の間に追った／誰も送らず");
  for (const d of days) { const rs = rows.filter((r) => r.day === d); const c = count(rs); console.log(`  ${d}: ${rs.length}／${c.followed_in_window}／${c.none_after_window}`); }
  if (arg("json")) { writeFileSync(arg("json"), JSON.stringify({ at: new Date(nowMs).toISOString(), since: new Date(sinceMs).toISOString(), all, rows }, null, 1)); console.log(`\n写し: ${arg("json")}`); }
})().then(() => { process.exitCode = 0; }, (e) => { console.error(e); process.exitCode = 1; });
