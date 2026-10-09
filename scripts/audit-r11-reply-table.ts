// scripts/audit-r11-reply-table.ts — 11巡目: 竹内さんの手打ちの送信を正解に、本番の AI の下書きとの一致率を「小場面 × 差の型」で出す（読むだけ・LLM なし）
//   材料: line_watch_turns（見張り・返信の道・下書きあり）＋ ai_reply_examples（送る時に入力欄にあった下書き）。重なりは会話＋時刻±3分で1つ。
//   正解: 返事のまとまりの最初の通の messages.staff_writer='takeuchi'（端末・文の癖で埋めた列）。従業員の送信は数えない（書き方の正解にしない・10/08 竹内さん）。
//   外す: テスト・身内／申込以降／③スタッフだけが知る報告（AIX の番）／画像だけ／AIX の送信。
//   場面: 語の場面（reply-scene）と、ブレインの判断を主にした場面（reply-scene-brain・本番の brain_decision_logs.digest）の両方。小場面は reply-subscene
// 実行: npx tsx --env-file=.env.local scripts/audit-r11-reply-table.ts [--days=40] [--scene=brain|word] [--min=3] [--out=scripts/.replay-out/r11-table-prod.jsonl]
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";
import { isTestConversation } from "../app/lib/test-conversations";
import { cleanDraft } from "../app/lib/line-watch-judge";
import { isStaffOnlyReport } from "../app/lib/text-diff-types";
import { subSceneOf } from "../app/lib/reply-subscene";
import { resolveReplySceneBrainFirst } from "../app/lib/reply-scene-brain";
import { printTable, type TablePair } from "./lib/r11-table";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const DAYS = Number(arg("days", "40"));
const SCENE = arg("scene", "brain");
const MIN = Number(arg("min", "3"));
const OUT = arg("out", "");
const WRITER = arg("writer", "takeuchi");
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
async function readAll<T>(q: (f: number, t: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < 300_000; i += 1000) { const r = await q(i, i + 999); if (r.error) throw new Error(r.error.message); const d = (r.data ?? []) as T[]; out.push(...d); if (d.length < 1000) break; }
  return out;
}
type Msg = { conversation_id: string; sender: string; created_at: string; text: string | null; is_aix_generated: boolean | null; staff_writer: string | null };
type Digest = { intent?: string | null; q?: string[]; aix?: string | null; cond?: string | null; hes?: string | null };

