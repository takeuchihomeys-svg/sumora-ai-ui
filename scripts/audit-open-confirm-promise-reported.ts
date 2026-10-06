// scripts/audit-open-confirm-promise-reported.ts
// 実行: npx tsx --env-file=.env.local scripts/audit-open-confirm-promise-reported.ts
//
// 2026-10-06 竹内（R 事例）: 手打ちの確認結果の報告（「〜とのご返答でした」）が記録されず、【必ず】〇〇の確認→ご連絡 が開いたままだった。
//   台帳の報告の語彙を直した（action-ledger）ので、今開いている【必ず】の確認の約束のうち、約束より後のこちらの発言に報告があって
//   閉じられる行を出す（読み取りのみ・書き込まない）。閉じるのはスタッフ／竹内さんの確認の後（やる事に書く）。
import { createClient } from "@supabase/supabase-js";
import { classifyStaffTextFacts } from "../app/lib/action-ledger";
import { planPromiseCompletion, PROMISE_MUST_MARK } from "../app/lib/promise-calendar";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");

async function main() {
  const { data: rows, error } = await sb.from("calendar_events").select("id, conversation_id, event_type, notes, start_at, created_at, customer_name, is_done")
    .eq("is_done", false).eq("event_type", "follow_up").like("notes", `${PROMISE_MUST_MARK}%`).limit(1000);
  if (error) throw new Error(error.message);
  let closable = 0;
  for (const r of rows ?? []) {
    if (!r.conversation_id) continue;
    const { data: msgs } = await sb.from("messages").select("text, created_at").eq("conversation_id", r.conversation_id).eq("sender", "staff")
      .gt("created_at", r.created_at).order("created_at").limit(200);
    for (const m of msgs ?? []) {
      const done = classifyStaffTextFacts(m.text ?? "", m.created_at).filter((e) => e.status === "done")
        .map((e) => ({ kind: e.kind, object: e.detail?.object ?? null, checkPattern: e.detail?.checkPattern ?? null }));
      const ids = planPromiseCompletion(done, [{ id: r.id, event_type: r.event_type, notes: r.notes, is_done: false }]);
      if (ids.includes(r.id)) {
        closable++;
        console.log(`閉じられる｜id=${r.id}｜${r.conversation_id.slice(0, 8)} ${r.customer_name ?? ""}｜${String(r.notes).split("\n")[0]}\n   約束 ${String(r.created_at).slice(0, 16)} → 報告 ${m.created_at.slice(0, 16)}: ${String(m.text ?? "").replace(/\n/g, " ／ ").slice(0, 200)}`);
        break;
      }
    }
  }
  console.log(`=== 開いている【必ず】確認の約束 ${rows?.length ?? 0}行のうち、後の発言の報告で閉じられる ${closable}行 ===`);
}
main().catch((e) => { console.error(e); process.exit(1); });
