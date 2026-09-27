// 【📍 現在フェーズの参考】の「次の一手」（conversation_direction.next_staff_action）の前後を、本番の会話で並べて目で読む（読み取りのみ・LLM は呼ばない・本文はマスク）。
// 2026-09-27: 旧は戦略の層の next_steps[0] の語（申込／内覧／物件）で定型文に置き換えていた → 新はブレインの手順の（完了）でない最初の物をそのまま（app/lib/brain-stage.ts resolveNextStaffAction）。
// 材料: conversations の conversation_direction（current_phase・viewing_phase_detail）と、その時の戦略の next_steps（brain_strategy → last_brain_meta）。
//   旧＝保存時と同じ語の写し（下の oldNextStaffAction）・新＝resolveNextStaffAction。直近のお客様とこちらの発言も並べる。
// 実行: npx tsx --env-file=.env.local scripts/audit-next-staff-action.ts   （DAYS=30・SHOW=40）
import { createClient } from "@supabase/supabase-js";
import { resolveNextStaffAction } from "../app/lib/brain-stage";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, (process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)!);
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const DAYS = Number(process.env.DAYS ?? 30);
const SHOW = Number(process.env.SHOW ?? 40);
const mask = (s: string) => s.replace(/0\d{1,4}-?\d{1,4}-?\d{3,4}/g, "[電話]").replace(/https?:\/\/\S+/g, "[URL]").replace(/[^\s、。！!？?「」（）()\n:：]{1,8}(さん|様)/g, "〇〇$1").replace(/\s+/g, " ");

/** 旧（2026-08-14〜09-27）の写し: next_steps[0] の語で決める */
function oldNextStaffAction(nextSteps: unknown): string {
  const raw = Array.isArray(nextSteps) ? String((nextSteps as string[])[0] ?? "") : String(nextSteps ?? "");
  const src = raw.trim() || "状況を確認して次の一手を判断";
  if (/申込/.test(src)) return "お客さんの懸念点を確認しながら、申込書類の準備について自然に案内する";
  if (/内覧/.test(src)) return "物件の空き状況や他の問い合わせ状況を伝えながら、内覧日程を提案する";
  if (/物件/.test(src)) return "希望条件に合う物件を絞り込みながら、具体的な物件情報を送る";
  return src;
}

async function main() {
  const since = new Date(Date.now() - DAYS * 86400e3).toISOString();
  const rows: any[] = [];
  for (let p = 0; p < 20; p++) {
    const { data, error } = await sb.from("conversations").select("id, status, line_source_type, conversation_direction, brain_strategy, last_brain_meta, updated_at")
      .gte("updated_at", since).not("conversation_direction", "is", null).order("updated_at", { ascending: false }).range(p * 1000, p * 1000 + 999);
    if (error) { console.error(error.message); return; }
    rows.push(...(data ?? [])); if ((data ?? []).length < 1000) break;
  }
  const targets = rows.filter((r) => r.id !== YUMA && r.line_source_type !== "group");
  let same = 0, changed = 0; const byKind: Record<string, number> = {}; const shows: string[] = [];
  for (const r of targets) {
    const dir = r.conversation_direction ?? {};
    const steps = (r.brain_strategy?.next_steps ?? r.last_brain_meta?.next_steps) ?? null;
    const oldA = oldNextStaffAction(steps);
    const newA = resolveNextStaffAction({ nextSteps: steps, phase: dir.current_phase, viewingDetail: dir.viewing_phase_detail });
    if (oldA === newA) { same++; continue; }
    changed++;
    const k = `${dir.current_phase}${dir.viewing_phase_detail ? "/" + dir.viewing_phase_detail : ""}`;
    byKind[k] = (byKind[k] ?? 0) + 1;
    if (shows.length < SHOW) {
      const { data: ms } = await sb.from("messages").select("sender, text, created_at").eq("conversation_id", r.id).order("created_at", { ascending: false }).limit(4);
      const ctx = (ms ?? []).reverse().map((m) => `${m.sender === "customer" ? "客" : "こ"}:${mask(String(m.text ?? "")).slice(0, 50)}`).join(" ｜ ");
      shows.push(`--- ${r.id.slice(0, 8)} status=${r.status} 段階=${k}\n  戦略の1手目: ${mask(String(Array.isArray(steps) ? steps[0] ?? "" : steps ?? "")).slice(0, 90)}\n  旧: ${oldA.slice(0, 60)}\n  新: ${newA}\n  直近: ${ctx}`);
    }
  }
  console.log({ days: DAYS, conversations: targets.length, same, changed, changedByStage: byKind });
  shows.forEach((s) => console.log(s));
}
main();