async function main() {
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  const [ex, watch, msgs, decs, ap] = await Promise.all([
    readAll<{ conversation_id: string; sent_at: string | null; created_at: string; ai_draft: string | null; sent_reply: string | null; aix_action: string | null }>((f, t) =>
      sb.from("ai_reply_examples").select("conversation_id, sent_at, created_at, ai_draft, sent_reply, aix_action").eq("entry_source", "line_reply").gte("created_at", since).order("created_at").range(f, t)),
    readAll<{ conversation_id: string; customer_turn_at: string; customer_last_at: string | null; draft_last: string | null; draft_first: string | null; staff_texts: Array<{ at: string; text: string; burst: boolean }> | null; verdict_detail: Record<string, unknown> | null }>((f, t) =>
      sb.from("line_watch_turns").select("conversation_id, customer_turn_at, customer_last_at, draft_last, draft_first, staff_texts, verdict_detail").gte("customer_turn_at", since).order("customer_turn_at").range(f, t)),
    readAll<Msg>((f, t) => sb.from("messages").select("conversation_id, sender, created_at, text, is_aix_generated, staff_writer").gte("created_at", new Date(Date.parse(since) - 5 * 86_400_000).toISOString()).order("created_at").order("id").range(f, t)),
    readAll<{ conversation_id: string; analyzed_msg_ts: string | null; suggested_action: string | null; suggested_reply_mode: string | null; digest: Digest | null }>((f, t) =>
      sb.from("brain_decision_logs").select("conversation_id, analyzed_msg_ts, suggested_action, suggested_reply_mode, digest").gte("created_at", new Date(Date.parse(since) - 86_400_000).toISOString()).order("created_at").range(f, t)),
    readAll<{ conversation_id: string; created_at: string }>((f, t) => sb.from("aix_usage_logs").select("conversation_id, created_at").eq("aix_type", "application_push").order("created_at").range(f, t)),
  ]);
  const applied = new Map<string, number>(); for (const a of ap) if (!applied.has(a.conversation_id)) applied.set(a.conversation_id, Date.parse(a.created_at));
  const mBy = new Map<string, Msg[]>(); for (const m of msgs) { if (!mBy.has(m.conversation_id)) mBy.set(m.conversation_id, []); mBy.get(m.conversation_id)!.push(m); }
  const dBy = new Map<string, typeof decs>(); for (const d of decs) { if (!d.analyzed_msg_ts) continue; if (!dBy.has(d.conversation_id)) dBy.set(d.conversation_id, []); dBy.get(d.conversation_id)!.push(d); }
  /** 送信時刻の手前のお客様の連投・その前のこちらの文・書き手 */
  const ctx = (cid: string, staffAt: string, staffText: string) => {
    const list = mBy.get(cid) ?? []; const T = Date.parse(staffAt);
    const sm = list.find((m) => m.sender === "staff" && Math.abs(Date.parse(m.created_at) - T) < 90_000 && (m.text ?? "").trim() && staffText.includes((m.text ?? "").trim().slice(0, 20)));
    let i = list.length - 1; while (i >= 0 && Date.parse(list[i].created_at) >= T - 1000) i--;
    while (i >= 0 && list[i].sender !== "customer") i--;
    const lastCustAt = i >= 0 ? list[i].created_at : null;
    const cust: string[] = []; while (i >= 0 && list[i].sender === "customer") { cust.unshift(list[i].text ?? ""); i--; }
    while (i >= 0 && (list[i].sender === "customer" || !(list[i].text ?? "").trim() || /^\s*\[(?:画像|動画|スタンプ)\]\s*$/.test(list[i].text ?? ""))) i--;
    return { writer: sm?.staff_writer ?? null, isAix: !!sm?.is_aix_generated, customer: cust.join("\n"), prev: i >= 0 ? list[i].text ?? "" : "", lastCustAt };
  };
  type P = { cid: string; at: string; draft: string; staff: string };
  const raw: P[] = [];
  for (const e of ex) {
    if (e.aix_action) continue;
    const draft = cleanDraft(e.ai_draft).text ?? "", staff = (e.sent_reply ?? "").trim();
    if (draft && staff) raw.push({ cid: e.conversation_id, at: e.sent_at ?? e.created_at, draft, staff });
  }
  for (const w of watch) {
    const vd = w.verdict_detail ?? {};
    if (vd.path !== "返信" || vd.draft_src === "stale" || vd.draft_src === "none") continue;
    const draft = cleanDraft(vd.draft_src === "first" ? w.draft_first : w.draft_last).text ?? "";
    const burst = (w.staff_texts ?? []).filter((t) => t.burst);
    if (!draft || !burst.length) continue;
    const at = burst[0].at;
    if (raw.some((p) => p.cid === w.conversation_id && Math.abs(Date.parse(p.at) - Date.parse(at)) < 180_000)) continue;
    raw.push({ cid: w.conversation_id, at, draft, staff: burst.map((t) => t.text).join("\n").trim() });
  }
  const skip = new Map<string, number>(); const sk = (k: string) => skip.set(k, (skip.get(k) ?? 0) + 1);
  const pairsBrain: TablePair[] = [], pairsWord: TablePair[] = [], outRows: unknown[] = [];
  let changed = 0;
  for (const p of raw) {
    if (isTestConversation(p.cid)) { sk("テスト"); continue; }
    const a = applied.get(p.cid); if (a && a <= Date.parse(p.at)) { sk("申込以降"); continue; }
    if (isStaffOnlyReport(p.staff)) { sk("③スタッフだけが知る報告"); continue; }
    if (/^\s*\[(?:画像|動画|スタンプ)\]\s*$/.test(p.staff)) { sk("画像だけ"); continue; }
    const c = ctx(p.cid, p.at, p.staff);
    if (c.isAix) { sk("AIX の送信"); continue; }
    if (WRITER !== "all" && c.writer !== WRITER) { sk(`書き手 ${c.writer ?? "不明"}`); continue; }
    if (!c.customer.trim()) { sk("お客様の発言なし"); continue; }
    const dec = c.lastCustAt ? (dBy.get(p.cid) ?? []).filter((d) => Math.abs(Date.parse(d.analyzed_msg_ts!) - Date.parse(c.lastCustAt!)) < 3000).pop() ?? null : null;
    const g = dec?.digest ?? null;
    const r = resolveReplySceneBrainFirst({ customerText: c.customer, brain: g && (g.intent !== undefined || Array.isArray(g.q)) ? { fresh: true, intent: g.intent ?? null, questions: g.q ?? [], conditionChangeType: g.cond ?? null, hesitancy: g.hes ?? null, action: dec!.suggested_reply_mode === "aix" ? dec!.suggested_action : (g.aix ?? null) } : null });
    if (r.scene !== r.wordScene) changed++;
    const subB = subSceneOf({ customerText: c.customer, prevStaffText: c.prev, scene: r.scene });
    const subW = subSceneOf({ customerText: c.customer, prevStaffText: c.prev });
    pairsBrain.push({ sub: subB, draft: p.draft, staff: p.staff, id: `${p.cid.slice(0, 8)}|${p.at}` });
    pairsWord.push({ sub: subW, draft: p.draft, staff: p.staff });
    outRows.push({ cid: p.cid, at: p.at, customer: c.customer, prev: c.prev, subBrain: subB, subWord: subW, sceneSrc: r.source, draft: p.draft, staff: p.staff, brain: g ? { intent: g.intent, q: g.q, cond: g.cond, hes: g.hes } : null });
  }
  console.log(`組 ${raw.length} → 竹内さんの手打ちの返信 ${pairsBrain.length}（${DAYS}日）・ブレインで場面が変わった ${changed}`);
  console.log("外した: " + [...skip.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join("・"));
  if (SCENE === "word" || SCENE === "both") printTable("語の場面の小場面 × 差の型（本番の下書き×竹内さんの手打ち）", pairsWord, MIN);
  if (SCENE === "brain" || SCENE === "both") printTable("ブレインに寄せた場面の小場面 × 差の型（本番の下書き×竹内さんの手打ち）", pairsBrain, MIN);
  if (OUT) { writeFileSync(OUT, outRows.map((o) => JSON.stringify(o)).join("\n")); console.log(`\n書き出し ${OUT}（${outRows.length}行）`); }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
