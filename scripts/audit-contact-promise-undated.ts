// scripts/audit-contact-promise-undated.ts — 日付の無い連絡の約束（contact-promise.parseUndatedContactPromise）を実送信の全期間に当てて、拾った文を目で読む（LLM なし・読むだけ）
// 2026-10-08 竹内さん「約束してカレンダーに入れる」＝日付の無い約束（来年再相談・時期が来ましたら）も
// 実行: npx tsx --env-file=.env.local scripts/audit-contact-promise-undated.ts [--all] [--miss]
//   --all  拾った文を全部出す ／ --miss  語（来年・時期・再相談 等）はあるのに拾わなかった文を出す（漏れの点検）
import { createClient } from "@supabase/supabase-js";
import { parseUndatedContactPromise, parseContactPromise, pendingUndatedPromise } from "../app/lib/contact-promise";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
async function main() {
  const rows: Array<{ id: string; conversation_id: string; text: string; created_at: string; staff_writer: string | null }> = [];
  for (const pat of ["%来年%", "%年明け%", "%時期%", "%再相談%", "%ヶ月後%", "%か月後%", "%ましたら%ご連絡%", "%春%", "%頃になりましたら%", "%落ち着%", "%タイミング%", "%その頃%"]) {
    for (let from = 0; ; from += 1000) {
      const { data, error } = await sb.from("messages").select("id, conversation_id, text, created_at, staff_writer").eq("sender", "staff").ilike("text", pat).order("created_at").range(from, from + 999);
      if (error) throw new Error(error.message);
      rows.push(...((data ?? []) as typeof rows));
      if (!data || data.length < 1000) break;
    }
  }
  const uniq = [...new Map(rows.map((r) => [r.id, r])).values()];
  const hits = uniq.map((r) => ({ r, p: parseUndatedContactPromise(r.text, r.created_at) })).filter((x) => x.p);
  const dated = uniq.filter((r) => parseContactPromise(r.text, r.created_at)).length;
  console.log(`候補 ${uniq.length}通 → 日付の無い約束 ${hits.length}通（日付の読める約束 ${dated}通は別の仕組み）`);
  const show = process.argv.includes("--all") ? hits : hits.slice(-40);
  for (const { r, p } of show) console.log(`\n[${r.created_at.slice(0, 16)} ${r.staff_writer ?? "?"} ${r.conversation_id.slice(0, 8)}]\n  ${p!.sentence}`);
  if (process.argv.includes("--miss")) {
    const cue = /来年|年明け|時期が|再相談|ヶ月後|か月後/;
    const miss = uniq.filter((r) => cue.test(r.text) && !parseUndatedContactPromise(r.text, r.created_at) && !parseContactPromise(r.text, r.created_at));
    console.log(`\n--- 語はあるが拾わなかった ${miss.length}通（最後の40）`);
    for (const r of miss.slice(-40)) console.log(`\n[${r.created_at.slice(0, 16)} ${r.conversation_id.slice(0, 8)}] ${r.text.replace(/\n/g, " ／ ").slice(0, 160)}`);
  }
  // 今「連絡の日を入れてください」が出る会話（こちらの最後の会話文が日付の無い約束・60日以内・その後に連絡の日の行が無い）
  const convs = [...new Set(hits.map((h) => h.r.conversation_id))];
  let pending = 0;
  for (const cid of convs) {
    const { data: msgs } = await sb.from("messages").select("sender, text, created_at").eq("conversation_id", cid).order("created_at", { ascending: false }).limit(60);
    const { data: rowsC } = await sb.from("calendar_events").select("notes, created_at").eq("conversation_id", cid).like("notes", "【必ず】%【連絡日%").limit(20);
    const ms = ((msgs ?? []) as Array<{ sender: string; text: string | null; created_at: string }>).reverse().map((m) => ({ sender: m.sender, text: m.text, createdAt: m.created_at }));
    const p = pendingUndatedPromise(ms, (rowsC ?? []) as Array<{ notes: string | null; created_at: string | null }>, Date.now());
    if (p) { pending++; console.log(`\n[今出る] ${cid.slice(0, 8)} ${p.sentAt.slice(0, 10)} 「${p.sentence}」`); }
  }
  console.log(`\n今「連絡の日を入れてください」が出る会話: ${pending}`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
