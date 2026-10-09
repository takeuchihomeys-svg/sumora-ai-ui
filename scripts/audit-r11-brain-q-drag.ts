// scripts/audit-r11-brain-q-drag.ts — 11巡目（10/08 竹内「場面の読み取りを、ブレインの判断に寄せる」）:
//   ブレインの質問欄（customer_questions）が「今の番（最後のスタッフ発言より後の連投）」でなく前の発言の質問を引きずっていないかを数える（読むだけ・LLM なし）。
//   質問1つずつ、今の番の文と前の発言（最後のスタッフ発言より前・14日）にどれだけ語が重なるかを比べる（app/lib/reply-scene-brain.questionTurnOverlap）。
//   出す物: 引きずりの件数・例・その番でスタッフが前の質問に答えたか（答えた＝まだ応えていない質問・答えていない＝すでに応えた質問の引きずり）
// 実行: npx tsx --env-file=.env.local scripts/audit-r11-brain-q-drag.ts [--days=40] [--show=40] [--out=scripts/.replay-out/r11-q-drag.jsonl]
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";
import { isTestConversation } from "../app/lib/test-conversations";
import { questionTurnOverlap, splitThisTurnQuestions } from "../app/lib/reply-scene-brain";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=").slice(1).join("=");
const DAYS = Number(arg("days", "40"));
const SHOW = Number(arg("show", "40"));
const OUT = arg("out", "");
async function readAll<T>(q: (f: number, t: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < 600_000; i += 1000) { const r = await q(i, i + 999); if (r.error) throw new Error(r.error.message); const d = (r.data ?? []) as T[]; out.push(...d); if (d.length < 1000) break; }
  return out;
}
const one = (s: string, n = 60) => s.replace(/\s+/g, " ").slice(0, n);
type Msg = { conversation_id: string; sender: string; created_at: string; text: string | null };

async function main() {
  const since = new Date(Date.now() - (DAYS + 15) * 86_400_000).toISOString();
  const decSince = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  const [msgs, decs] = await Promise.all([
    readAll<Msg>((f, t) => sb.from("messages").select("conversation_id, sender, created_at, text").gte("created_at", since).order("created_at").order("id").range(f, t)),
    readAll<{ conversation_id: string; analyzed_msg_ts: string | null; digest: { q?: string[] } | null }>((f, t) => sb.from("brain_decision_logs").select("conversation_id, analyzed_msg_ts, digest").gte("created_at", decSince).order("created_at").range(f, t)),
  ]);
  const mBy = new Map<string, Msg[]>();
  for (const m of msgs) { if (!mBy.has(m.conversation_id)) mBy.set(m.conversation_id, []); mBy.get(m.conversation_id)!.push(m); }
  const last = new Map<string, (typeof decs)[number]>();
  for (const d of decs) if (d.analyzed_msg_ts && !isTestConversation(d.conversation_id)) last.set(`${d.conversation_id}|${d.analyzed_msg_ts}`, d);
  let turns = 0, withQ = 0, qN = 0, dragged = 0, turnsDragged = 0, allDragged = 0;
  const ex: string[] = []; const out: unknown[] = [];
  let answeredByStaff = 0;
  for (const d of last.values()) {
    const qs = Array.isArray(d.digest?.q) ? d.digest!.q!.filter((x) => typeof x === "string" && x.trim()) : [];
    const ms = mBy.get(d.conversation_id) ?? [];
    const T = Date.parse(d.analyzed_msg_ts!);
    const upto = ms.filter((m) => Date.parse(m.created_at) <= T + 1000);
    let k = upto.length - 1; const burst: string[] = [];
    while (k >= 0 && upto[k].sender === "customer") { burst.unshift(upto[k].text ?? ""); k--; }
    if (!burst.length) continue;
    turns++;
    if (!qs.length) continue;
    withQ++;
    const earlier = upto.slice(Math.max(0, k - 40), k + 1).filter((m) => m.sender === "customer" && Date.parse(m.created_at) >= T - 14 * 86_400_000).map((m) => m.text ?? "");
    const sp = splitThisTurnQuestions(qs, burst.join("\n"));
    qN += qs.length; dragged += sp.dragged.length;
    if (sp.dragged.length) {
      turnsDragged++; if (!sp.kept.length) allDragged++;
      // その番の後のスタッフの文（24時間・次のお客様の発言まで）に前の質問の語があるか＝まだ応えていなかった質問に答えたか
      const after = ms.filter((m) => Date.parse(m.created_at) > T + 1000);
      const staffAfter: string[] = []; for (const m of after) { if (m.sender === "customer") break; if (Date.parse(m.created_at) - T > 86_400_000) break; staffAfter.push(m.text ?? ""); }
      const ans = sp.dragged.some((q) => questionTurnOverlap(q, staffAfter.join("\n")) >= 0.34);
      if (ans) answeredByStaff++;
      if (ex.length < SHOW) ex.push(`${d.conversation_id.slice(0, 8)} ${d.analyzed_msg_ts!.slice(5, 16)}｜今の番:${one(burst.join(" / "))}｜引きずり:${sp.dragged.map((q) => one(q, 40)).join("・")}｜残す:${sp.kept.map((q) => one(q, 30)).join("・") || "-"}｜スタッフ${ans ? "答えた" : "-"}:${one(staffAfter.join(" / "), 50)}`);
      out.push({ cid: d.conversation_id, at: d.analyzed_msg_ts, burst, earlier: earlier.slice(-4), dragged: sp.dragged, kept: sp.kept, staffAfter, answered: ans });
    }
  }
  console.log(`番 ${turns}（${DAYS}日・番ごとの最後の判断・テストを除く）・質問ありの番 ${withQ}・質問 ${qN}`);
  console.log(`今の番に無い質問（引きずり）${dragged}（${Math.round((100 * dragged) / Math.max(1, qN))}%）・その番 ${turnsDragged}（全部引きずり ${allDragged}）・その後スタッフが前の質問に答えた番 ${answeredByStaff}`);
  for (const e of ex) console.log("  " + e);
  if (OUT) { writeFileSync(OUT, out.map((o) => JSON.stringify(o)).join("\n")); console.log(`書き出し ${OUT}（${out.length}行）`); }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
