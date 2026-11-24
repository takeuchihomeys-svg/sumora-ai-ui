// scripts/audit-apology-ack.ts — TWO_STAGE_APOLOGY_ACK の60日の off/on の数え（台帳 #642・番 8438・作業員L・2026-11-24・読むだけ・LLM なし）
//   約束（こちらの手打ちの物件ピックアップ・確認の約束＝promise-drop-watch.promiseKindNameOf）の後 24時間以内のお客様の番で、
//   off では了承だけと読めず（isAckOnlyForTwoStage・off）、on では了承だけと読む（謝り＋了承）番を集め、
//   その番の後のこちらの一手（次の手打ちの文か、物件・確認の結果の AIX か・24時間まで）を、書き手（竹内さん本人／従業員）で分けて数える。
//   on が正しい＝竹内さん本人の過半数が「返信せず後で AIX」の時（n≥10 で過半数）。
//   出すのは数と会話の頭8字だけ（お客様の文・名前は出さない）。DB を日付で絞って読む（60日は夜に・係の cmd で流す）
// 実行: npx tsx --env-file=.env.local scripts/audit-apology-ack.ts [--days=60] [--out=<json>]
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";
import { isAckOnlyForTwoStage } from "../app/lib/ack-topic-scope";
import { promiseKindNameOf } from "../app/lib/promise-drop-watch";
import { isTestConversation, isNoLineTestConversation } from "../app/lib/test-conversations";

const argv = process.argv.slice(2);
const arg = (k: string, d = "") => argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
type M = { conversation_id: string; sender: string; text: string | null; created_at: string; is_aix_generated: boolean | null; staff_writer: string | null };

/** 番の後のこちらの一手（純関数）: 24時間以内の最初のこちらの通が AIX（物件・確認の結果）なら aix・手打ちなら reply・無ければ none */
export function nextMoveOf(ms: ReadonlyArray<M>, i: number, aixAt: ReadonlyArray<{ at: number; type: string }>): { move: "aix" | "reply" | "none"; writer: string } {
  const t0 = Date.parse(ms[i].created_at);
  const nextStaff = ms.slice(i + 1).find((m) => m.sender === "staff" && Date.parse(m.created_at) - t0 <= 86_400_000);
  const aix = aixAt.find((a) => a.at > t0 && a.at - t0 <= 86_400_000 && /property|recommend|check_result|pickup/.test(a.type));
  if (nextStaff && !nextStaff.is_aix_generated && (!aix || Date.parse(nextStaff.created_at) < aix.at)) return { move: "reply", writer: String(nextStaff.staff_writer ?? "unknown") };
  if (aix) return { move: "aix", writer: String(nextStaff?.staff_writer ?? "unknown") };
  return { move: "none", writer: "unknown" };
}

(async () => {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");
  const days = Number(arg("days", "60")) || 60;
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const msgs: M[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("messages").select("conversation_id, sender, text, created_at, is_aix_generated, staff_writer").gte("created_at", since).order("created_at").range(from, from + 999);
    if (error) throw new Error(error.message);
    msgs.push(...((data ?? []) as M[]));
    if (!data || data.length < 1000) break;
  }
  const byConv = new Map<string, M[]>();
  for (const m of msgs) { if (isTestConversation(m.conversation_id) || isNoLineTestConversation(m.conversation_id)) continue; (byConv.get(m.conversation_id) ?? byConv.set(m.conversation_id, []).get(m.conversation_id)!).push(m); }
  const rows: Array<{ conv: string; at: string; move: string; writer: string }> = [];
  for (const [conv, ms] of byConv) {
    let lastPromiseAt = -Infinity;
    const cand: number[] = [];
    ms.forEach((m, i) => {
      const at = Date.parse(m.created_at);
      if (m.sender === "staff" && !m.is_aix_generated) { const k = promiseKindNameOf(String(m.text ?? "")); if (k === "pickup" || k === "check") lastPromiseAt = at; }
      if (m.sender === "customer" && at - lastPromiseAt <= 86_400_000) {
        const t = String(m.text ?? "");
        if (!isAckOnlyForTwoStage(t, { TWO_STAGE_APOLOGY_ACK: "off" }) && isAckOnlyForTwoStage(t, { TWO_STAGE_APOLOGY_ACK: "on" })) cand.push(i);
      }
    });
    if (!cand.length) continue;
    const { data: ax } = await sb.from("aix_usage_logs").select("aix_type, created_at").eq("conversation_id", conv).gte("created_at", since).limit(500);
    const aixAt = ((ax ?? []) as Array<{ aix_type: string | null; created_at: string }>).map((a) => ({ at: Date.parse(a.created_at), type: String(a.aix_type ?? "") }));
    for (const i of cand) { const r = nextMoveOf(ms, i, aixAt); rows.push({ conv: conv.slice(0, 8), at: ms[i].created_at, move: r.move, writer: r.writer }); }
  }
  const tally = (ws: string[]) => { const rs = rows.filter((r) => ws.includes(r.writer)); return { n: rs.length, aix: rs.filter((r) => r.move === "aix").length, reply: rs.filter((r) => r.move === "reply").length, none: rs.filter((r) => r.move === "none").length }; };
  const tk = tally(["takeuchi"]);
  const out = { days, turns: rows.length, takeuchi: tk, employee: tally(["employee"]), unknown: tally(["unknown", "null"]),
    verdict: tk.n >= 10 ? (tk.aix * 2 > tk.n ? "on が竹内さん本人の過半数（後で AIX）に合う" : "竹内さん本人の過半数は後で AIX ではない＝on にしない") : "竹内さん本人の番が10に届かない＝数を待つ",
    rows: rows.slice(0, 60) };
  console.log(JSON.stringify(out, null, 1));
  const o = arg("out"); if (o) writeFileSync(o, JSON.stringify(out, null, 1));
})().catch((e) => { console.error(e); process.exit(1); });
