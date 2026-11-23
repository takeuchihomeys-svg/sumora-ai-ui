// scripts/audit-promise-kept.ts — 信頼の土台（#55）B1: 約束を期限内に果たした割合（読むだけ・LLM を呼ばない・費用0）
//
// 2026-11-21 作業員N（統括役の割り振り・竹内さん 11/15「信頼の土台」・memory/foundation_flex_trust_1121.md）。
//   線は作業員L の約束の取りこぼしの見張り（#435・app/lib/promise-drop-watch.ts）とそろえた（11/21 N と L で決めた）:
//   ・約束 … こちらの手打ちの文（sender=staff・is_aix_generated=false）。種類は promiseKindNameOf（pickup・check・estimate・viewing_slot・callback・other）
//   ・期限 … promiseDeadlineMs（文の期限の言葉があればその日の終わり・無ければ72時間・「出来次第」は期限にしない）
//   ・果たした印 … promiseFulfilledBy（pickup・check・estimate だけ判定・他は判定なし）。物件の送付は売上番長グループへの物出し（line_group）を外す
//   ・外す会話 … promiseClosedConversation（申込以降・お客様が決めた・こちらが締めた）
//   ・分母 … 約束の全部。ただし同じ会話・同じ種類で、果たす前に言い直した約束は1つにまとめる（新しい方の時刻と期限）
//   ・主は全体（誰の番でもお客様への約束・統括役 11/21）。書き手（messages.staff_writer）で分けた数も並べる
// 出すのは数と会話の頭8字だけ（お客様の文・名前は出さない）。DB を読むので 22時〜8時に1本だけ流す。
// 実行: npx tsx --env-file=.env.local scripts/audit-promise-kept.ts [--days=30] [--max-convs=400] [--out=<json>]
import { createClient } from "@supabase/supabase-js";
import { confirmObjectOf } from "../app/lib/action-ledger";
// 2026-11-23 作業員L（#655 の続き）: PROMISE_DROP_CHECK_OBJECT=on か --check-object の時だけ、確認の約束を要件の合う答えでだけ果たした扱い
const CHECK_OBJECT_OF = process.argv.includes("--check-object") || (process.env.PROMISE_DROP_CHECK_OBJECT ?? "").trim().toLowerCase() === "on" ? (t: string) => confirmObjectOf(t) : undefined;
import { writeFileSync } from "node:fs";
import { promiseKindNameOf, promiseInputWaitTurn, promiseDeadlineMs, promiseFulfilledBy, promiseClosedConversation, type PromiseKindName, type PdMsg, type PdAix, type PdSent } from "../app/lib/promise-drop-watch";
import { isTestConversation, isNoLineTestConversation, STAFF_INTERNAL_CONVERSATION_IDS } from "../app/lib/test-conversations";

const argv = process.argv.slice(2);
const arg = (k: string, d = "") => argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;

export type KeptState = "in_time" | "late" | "overdue" | "pending" | "n/a";
export type PromiseRow = { conv: string; at: string; kind: PromiseKindName; writer: string; deadlineBy: "words" | "default72h"; state: KeptState; by: string | null; scene: string };
/** 2026-11-21 台帳 #495: 約束の通を、その前24時間の一番近い見張りの番（お客様の番）に結んで場面を付ける（純関数）。数が足りる3場面は名前で・ほかは「少数」・番が無ければ「番なし」 */
export const MAIN_SCENES = new Set(["返信:条件提示", "返信:質問", "AIX:property_check_result"]);
export function sceneOfPromise(atMs: number, turns: ReadonlyArray<{ at: number; scene: string | null }>): string {
  const t = turns.filter((x) => x.at <= atMs && atMs - x.at <= 86_400_000).sort((a, b) => b.at - a.at)[0];
  if (!t) return "番なし";
  return t.scene && MAIN_SCENES.has(t.scene) ? t.scene : "少数";
}
type Msg = PdMsg & { staff_writer?: string | null };

