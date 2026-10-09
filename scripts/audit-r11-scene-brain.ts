// scripts/audit-r11-scene-brain.ts — 11巡目: 返信の場面を「語だけ」→「ブレインの判断を主に」（app/lib/reply-scene-brain.ts）に変えた時、
//   どの番の場面が変わるかを本番のブレインの判断（brain_decision_logs.digest＝Claude）で数え、変わる番を1番ずつ読む（読むだけ・LLM なし）。
//   スタッフの実際（返事のまとまりの手打ち・押した AIX・書き手）を並べる＝どちらの場面がスタッフのした事に近いかを目で確かめる。
// 実行: npx tsx --env-file=.env.local scripts/audit-r11-scene-brain.ts [--days=40] [--show=15] [--out=scripts/.replay-out/r11-scene-brain.jsonl]
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";
import { staffWindowOf, type WindowMsg, type WindowPress } from "../app/lib/line-watch-judge";
import { isTestConversation } from "../app/lib/test-conversations";
import { resolveReplySceneBrainFirst } from "../app/lib/reply-scene-brain";
import { subSceneOf } from "../app/lib/reply-subscene";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=").slice(1).join("=");
const DAYS = Number(arg("days", "40"));
const SHOW = Number(arg("show", "15"));
const OUT = arg("out", "");
async function readAll<T>(q: (f: number, t: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < 600_000; i += 1000) { const r = await q(i, i + 999); if (r.error) throw new Error(r.error.message); const d = (r.data ?? []) as T[]; out.push(...d); if (d.length < 1000) break; }
  return out;
}
const one = (s: string, n = 70) => s.replace(/\s+/g, " ").slice(0, n);
type Msg = WindowMsg & { conversation_id: string; staff_writer?: string | null };
type Press = WindowPress & { conversation_id: string };
type Digest = { intent?: string | null; q?: string[]; aix?: string | null; dir?: string | null; cond?: string | null; hes?: string | null };

