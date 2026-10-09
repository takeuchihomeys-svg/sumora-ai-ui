// scripts/audit-r11-style-exits.ts — 11巡目: 書き方の出口の案（①開口語の後の空行を詰める ②行末の絵文字の後に！！）を
//   (a) 竹内さんの手打ちの返信（120日）に当てて何通変わるか（＝人の文を変える数）、(b) 本番の下書き（r11-table-prod）に当てて竹内さんの送信との一致が上がるか、を数える（読むだけ・LLM なし）
//   10/08 の結果: (a) 0.9%・1.0% (b) 275組で変わる 13組・差の型 減る2・増える4・完全一致 0→0 ＝効き目が無いので本番には入れなかった（app/lib/reply-style-r11.ts）
// 実行: npx tsx --env-file=.env.local scripts/audit-r11-style-exits.ts [--days=120] [--show=10]
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { isTestConversation } from "../app/lib/test-conversations";
import { isStaffOnlyReport, diffTexts } from "../app/lib/text-diff-types";
import { resolveReplyScene } from "../app/lib/reply-scene";

const E = "[\\p{Extended_Pictographic}\\u{FE0F}\\u{200D}\\u{1F3FB}-\\u{1F3FF}]";
const OPENER_LINE_RE = new RegExp("^(?:はい|かしこまりました|承知(?:いた|致)?しました)" + E + "*[！!。]*$", "u");
const NAME_LINE_RE = /^[^\n、！!。？?]{1,14}(?:さん|様)[、,！!]*$/;
const OSEWA_LINE_RE = /^(?:[^\n、！!。？?]{1,14}(?:さん|様)[、,\s]*)?お世話になっております[\p{Extended_Pictographic}\u{FE0F}]*[！!。]*$/u;
function collapseOpenerBlank(text: string, scene: string): { text: string; changed: boolean } {
  if (!text || !["ack", "question", "viewing"].includes(scene)) return { text, changed: false };
  const lines = text.split("\n"); let i = 0;
  while (i < lines.length && (NAME_LINE_RE.test(lines[i].trim()) || OSEWA_LINE_RE.test(lines[i].trim()) || !lines[i].trim())) i++;
  if (i >= lines.length || !OPENER_LINE_RE.test(lines[i].trim())) return { text, changed: false };
  let j = i + 1; while (j < lines.length && !lines[j].trim()) j++;
  if (j === i + 1 || j >= lines.length) return { text, changed: false };
  return { text: [...lines.slice(0, i + 1), ...lines.slice(j)].join("\n"), changed: true };
}
const LINE_END_EMOJI_RE = new RegExp(E + "+$", "u");
function ensureEmojiBang(text: string): { text: string; changed: number } {
  let changed = 0;
  const out = text.split("\n").map((l) => {
    const t = l.replace(/[ \t　]+$/, ""); if (!LINE_END_EMOJI_RE.test(t)) return l;
    const body = t.replace(LINE_END_EMOJI_RE, "");
    if (!body.trim() || /[？?♪！!]$/.test(body) || /^\s*(?:🌟|【|★|・)/u.test(t) || /https?:\/\//.test(t)) return l;
    changed++; return t + "！！";
  });
  return { text: out.join("\n"), changed };
}

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const DAYS = Number(arg("days", "120")), SHOW = Number(arg("show", "10"));
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
(async () => {
  const msgs: Array<{ conversation_id: string; sender: string; created_at: string; text: string | null; is_aix_generated: boolean | null; staff_writer: string | null }> = [];
  for (let i = 0; ; i += 1000) { const r = await sb.from("messages").select("conversation_id, sender, created_at, text, is_aix_generated, staff_writer").gte("created_at", new Date(Date.now() - DAYS * 864e5).toISOString()).order("created_at").order("id").range(i, i + 999); if (r.error) throw r.error; msgs.push(...(r.data ?? []) as typeof msgs); if ((r.data ?? []).length < 1000) break; }
  const by = new Map<string, typeof msgs>(); for (const m of msgs) { if (!by.has(m.conversation_id)) by.set(m.conversation_id, []); by.get(m.conversation_id)!.push(m); }
  let n = 0, chA = 0, chB = 0; const exA: string[] = [], exB: string[] = [];
  for (const [cid, list] of by) {
    if (isTestConversation(cid)) continue;
    for (let i = 1; i < list.length; i++) {
      const m = list[i]; if (m.sender !== "staff" || m.is_aix_generated || m.staff_writer !== "takeuchi" || list[i - 1].sender !== "customer") continue;
      const tx = (m.text ?? "").trim(); if (!tx || /^\[/.test(tx) || isStaffOnlyReport(tx)) continue;
      let j = i - 1; const c: string[] = []; while (j >= 0 && list[j].sender === "customer") { c.unshift(list[j].text ?? ""); j--; }
      const sc = resolveReplyScene({ customerText: c.join("\n") }).scene;
      n++;
      const a = collapseOpenerBlank(tx, sc); if (a.changed) { chA++; if (exA.length < SHOW) exA.push(`[${sc}] ${tx.replace(/\n/g, "⏎").slice(0, 90)}`); }
      const b = ensureEmojiBang(tx); if (b.changed) { chB++; if (exB.length < SHOW) exB.push(`[${sc}] ${tx.replace(/\n/g, "⏎").slice(0, 120)}`); }
    }
  }
  console.log(`(a) 竹内さんの手打ち ${n}通: ①空行を詰める ${chA}通（${(100 * chA / n).toFixed(1)}%）・②！！を足す ${chB}通（${(100 * chB / n).toFixed(1)}%）`);
  for (const e of exA) console.log("  ①", e); for (const e of exB) console.log("  ②", e);
  const rows = readFileSync("scripts/.replay-out/r11-table-prod.jsonl", "utf8").trim().split("\n").map((l) => JSON.parse(l) as { subBrain: string; draft: string; staff: string });
  let up = 0, down = 0, same0 = 0, same1 = 0, ch = 0; const exC: string[] = [];
  for (const r of rows) {
    let d = r.draft; d = collapseOpenerBlank(d, r.subBrain.split(":")[0]).text; d = ensureEmojiBang(d).text;
    if (d === r.draft) continue; ch++;
    const before = diffTexts(r.draft, r.staff), after = diffTexts(d, r.staff);
    if (before.same) same0++; if (after.same) same1++;
    if (after.types.length < before.types.length) up++; else if (after.types.length > before.types.length) { down++; if (exC.length < SHOW) exC.push(`[${r.subBrain}] D:${r.draft.replace(/\n/g, "⏎").slice(0, 80)}｜S:${r.staff.replace(/\n/g, "⏎").slice(0, 80)}`); }
  }
  console.log(`(b) 本番の下書き ${rows.length}組で変わる ${ch}組: 差の型が減る ${up}・増える ${down}・完全一致 ${same0}→${same1}`);
  for (const e of exC) console.log("  増", e);
})().catch((e) => { console.error(e); process.exitCode = 1; });