/** 1会話の約束を並べて判定する（純関数）。同じ種類で果たす前の言い直しは新しい方にまとめる */
export function promisesOf(conv: string, status: string | null, msgs: ReadonlyArray<Msg>, aix: ReadonlyArray<PdAix>, sent: ReadonlyArray<PdSent>, sinceMs: number, nowMs: number, turns: ReadonlyArray<{ at: number; scene: string | null }> = []): PromiseRow[] {
  const raw: Array<{ at: string; kind: PromiseKindName; text: string; writer: string }> = [];
  const ordered = [...msgs].sort((a, b) => a.created_at.localeCompare(b.created_at));
  for (let j = 0; j < ordered.length; j++) {
    const m = ordered[j];
    if (m.sender !== "staff" || m.is_aix_generated || Date.parse(m.created_at) < sinceMs) continue;
    // 同じ番の後ろの通で条件の用紙・ご入力のお願いを送った約束は、お客様の入力待ち（作業員L の promiseInputWaitTurn・#435 と同じ）
    if (promiseInputWaitTurn(ordered, j)) continue;
    const kind = promiseKindNameOf(String(m.text ?? ""));
    if (kind) raw.push({ at: m.created_at, kind, text: String(m.text ?? ""), writer: String(m.staff_writer ?? "unknown") || "unknown" });
  }
  raw.sort((a, b) => a.at.localeCompare(b.at));
  const ev = { msgs, aix, sent };
  const kept: typeof raw = [];
  for (const p of raw) {
    const prev = [...kept].reverse().find((k) => k.kind === p.kind);
    if (prev) {
      const f = promiseFulfilledBy({ at: prev.at, kind: prev.kind, text: prev.text }, ev, { checkObjectOf: CHECK_OBJECT_OF });
      const fAt = f && f !== "n/a" ? Date.parse(f.at) : null;
      // 前の同じ種類の約束が、この言い直しより前に果たされていなければ言い直し＝1つにまとめる（判定なしの種類も同じ）
      if (fAt == null || fAt > Date.parse(p.at)) { kept.splice(kept.indexOf(prev), 1); }
    }
    kept.push(p);
  }
  const out: PromiseRow[] = [];
  for (const p of kept) {
    if (promiseClosedConversation(status, msgs, p.at)) continue;
    const dl = promiseDeadlineMs(p.text, Date.parse(p.at));
    const f = promiseFulfilledBy({ at: p.at, kind: p.kind, text: p.text }, ev, { checkObjectOf: CHECK_OBJECT_OF });
    let state: KeptState;
    if (f === "n/a") state = "n/a";
    else if (f) state = Date.parse(f.at) <= dl.ms ? "in_time" : "late";
    else state = nowMs > dl.ms ? "overdue" : "pending";
    out.push({ conv: conv.slice(0, 8), at: p.at, kind: p.kind, writer: p.writer, deadlineBy: dl.by, state, by: f && f !== "n/a" ? f.by : null, scene: sceneOfPromise(Date.parse(p.at), turns) });
  }
  return out;
}

