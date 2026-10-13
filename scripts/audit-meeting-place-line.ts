// scripts/audit-meeting-place-line.ts — AIX【待ち合わせ場所】の2行目を、雛形（前）と本日/明日の形（後）で竹内さんの実送信と比べる（読むだけ・LLM なし）
//   app/lib/meeting-place-form.ts の物差し。時間・日付は押下の記録（picker_choices）→ 無ければ送った文の3行目「M/D HH:MMに」から読む
// 実行: npx tsx --env-file=.env.local scripts/audit-meeting-place-line.ts [--days=90] [--writer=takeuchi|all]
import { createClient } from "@supabase/supabase-js";
import { meetingSecondLine } from "../app/lib/meeting-place-form";
import { isTestConversation } from "../app/lib/test-conversations";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const DAYS = Number(arg("days", "90"));
const WRITER = arg("writer", "takeuchi");
const WD = ["日", "月", "火", "水", "木", "金", "土"];
const norm = (s: string) => s.normalize("NFKC").replace(/\s+/g, "").replace(/😊|😌/g, "");

(async () => {
  const { data } = await sb.from("aix_usage_logs").select("conversation_id, created_at, sent_at, generated_text, was_edited, line_message_id, picker_choices").eq("aix_type", "meeting_place").gte("created_at", new Date(Date.now() - DAYS * 86400e3).toISOString()).order("created_at");
  const rows = ((data ?? []) as Array<{ conversation_id: string; created_at: string; sent_at: string | null; generated_text: string | null; was_edited: boolean | null; line_message_id: string | null; picker_choices: Record<string, unknown> | null }>).filter((r) => !isTestConversation(r.conversation_id) && r.generated_text);
  const ids = rows.map((r) => r.line_message_id).filter(Boolean) as string[];
  const w = new Map<string, string>();
  for (let i = 0; i < ids.length; i += 300) { const { data: ms } = await sb.from("messages").select("line_message_id, staff_writer").in("line_message_id", ids.slice(i, i + 300)); for (const m of (ms ?? []) as Array<{ line_message_id: string; staff_writer: string }>) w.set(m.line_message_id, m.staff_writer); }
  let n = 0, beforeHit = 0, afterHit = 0, changed = 0, changedHit = 0, changedBeforeHit = 0;
  const detail: string[] = [];
  for (const r of rows) {
    if (WRITER !== "all" && w.get(String(r.line_message_id)) !== WRITER) continue;
    const lines = String(r.generated_text).split("\n").map((x) => x.trim()).filter(Boolean);
    const sentL2 = lines.find((l) => /ご案内させて(頂|いただ)きます/.test(l)) ?? "（2行目なし）";
    const l3 = lines.find((l) => /に.+$/.test(l) && /\d{1,2}[:：]\d{2}に/.test(l)) ?? "";
    const pc = r.picker_choices ?? {};
    let date = String(pc.meeting_date ?? ""), time = String(pc.meeting_time ?? "");
    if (!date || !time) { const m = l3.normalize("NFKC").match(/(\d{1,2})\/(\d{1,2})\s*(\d{1,2}:\d{2})/); if (m) { date = date || `${m[1]}/${m[2]}`; time = time || m[3]; } }
    if (!date) continue;
    // 曜日つきの日付（雛形の2行目の形）
    const dm = date.normalize("NFKC").match(/(\d{1,2})\/(\d{1,2})/);
    if (!dm) continue;
    const at = Date.parse(r.sent_at ?? r.created_at);
    const y = new Date(at + 9 * 3600e3).getUTCFullYear();
    const label = `${Number(dm[1])}/${Number(dm[2])}（${WD[new Date(Date.UTC(y, Number(dm[1]) - 1, Number(dm[2]))).getUTCDay()]}）`;
    const before = `${label}ご案内させて頂きます！！`;
    const after = meetingSecondLine(label, time, at, true);
    n++;
    const bh = norm(before) === norm(sentL2), ah = norm(after) === norm(sentL2);
    if (bh) beforeHit++; if (ah) afterHit++;
    if (before !== after) { changed++; if (ah) changedHit++; if (bh) changedBeforeHit++; }
    detail.push(`${r.created_at.slice(0, 16)} ${before === after ? "  " : "変"} 前${bh ? "○" : "×"} 後${ah ? "○" : "×"} 竹内「${sentL2}」／後「${after}」`);
  }
  console.log(`# 待ち合わせ場所の2行目（${DAYS}日・書き手=${WRITER}）${n}押下`);
  console.log(`2行目が竹内さんと一字一句同じ（絵文字・空白を除く）: 前 ${beforeHit}/${n} → 後 ${afterHit}/${n}`);
  console.log(`後で形が変わる押下（今日・明日）: ${changed}（後で一致 ${changedHit}・前で一致していた ${changedBeforeHit}＝悪くなる）`);
  for (const d of detail) console.log(d);
})();
