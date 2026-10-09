// scripts/audit-r11-takeuchi-length.ts — 11巡目: 竹内さんの手打ちの返信（返事のまとまりの最初の通・AIX でない・③報告でない）の
//   字数・文の数・行数・「！！」の数・呼び名の回数を、お客様の発言の場面（sent-shape.customerSceneOf）ごとに 10/25/50/75/90% で出す（読むだけ・LLM なし）。
//   プロンプトの数の制約（字数・行数・！！は3回以内・名前2回以内）を竹内さんの幅に直す根拠。
// 実行: npx tsx --env-file=.env.local scripts/audit-r11-takeuchi-length.ts [--days=180]
import { createClient } from "@supabase/supabase-js";
import { isTestConversation } from "../app/lib/test-conversations";
import { isStaffOnlyReport, sentencesOf } from "../app/lib/text-diff-types";
import { customerSceneOf } from "../app/lib/sent-shape";
import { isShortAckOnly } from "../app/lib/previous-send-note";
import { isConditionFormMessage } from "../app/lib/reply-context";
const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const DAYS = Number(arg("days", "180"));
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
const qs = (a: number[]) => { const s = [...a].sort((x, y) => x - y); const at = (p: number) => s[Math.min(s.length - 1, Math.floor(s.length * p))] ?? 0; return `${at(0.1)}/${at(0.25)}/${at(0.5)}/${at(0.75)}/${at(0.9)}`; };
(async () => {
  const msgs: Array<{ conversation_id: string; sender: string; created_at: string; text: string | null; is_aix_generated: boolean | null; staff_writer: string | null }> = [];
  for (let i = 0; ; i += 1000) { const r = await sb.from("messages").select("conversation_id, sender, created_at, text, is_aix_generated, staff_writer").gte("created_at", new Date(Date.now() - DAYS * 864e5).toISOString()).order("created_at").order("id").range(i, i + 999); if (r.error) throw r.error; msgs.push(...(r.data ?? []) as typeof msgs); if ((r.data ?? []).length < 1000) break; }
  const by = new Map<string, typeof msgs>(); for (const m of msgs) { if (!by.has(m.conversation_id)) by.set(m.conversation_id, []); by.get(m.conversation_id)!.push(m); }
  const st = new Map<string, { chars: number[]; sents: number[]; lines: number[]; bang: number[]; names: number[] }>();
  const add = (k: string, t: string) => {
    const v = st.get(k) ?? { chars: [], sents: [], lines: [], bang: [], names: [] };
    v.chars.push(t.replace(/\s/g, "").length); v.sents.push(sentencesOf(t).length); v.lines.push(t.split("\n").filter((l) => l.trim()).length);
    v.bang.push((t.normalize("NFKC").match(/!{2,}/g) ?? []).length); v.names.push((t.match(/[^\s、。！!？?\n]{1,10}さん(?!達)/g) ?? []).length);
    st.set(k, v);
  };
  for (const [cid, list] of by) {
    if (isTestConversation(cid)) continue;
    for (let i = 1; i < list.length; i++) {
      const m = list[i]; if (m.sender !== "staff" || m.is_aix_generated || m.staff_writer !== "takeuchi" || list[i - 1].sender !== "customer") continue;
      const t = (m.text ?? "").trim(); if (!t || /^\[/.test(t) || isStaffOnlyReport(t)) continue;
      let j = i - 1; const c: string[] = []; while (j >= 0 && list[j].sender === "customer") { c.unshift(list[j].text ?? ""); j--; }
      const sc = customerSceneOf(c.join("\n"), { isConditionForm: isConditionFormMessage, isShortAck: isShortAckOnly });
      const first = !list.slice(0, i).some((x) => x.sender === "staff");
      add(sc, t); add("全体", t); if (first) add("初回（こちらの送信がまだ無い）", t);
    }
  }
  console.log(`竹内さんの手打ち（${DAYS}日・返事のまとまりの最初の通）。各欄 10%/25%/50%/75%/90%`);
  console.log("場面 | n | 字数 | 文の数 | 行数 | ！！の数 | 呼び名の回数");
  for (const [k, v] of [...st].sort((a, b) => b[1].chars.length - a[1].chars.length)) {
    const over3 = v.bang.filter((x) => x > 3).length, name3 = v.names.filter((x) => x > 2).length;
    console.log(`${k} | ${v.chars.length} | ${qs(v.chars)} | ${qs(v.sents)} | ${qs(v.lines)} | ${qs(v.bang)}（4回以上 ${Math.round((100 * over3) / v.bang.length)}%） | ${qs(v.names)}（3回以上 ${Math.round((100 * name3) / v.names.length)}%）`);
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
