// scripts/audit-promise-check-sent-close.ts — 確認の約束を物件の送付で閉じていた数（台帳 #856・読むだけ・LLM 0・費用0）
//
// 2026-11-28 作業員L（統括役の決め「募集状況や初期費用の確認は人だけが知る事・果たすのは確認の結果を送った通・物件の送付だけで閉じるのは甘い」）。
//   信頼の土台 B1（scripts/audit-promise-kept.ts の promisesOf）と同じ読み方・同じ判定で、会話ごとに PROMISE_CHECK_NO_SENT_CLOSE を off と on で2回判定して比べる。
//   数えるもの: ① off で物件（sent_properties・物件／おすすめの AIX）で閉じていた check の約束の数
//               ② そのうち on でも後で確認の結果を送っていた数（期限内／遅れて）と、確認の結果をまだ送っていない数（期日超え／期限前）
//   出すのは数と会話の頭8字だけ（お客様の文・名前は出さない）。DB を読むので 22時〜8時（JST）だけ流す（昼は --force が無いと止まる）。
// 実行: npx tsx --env-file=.env.local scripts/audit-promise-check-sent-close.ts [--days=30] [--max-convs=400] [--out=<json>] [--force]
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";
import { promisesOf, type PromiseRow } from "./audit-promise-kept";
import type { PdMsg, PdAix, PdSent } from "../app/lib/promise-drop-watch";
import { isTestConversation, isNoLineTestConversation, STAFF_INTERNAL_CONVERSATION_IDS } from "../app/lib/test-conversations";
import { requireFreeMemMb } from "./lib/free-mem-guard";

const argv = process.argv.slice(2);
const arg = (k: string, d = "") => argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const SWITCH = "PROMISE_CHECK_NO_SENT_CLOSE";

/** 物件で閉じた印か（off の判定の by） */
export function closedByProperty(by: string | null): boolean {
  if (!by) return false;
  if (by === "sent_properties") return true;
  return /^aix:/.test(by) && !/check_result|estimate/.test(by);
}
export type SentCloseRow = { conv: string; at: string; offBy: string; onState: PromiseRow["state"]; onBy: string | null };
/** off と on の判定を約束の時刻で組にして、off で物件で閉じていた check だけを返す（純関数） */
export function pairSentClosed(off: readonly PromiseRow[], on: readonly PromiseRow[]): SentCloseRow[] {
  const onBy = new Map(on.filter((r) => r.kind === "check").map((r) => [`${r.conv}|${r.at}`, r]));
  return off.filter((r) => r.kind === "check" && closedByProperty(r.by)).map((r) => {
    const o = onBy.get(`${r.conv}|${r.at}`);
    return { conv: r.conv, at: r.at, offBy: String(r.by), onState: o?.state ?? "n/a", onBy: o?.by ?? null };
  });
}
export function summarizeSentClose(rows: readonly SentCloseRow[]) {
  const c = (f: (r: SentCloseRow) => boolean) => rows.filter(f).length;
  return { closedByProperty: rows.length, laterResult: c((r) => r.onState === "in_time" || r.onState === "late"), laterInTime: c((r) => r.onState === "in_time"), laterLate: c((r) => r.onState === "late"), noResultOverdue: c((r) => r.onState === "overdue"), noResultPending: c((r) => r.onState === "pending") };
}