async function main() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");
  const days = Number(arg("days", "30")) || 30;
  const maxConvs = Number(arg("max-convs", "400")) || 400;
  const nowMs = Date.now();
  const sinceMs = nowMs - days * 86_400_000;
  const since = new Date(sinceMs).toISOString();
  // 約束の言葉の候補がある会話（見張りより広く: 見積・内覧の日程・電話・ご連絡も）
  const convSet = new Set<string>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("messages").select("conversation_id")
      .eq("sender", "staff").eq("is_aix_generated", false).gte("created_at", since).ilike("text", "%させて頂%")
      .order("created_at", { ascending: false }).range(from, from + 999);
    if (error) throw new Error(error.message);
    for (const r of data ?? []) convSet.add((r as { conversation_id: string }).conversation_id);
    if ((data ?? []).length < 1000) break;
  }
  const internal = new Set<string>(STAFF_INTERNAL_CONVERSATION_IDS as readonly string[]);
  const convs = [...convSet].filter((c) => !isTestConversation(c) && !isNoLineTestConversation(c) && !internal.has(c)).slice(0, maxConvs);
  const rows: PromiseRow[] = [];
  const one = async (c: string) => {
    const { data: wt } = await sb.from("line_watch_turns").select("customer_turn_at,scene_key").eq("conversation_id", c).gte("customer_turn_at", new Date(sinceMs - 86_400_000).toISOString()).limit(1000);
    const turns = ((wt ?? []) as Array<{ customer_turn_at: string; scene_key: string | null }>).map((x) => ({ at: Date.parse(x.customer_turn_at), scene: x.scene_key }));
    const [cv, m, a] = await Promise.all([
      sb.from("conversations").select("status, line_user_id").eq("id", c).maybeSingle(),
      sb.from("messages").select("sender, text, created_at, is_aix_generated, staff_writer").eq("conversation_id", c).gte("created_at", since).order("created_at").limit(1500),
      sb.from("aix_usage_logs").select("aix_type, sent_at, created_at").eq("conversation_id", c).gte("created_at", since).limit(400),
    ]);
    const conv = cv.data as { status?: string | null; line_user_id?: string | null } | null;
    const { data: pcs } = conv?.line_user_id ? await sb.from("property_customers").select("id").eq("line_user_id", conv.line_user_id).limit(5) : { data: [] };
    const pcIds = ((pcs ?? []) as Array<{ id: string }>).map((x) => x.id);
    const s = await sb.from("sent_properties").select("sent_at")
      .or(pcIds.length ? `conversation_id.eq.${c},${pcIds.map((id) => `property_customer_id.eq.${id}`).join(",")}` : `conversation_id.eq.${c}`)
      .or("source.is.null,source.neq.line_group").gte("sent_at", since).limit(400);
    rows.push(...promisesOf(c, conv?.status ?? null, (m.data ?? []) as Msg[], (a.data ?? []) as PdAix[], (s.data ?? []) as PdSent[], sinceMs, nowMs, turns));
  };
  for (let k = 0; k < convs.length; k += 4) await Promise.all(convs.slice(k, k + 4).map(one));

  const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 1000) / 10}%` : "-");
  const line = (label: string, rs: PromiseRow[]) => {
    const c = (s: KeptState) => rs.filter((r) => r.state === s).length;
    const judged = c("in_time") + c("late") + c("overdue");
    console.log(`- ${label}: 約束 ${rs.length}（判定 ${judged}・判定なし ${c("n/a")}・期限前 ${c("pending")}）｜期限内に果たした ${c("in_time")}（${pct(c("in_time"), judged)}）・遅れて果たした ${c("late")}（${pct(c("late"), judged)}）・期限を過ぎて果たしていない ${c("overdue")}（${pct(c("overdue"), judged)}）`);
  };
  console.log(`信頼の土台 B1 約束を期限内に果たした割合（${days}日・会話 ${convs.length}/${convSet.size}・主は全体・書き手別も）`);
  line("全体", rows);
  for (const w of ["takeuchi", "employee", "unknown"]) line(`書き手 ${w}`, rows.filter((r) => r.writer === w));
  for (const k of ["pickup", "check", "estimate", "viewing_slot", "callback", "other"] as const) line(`種類 ${k}`, rows.filter((r) => r.kind === k));
  for (const b of ["words", "default72h"] as const) line(`期限 ${b}`, rows.filter((r) => r.deadlineBy === b && r.state !== "n/a"));
  for (const sc of [...MAIN_SCENES, "少数", "番なし"]) line(`場面 ${sc}`, rows.filter((r) => r.scene === sc));
  const over = rows.filter((r) => r.state === "overdue").sort((a, b) => a.at.localeCompare(b.at));
  console.log(`期限を過ぎて果たしていない約束の例（会話の頭8字・種類・書き手）: ${over.slice(0, 15).map((r) => `${r.conv}:${r.kind}:${r.writer}`).join(" ")}`);
  const out = arg("out");
  if (out) writeFileSync(out, JSON.stringify({ days, convs: convs.length, rows }, null, 1));
}

if (process.argv[1]?.endsWith("audit-promise-kept.ts")) main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
