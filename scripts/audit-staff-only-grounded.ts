// scripts/audit-staff-only-grounded.ts — STAFF_ONLY_GROUNDED（こちらが送った日時・住所の言い直しを「スタッフしか知らない事」に数えない）の前後（読むだけ・LLM なし）
//   見張りの番（line_watch_turns）の下書きで内覧の確定・待ち合わせの住所に当たる物を、その番より前の通（材料）に照らし、根拠ありになる物と、その後のスタッフの文を並べる
//   実行: npx tsx --env-file=.env.local scripts/audit-staff-only-grounded.ts
import { supabase } from "../app/lib/supabase-server";
import { findStaffOnlyFact, isStaffOnlyFactGrounded } from "../app/lib/staff-confirm-facts";
(async () => {
  const { data } = await supabase.from("line_watch_turns").select("id, conversation_id, customer_turn_at, draft_last, staff_texts").not("draft_last", "is", null).order("customer_turn_at", { ascending: false }).range(0, 999);
  let hits = 0, grounded = 0;
  for (const r of (data ?? []) as Array<{ id: number; conversation_id: string; customer_turn_at: string; draft_last: string; staff_texts: Array<{ text?: string }> | null }>) {
    const sf = findStaffOnlyFact(r.draft_last);
    if (!sf || (sf.kind !== "viewing_fixed" && sf.kind !== "meeting_address")) continue;
    hits++;
    const { data: msgs } = await supabase.from("messages").select("text").eq("conversation_id", r.conversation_id).lte("created_at", r.customer_turn_at).order("created_at", { ascending: false }).range(0, 29);
    const ground = ((msgs ?? []) as Array<{ text: string | null }>).map((m) => m.text ?? "").join("\n");
    const g = isStaffOnlyFactGrounded(sf, ground);
    if (g) grounded++;
    console.log(`${r.id} ${r.customer_turn_at.slice(0, 16)} ${sf.kind} 根拠=${g} ｜下書き「${sf.text.slice(0, 60)}」｜スタッフ「${String(r.staff_texts?.[0]?.text ?? "").replace(/\s+/g, " ").slice(0, 70)}」`);
  }
  console.log(`\n内覧の確定・住所に当たる下書き ${hits}・根拠あり ${grounded}`);
  process.exit(0);
})();
