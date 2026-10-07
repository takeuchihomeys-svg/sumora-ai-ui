// scripts/audit-path-gap-by-scene.ts — 3巡目（10/07）: 「返信か AIX か」の道の違いを返信の場面（reply-scene）ごとに数える（読むだけ・LLM なし）
//   本番のブレインの最後の判断（brain_decision_logs・番ごと）× スタッフの返事のまとまり（line-watch-judge.staffWindowOf）。
//   道: ブレイン＝reply_mode が aix なら その AIX・それ以外は返信／スタッフ＝まとまりで AIX を押した→その AIX・押さず手打ち→返信
//   申込以降・テストの会話・スタッフが何も送っていない番は数えない。
// 実行: npx tsx --env-file=.env.local scripts/audit-path-gap-by-scene.ts [--days=30] [--since=2026-10-03] [--out=<jsonl>]
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";
import { staffWindowOf, type WindowMsg, type WindowPress } from "../app/lib/line-watch-judge";
import { isTestConversation } from "../app/lib/test-conversations";
import { resolveReplyScene, type ReplyScene } from "../app/lib/reply-scene";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const DAYS = Number(arg("days", "30"));
const SINCE = arg("since", new Date(Date.now() - DAYS * 86_400_000).toISOString());
const OUT = arg("out");
type M = WindowMsg & { conversation_id: string };
type P = WindowPress & { conversation_id: string };
type D = { conversation_id: string; created_at: string; analyzed_msg_ts: string | null; suggested_action: string | null; suggested_reply_mode: string | null; decision_source: string | null; conversation_status: string | null };
async function readAll<T>(q: (f: number, t: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = []; for (let i = 0; i < 400_000; i += 1000) { const r = await q(i, i + 999); if (r.error) throw new Error(r.error.message); const d = (r.data ?? []) as T[]; out.push(...d); if (d.length < 1000) break; } return out;
}
const POST = /^(?:applying|application|screening|contract|approved|closed_won)$/;
const PROP = /^property_(send|recommendation|pickup)$/;
const sameAix = (a: string, b: string) => a === b || (PROP.test(a) && PROP.test(b));

(async () => {
  const since = SINCE;
  const [msgs, presses, decs] = await Promise.all([
    readAll<M>((f, t) => sb.from("messages").select("conversation_id, sender, created_at, text, is_aix_generated").gte("created_at", new Date(Date.parse(since) - 3 * 86_400_000).toISOString()).order("created_at").order("id").range(f, t)),
    readAll<P>((f, t) => sb.from("aix_usage_logs").select("conversation_id, aix_type, check_pattern, created_at").gte("created_at", new Date(Date.parse(since) - 60 * 86_400_000).toISOString()).not("aix_type", "is", null).order("created_at").range(f, t)),
    readAll<D>((f, t) => sb.from("brain_decision_logs").select("conversation_id, created_at, analyzed_msg_ts, suggested_action, suggested_reply_mode, decision_source, conversation_status").gte("created_at", since).order("created_at").range(f, t)),
  ]);
  const by = <T extends { conversation_id: string }>(rows: T[]) => { const mp = new Map<string, T[]>(); for (const r of rows) { if (!mp.has(r.conversation_id)) mp.set(r.conversation_id, []); mp.get(r.conversation_id)!.push(r); } return mp; };
  const mBy = by(msgs), pBy = by(presses);
  const last = new Map<string, D>();
  for (const d of decs) { if (!d.analyzed_msg_ts || isTestConversation(d.conversation_id)) continue; last.set(`${d.conversation_id}|${d.analyzed_msg_ts}`, d); }
  type Cell = { n: number; agree: number; aiReplyStaffAix: Map<string, number>; aiAixStaffReply: Map<string, number>; otherAix: number };
  const cells = new Map<string, Cell>();
  const rows: unknown[] = [];
  for (const d of last.values()) {
    const ps = pBy.get(d.conversation_id) ?? [];
    if (POST.test(d.conversation_status ?? "") || ps.some((p) => p.aix_type === "application_push" && p.created_at <= d.analyzed_msg_ts!)) continue;
    const ms = mBy.get(d.conversation_id) ?? [];
    const w = staffWindowOf({ customerTurnAt: d.analyzed_msg_ts!, msgs: ms, presses: ps });
    if (!w.closed) continue;
    const bp = [...new Set(w.presses.filter((p) => p.burst).map((p) => p.aix_type))];
    const bt = w.texts.filter((t) => t.burst).map((t) => t.text).join("\n");
    if (!bp.length && !bt) continue;
    // お客様の番＝分析した発言の時刻から、最初のスタッフの発言の前まで
    const firstStaff = ms.find((m) => m.sender !== "customer" && m.created_at > d.analyzed_msg_ts!)?.created_at ?? "9999";
    const turnMsgs = ms.filter((m) => m.sender === "customer" && m.created_at <= d.analyzed_msg_ts! && m.created_at < firstStaff);
    // 連投: 分析した時刻から遡ってスタッフの発言が出るまで
    const before = ms.filter((m) => m.created_at <= d.analyzed_msg_ts!);
    const burst: string[] = [];
    for (let i = before.length - 1; i >= 0; i--) { if (before[i].sender !== "customer") break; burst.unshift(before[i].text ?? ""); }
    const text = (burst.length ? burst : turnMsgs.map((m) => m.text ?? "")).join("\n");
    const scene: ReplyScene = resolveReplyScene({ customerText: text }).scene;
    const brain = d.suggested_reply_mode === "aix" && d.suggested_action ? d.suggested_action : "reply";
    const staff = bp.length ? bp : ["reply"];
    const agree = brain === "reply" ? !bp.length : bp.some((a) => sameAix(a, brain));
    const c = cells.get(scene) ?? { n: 0, agree: 0, aiReplyStaffAix: new Map(), aiAixStaffReply: new Map(), otherAix: 0 };
    c.n++; if (agree) c.agree++;
    else if (brain === "reply") for (const a of bp) c.aiReplyStaffAix.set(a, (c.aiReplyStaffAix.get(a) ?? 0) + 1);
    else if (!bp.length) c.aiAixStaffReply.set(brain, (c.aiAixStaffReply.get(brain) ?? 0) + 1);
    else c.otherAix++;
    cells.set(scene, c);
    rows.push({ conv: d.conversation_id, at: d.analyzed_msg_ts, scene, brain, src: d.decision_source, staff, staffCp: [...new Set(w.presses.filter((p) => p.burst && p.check_pattern).map((p) => `${p.aix_type}:${p.check_pattern}`))], agree, customer: text.slice(0, 300), staffText: bt.slice(0, 300) });
  }
  const all = [...cells.values()].reduce((a, c) => ({ n: a.n + c.n, agree: a.agree + c.agree }), { n: 0, agree: 0 });
  console.log(`本番の判断（${since.slice(0, 10)}〜・スタッフが返事をした番・申込以降を除く）${all.n}: 道の一致 ${all.agree}（${((all.agree / Math.max(1, all.n)) * 100).toFixed(0)}%）`);
  const fmt = (m: Map<string, number>) => [...m].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join("・") || "-";
  for (const [s, c] of [...cells].sort((a, b) => b[1].n - a[1].n)) {
    const r = (x: number) => `${x}（${Math.round((x / c.n) * 100)}%）`;
    const a2r = [...c.aiAixStaffReply.values()].reduce((x, y) => x + y, 0), r2a = [...c.aiReplyStaffAix.values()].reduce((x, y) => x + y, 0);
    console.log(`  ${s.padEnd(15)} n=${String(c.n).padStart(3)} 一致 ${r(c.agree)}｜AI=AIX→人=返信 ${r(a2r)} [${fmt(c.aiAixStaffReply)}]｜AI=返信→人=AIX ${r(r2a)} [${fmt(c.aiReplyStaffAix)}]｜別の AIX ${c.otherAix}`);
  }
  if (OUT) writeFileSync(OUT, rows.map((r) => JSON.stringify(r)).join("\n"));
})().catch((e) => { console.error(e); process.exit(1); });
