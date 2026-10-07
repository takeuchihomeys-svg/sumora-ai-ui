// scripts/r7-pick-turns.ts — 7巡目: YUMA の再生に流す本番の過去の番を場面ごとに選ぶ（読むだけ・LLM なし）
//   出す形は scripts/yuma-r3-replay.ts の --src=path:<jsonl>（{conv, at, scene, staff, staffText}・at＝お客様の最後の発言の時刻＝含む）
//   ①見張り（line_watch_turns・返信の道・スタッフが文字で返した番）②送った例（ai_reply_examples・下書きあり）の順に、場面ごとに --per まで
//   外す: テスト・身内の会話／申込へを押した後／スタッフの文がスタッフだけが知る事の報告（③ AIX の番＝返信の文の物差しに入れない）／スタッフの文が画像だけ
// 実行: npx tsx --env-file=.env.local scripts/r7-pick-turns.ts [--days=30] [--per=22] [--out=scripts/.replay-out/r7-turns.jsonl]
import { createClient } from "@supabase/supabase-js";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolveReplyScene, type ReplyScene } from "../app/lib/reply-scene";
import { isTestConversation } from "../app/lib/test-conversations";
import { isStaffOnlyReport } from "../app/lib/text-diff-types";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const DAYS = Number(arg("days", "30"));
const PER = Number(arg("per", "22"));
const OUT = arg("out", "scripts/.replay-out/r7-turns.jsonl");
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
type M = { sender: string; created_at: string; text: string | null; is_aix_generated: boolean | null };

(async () => {
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  const applied = new Map<string, string>();
  const ap = await sb.from("aix_usage_logs").select("conversation_id, created_at").eq("aix_type", "application_push").order("created_at").limit(5000);
  for (const x of (ap.data ?? []) as Array<{ conversation_id: string; created_at: string }>) if (!applied.has(x.conversation_id)) applied.set(x.conversation_id, x.created_at);
  const out: Array<{ conv: string; at: string; scene: ReplyScene; staff: string[]; staffText: string; src: string }> = [];
  const count = new Map<string, number>(); const seen = new Set<string>(); const skipped = new Map<string, number>();
  const sk = (k: string) => skipped.set(k, (skipped.get(k) ?? 0) + 1);
  const msgsOf = async (cid: string, lte: string) => (((await sb.from("messages").select("sender, created_at, text, is_aix_generated").eq("conversation_id", cid).lte("created_at", lte).order("created_at", { ascending: false }).limit(12)).data ?? []) as M[]).reverse();
  const push = async (cid: string, staffAt: string, staffText: string, src: string) => {
    if (isTestConversation(cid)) return sk("test");
    const a = applied.get(cid); if (a && Date.parse(a) <= Date.parse(staffAt)) return sk("申込以降");
    if (!staffText.trim() || /^\s*\[(?:画像|動画|スタンプ)\]\s*$/.test(staffText)) return sk("画像だけ");
    if (isStaffOnlyReport(staffText)) return sk("スタッフだけが知る報告（③）");
    const ms = await msgsOf(cid, staffAt);
    let end = ms.length - 1; while (end >= 0 && ms[end].sender !== "customer") end--;
    if (end < 0) return sk("お客様の発言なし");
    let start = end; while (start - 1 >= 0 && ms[start - 1].sender === "customer") start--;
    const at = ms[end].created_at; const key = `${cid}|${at}`;
    if (seen.has(key)) return; seen.add(key);
    const scene = resolveReplyScene({ customerText: ms.slice(start, end + 1).map((m) => m.text ?? "").join("\n") }).scene;
    if ((count.get(scene) ?? 0) >= PER) return;
    count.set(scene, (count.get(scene) ?? 0) + 1);
    out.push({ conv: cid, at, scene, staff: ["reply"], staffText, src });
  };
  const w = await sb.from("line_watch_turns").select("conversation_id, customer_turn_at, staff_texts, verdict, verdict_detail").gte("customer_turn_at", since).not("verdict", "is", null).order("customer_turn_at", { ascending: false }).limit(1000);
  for (const r of (w.data ?? []) as Array<{ conversation_id: string; staff_texts: Array<{ at: string; text: string; burst: boolean }> | null; verdict_detail: Record<string, unknown> | null }>) {
    const burst = (r.staff_texts ?? []).filter((t) => t.burst && t.text.trim() && !/^\s*\[(?:画像|動画|スタンプ)\]\s*$/.test(t.text));
    if ((r.verdict_detail ?? {}).path !== "返信" || !burst.length) continue;
    await push(r.conversation_id, burst[0].at, burst.map((t) => t.text).join("\n"), "watch");
  }
  const e = await sb.from("ai_reply_examples").select("conversation_id, sent_at, created_at, ai_draft, sent_reply, aix_action").eq("entry_source", "line_reply").gte("created_at", since).not("ai_draft", "is", null).order("created_at", { ascending: false }).limit(1000);
  for (const r of (e.data ?? []) as Array<{ conversation_id: string; sent_at: string | null; created_at: string; sent_reply: string | null; aix_action: string | null }>) {
    if (r.aix_action) continue;
    await push(r.conversation_id, r.sent_at ?? r.created_at, r.sent_reply ?? "", "example");
  }
  mkdirSync("scripts/.replay-out", { recursive: true });
  writeFileSync(OUT, out.map((x) => JSON.stringify(x)).join("\n") + "\n");
  console.log(`番 ${out.length}: ${[...count].map(([k, v]) => `${k}=${v}`).join(" ")}`);
  console.log(`外した: ${[...skipped].map(([k, v]) => `${k} ${v}`).join("・")}`);
  console.log(`書き出し: ${OUT}`);
})();