async function main() {
  const since = new Date(Date.now() - (DAYS + 30) * 86_400_000).toISOString();
  const decSince = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  const [msgs, presses, decs] = await Promise.all([
    readAll<Msg>((f, t) => sb.from("messages").select("conversation_id, sender, created_at, text, is_aix_generated, staff_writer").gte("created_at", since).order("created_at").order("id").range(f, t)),
    readAll<Press>((f, t) => sb.from("aix_usage_logs").select("conversation_id, aix_type, check_pattern, created_at").gte("created_at", since).not("aix_type", "is", null).order("created_at").range(f, t)),
    readAll<{ conversation_id: string; analyzed_msg_ts: string | null; suggested_action: string | null; suggested_reply_mode: string | null; decision_source: string | null; digest: Digest | null }>((f, t) => sb.from("brain_decision_logs").select("conversation_id, analyzed_msg_ts, suggested_action, suggested_reply_mode, decision_source, digest").gte("created_at", decSince).order("created_at").range(f, t)),
  ]);
  const by = <T extends { conversation_id: string }>(rows: T[]) => { const m = new Map<string, T[]>(); for (const r of rows) { if (!m.has(r.conversation_id)) m.set(r.conversation_id, []); m.get(r.conversation_id)!.push(r); } return m; };
  const mBy = by(msgs), pBy = by(presses);
  const last = new Map<string, (typeof decs)[number]>();
  for (const d of decs) if (d.analyzed_msg_ts && !isTestConversation(d.conversation_id)) last.set(`${d.conversation_id}|${d.analyzed_msg_ts}`, d);
  const trans = new Map<string, { n: number; tk: number; ex: string[] }>();
  const srcCount = new Map<string, number>();
  const out: unknown[] = [];
  let n = 0;
  for (const d of last.values()) {
    const ps = pBy.get(d.conversation_id) ?? [];
    const applyAt = ps.find((p) => p.aix_type === "application_push")?.created_at;
    if (applyAt && Date.parse(d.analyzed_msg_ts!) >= Date.parse(applyAt)) continue;
    const ms = mBy.get(d.conversation_id) ?? [];
    const T = Date.parse(d.analyzed_msg_ts!);
    const upto = ms.filter((m) => Date.parse(m.created_at) <= T + 1000);
    let k = upto.length - 1; const burst: string[] = [];
    while (k >= 0 && upto[k].sender === "customer") { burst.unshift(upto[k].text ?? ""); k--; }
    if (!burst.length) continue;
    n++;
    const prevStaff = upto.slice(0, k + 1).reverse().find((m) => m.sender === "staff" && (m.text ?? "").trim() && !/^\s*\[(?:画像|動画|スタンプ|ファイル)\]\s*$/.test(m.text ?? ""))?.text ?? "";
    const g = d.digest ?? {};
    const aix = d.suggested_reply_mode === "aix" ? d.suggested_action : (g.aix ?? null);
    const r = resolveReplySceneBrainFirst({ customerText: burst.join("\n"), brain: { fresh: g.intent !== undefined || Array.isArray(g.q), intent: g.intent ?? null, questions: Array.isArray(g.q) ? g.q : [], conditionChangeType: g.cond ?? null, hesitancy: g.hes ?? null, action: aix, replyMode: d.suggested_reply_mode } });
    srcCount.set(r.source, (srcCount.get(r.source) ?? 0) + 1);
    if (r.scene === r.wordScene) continue;
    const w = staffWindowOf({ customerTurnAt: d.analyzed_msg_ts!, msgs: ms, presses: ps });
    const bt = w.texts.filter((t) => t.burst);
    const writer = ms.find((m) => m.sender === "staff" && bt.some((t) => t.at === m.created_at))?.staff_writer ?? null;
    const key = `${r.wordScene}→${r.scene}`;
    const c = trans.get(key) ?? { n: 0, tk: 0, ex: [] }; c.n++; if (writer === "takeuchi") c.tk++;
    const sub = subSceneOf({ customerText: burst.join("\n"), prevStaffText: prevStaff, scene: r.scene });
    if (c.ex.length < SHOW) c.ex.push(`${d.conversation_id.slice(0, 8)} ${d.analyzed_msg_ts!.slice(5, 16)}｜C:${one(burst.join(" / "))}｜B:${g.intent ?? "-"}/${aix ?? "返信"}/q=${one(r.questions.join("・"), 40)}${r.dragged.length ? `/引:${one(r.dragged.join("・"), 30)}` : ""}/cond=${g.cond ?? "-"}/hes=${g.hes ?? "-"}｜${r.evidence}｜${sub}｜S(${writer ?? "?"}):${w.presses.filter((p) => p.burst).map((p) => p.aix_type).join("+")} ${one(bt.map((t) => t.text).join(" / "), 70)}`);
    trans.set(key, c);
    out.push({ cid: d.conversation_id, at: d.analyzed_msg_ts, burst, prevStaff, word: r.wordScene, wordEv: r.wordEvidence, brainScene: r.scene, ev: r.evidence, brain: { intent: g.intent, q: r.questions, dragged: r.dragged, cond: g.cond, hes: g.hes, aix }, staff: { writer, presses: w.presses.filter((p) => p.burst).map((p) => p.aix_type), text: bt.map((t) => t.text).join("\n") } });
  }
  console.log(`番 ${n}（${DAYS}日・申込以降とテストを除く）・決め方: ${[...srcCount.entries()].map(([k, v]) => `${k} ${v}`).join("・")}・場面が変わる番 ${out.length}（${Math.round((100 * out.length) / Math.max(1, n))}%）`);
  for (const [k, c] of [...trans.entries()].sort((a, b) => b[1].n - a[1].n)) {
    console.log(`\n■ ${k}: ${c.n}番（竹内さん ${c.tk}）`);
    for (const e of c.ex) console.log("  " + e);
  }
  if (OUT) { writeFileSync(OUT, out.map((o) => JSON.stringify(o)).join("\n")); console.log(`\n書き出し ${OUT}（${out.length}行）`); }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