async function main() {
  const h = new Date(Date.now() + 9 * 3_600_000).getUTCHours();
  if (h >= 8 && h < 22 && !argv.includes("--force")) throw new Error(`昼（JST ${h}時）は流さない（22時〜8時だけ・DB の全件読みの決まり）。--force で流す`);
  await requireFreeMemMb(undefined, { waitMin: Number(arg("wait-min", "0")) || 0, label: "audit-promise-check-sent-close" });
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");
  const days = Number(arg("days", "30")) || 30;
  const maxConvs = Number(arg("max-convs", "400")) || 400;
  const nowMs = Date.now(), sinceMs = nowMs - days * 86_400_000, since = new Date(sinceMs).toISOString();
  // 確認の約束の候補がある会話（audit-promise-kept と同じ入口）
  const convSet = new Set<string>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("messages").select("conversation_id").eq("sender", "staff").eq("is_aix_generated", false).gte("created_at", since).ilike("text", "%させて頂%").order("created_at", { ascending: false }).range(from, from + 999);
    if (error) throw new Error(error.message);
    for (const r of data ?? []) convSet.add((r as { conversation_id: string }).conversation_id);
    if ((data ?? []).length < 1000) break;
  }
  const internal = new Set<string>(STAFF_INTERNAL_CONVERSATION_IDS as readonly string[]);
  const convs = [...convSet].filter((c) => !isTestConversation(c) && !isNoLineTestConversation(c) && !internal.has(c)).slice(0, maxConvs);
  const rows: SentCloseRow[] = [];
  let checkOff = 0;
  const prev = process.env[SWITCH];
  const one = async (c: string) => {
    const [cv, m, a] = await Promise.all([
      sb.from("conversations").select("status, line_user_id").eq("id", c).maybeSingle(),
      sb.from("messages").select("sender, text, created_at, is_aix_generated, staff_writer").eq("conversation_id", c).gte("created_at", since).order("created_at").limit(1500),
      sb.from("aix_usage_logs").select("aix_type, sent_at, created_at").eq("conversation_id", c).gte("created_at", since).limit(400),
    ]);
    for (const r of [cv, m, a]) if (r.error) throw new Error(r.error.message);
    const conv = cv.data as { status?: string | null; line_user_id?: string | null } | null;
    const { data: pcs } = conv?.line_user_id ? await sb.from("property_customers").select("id").eq("line_user_id", conv.line_user_id).limit(5) : { data: [] };
    const pcIds = ((pcs ?? []) as Array<{ id: string }>).map((x) => x.id);
    const s = await sb.from("sent_properties").select("sent_at").or(pcIds.length ? `conversation_id.eq.${c},${pcIds.map((id) => `property_customer_id.eq.${id}`).join(",")}` : `conversation_id.eq.${c}`).or("source.is.null,source.neq.line_group").gte("sent_at", since).limit(400);
    if (s.error) throw new Error(s.error.message);
    const args = [c, conv?.status ?? null, (m.data ?? []) as PdMsg[], (a.data ?? []) as PdAix[], (s.data ?? []) as PdSent[], sinceMs, nowMs] as const;
    // 判定は同期（promisesOf は await しない）＝off と on の切り替えが他の会話と混ざらない
    process.env[SWITCH] = "off"; const off = promisesOf(...args);
    process.env[SWITCH] = "on"; const on = promisesOf(...args);
    if (prev == null) delete process.env[SWITCH]; else process.env[SWITCH] = prev;
    checkOff += off.filter((r) => r.kind === "check" && r.state !== "n/a").length;
    rows.push(...pairSentClosed(off, on));
  };
  for (let k = 0; k < convs.length; k += 4) await Promise.all(convs.slice(k, k + 4).map(one));
  const sum = summarizeSentClose(rows);
  console.log(`確認の約束を物件で閉じていた数（${days}日・会話 ${convs.length}/${convSet.size}・判定のある確認の約束 ${checkOff}）`);
  console.log(`- 物件で閉じていた ${sum.closedByProperty}（送付・物件の AIX）`);
  console.log(`- うち後で確認の結果を送った ${sum.laterResult}（期限内 ${sum.laterInTime}・遅れて ${sum.laterLate}）／確認の結果をまだ送っていない ${sum.noResultOverdue + sum.noResultPending}（期日超え ${sum.noResultOverdue}・期限前 ${sum.noResultPending}）`);
  const byOff: Record<string, number> = {}; for (const r of rows) byOff[r.offBy] = (byOff[r.offBy] ?? 0) + 1;
  console.log(`- off の閉じ方: ${Object.entries(byOff).sort((x, y) => y[1] - x[1]).map(([k, n]) => `${k} ${n}`).join("・") || "なし"}`);
  console.log(`- 確認の結果をまだ送っていない例（会話の頭8字）: ${rows.filter((r) => r.onState === "overdue").slice(0, 15).map((r) => r.conv).join(" ") || "なし"}`);
  const out = arg("out");
  if (out) writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), days, convs: convs.length, checkOff, ...sum, rows }, null, 1));
}
if (process.argv[1]?.endsWith("audit-promise-check-sent-close.ts")) main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
