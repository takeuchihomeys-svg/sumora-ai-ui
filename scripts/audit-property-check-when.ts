// scripts/audit-property-check-when.ts — 「物件確認した」をいつ使うかの読み（台帳 #688・読むだけ・LLM なし・費用 0）
// 2026-11-25 作業員A（統括役の頼み）: 竹内さん本人の番で「竹内さん 返信／ブレイン 物件確認した」と「竹内さん 物件確認した／ブレイン 返信」を1番ずつ、
//   お客様が送ってきた物件か（今の番・3日以内の URL／画像）・募集状況を聞かれたか（detectAvailabilityCheckContext）・こちらが送った物件か（30日の送った物件・最後の束からの時間）で分ける。
//   画面には分けた数だけ（お客様の本文・名前は出さない）。--json=<path> に1番ずつの欄と短い文を書く（手元で読む用）
// 実行: npx tsx --env-file=.env.local scripts/audit-property-check-when.ts [--days=60] [--json=<path>]
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";
import { isTestConversation } from "../app/lib/test-conversations";
import { detectAvailabilityCheckContext, AVAILABILITY_URL_RE, isPropertyCandidateImage } from "../app/lib/aix-scene-evidence";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const DAYS = Number(arg("days", "60")), JSON_OUT = arg("json");

type Turn = { id: number; verdict: string | null; draft_last: string | null; draft_first: string | null; conversation_id: string; customer_turn_at: string; customer_last_at: string | null; brain_action: string | null; brain_reply_mode: string | null; staff_aix: Array<{ at: string; aix_type: string; burst: boolean; check_pattern?: string | null }> | null; verdict_detail: Record<string, unknown> | null; decision_id: string | null };
type Msg = { sender: string; staff_writer: string | null; text: string | null; created_at: string; image_url: string | null; image_type: string | null; is_aix_generated: boolean | null };
const PC = "property_check_result";

(async () => {
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  const turns: Turn[] = [];
  for (let f = 0; ; f += 1000) {
    const { data, error } = await sb.from("line_watch_turns").select("id, verdict, draft_last, draft_first, conversation_id, customer_turn_at, customer_last_at, brain_action, brain_reply_mode, staff_aix, verdict_detail, decision_id").gte("customer_turn_at", since).order("id").range(f, f + 999);
    if (error) throw new Error(error.message);
    turns.push(...((data ?? []) as Turn[]));
    if ((data ?? []).length < 1000) break;
  }
  const brainOf = (t: Turn) => (t.brain_reply_mode === "aix" && t.brain_action ? t.brain_action : "返信");
  const staffOf = (t: Turn) => (t.staff_aix ?? []).find((a) => a.burst)?.aix_type ?? "返信";
  const cand = turns.filter((t) => t.brain_reply_mode && !isTestConversation(t.conversation_id) && !["duplicate_turn", "out_of_scope"].includes(String((t.verdict_detail ?? {}).reason ?? ""))
    && ((staffOf(t) === "返信" && brainOf(t) === PC) || (staffOf(t) === PC && brainOf(t) === "返信")));
  const rows: Array<Record<string, unknown>> = [];
  for (const t of cand) {
    const last = Date.parse(t.customer_last_at ?? t.customer_turn_at), first = Date.parse(t.customer_turn_at);
    const { data: ms } = await sb.from("messages").select("sender, staff_writer, text, created_at, image_url, image_type, is_aix_generated").eq("conversation_id", t.conversation_id)
      .gte("created_at", new Date(first - 3 * 86_400_000).toISOString()).lte("created_at", new Date(last + 6 * 3_600_000).toISOString()).order("created_at");
    const xs = (ms ?? []) as Msg[];
    const firstStaff = xs.find((m) => m.sender === "staff" && Date.parse(m.created_at) > last);
    if (!firstStaff || firstStaff.staff_writer !== "takeuchi") continue;
    const inTurn = xs.filter((m) => m.sender === "customer" && Date.parse(m.created_at) >= first && Date.parse(m.created_at) <= last);
    const before = xs.filter((m) => m.sender === "customer" && Date.parse(m.created_at) < first);
    const custTxt = inTurn.map((m) => m.text ?? "").join("\n");
    const isProp = (m: Msg) => AVAILABILITY_URL_RE.test(m.text ?? "") || (!!m.image_url && isPropertyCandidateImage(m.text, m.image_type));
    const custSentNow = inTurn.some(isProp), custSent3d = before.some(isProp);
    const asked = detectAvailabilityCheckContext(custTxt);
    const { data: pk } = await sb.from("property_pickups").select("created_at").eq("conversation_id", t.conversation_id).eq("status", "sent").lte("created_at", new Date(last).toISOString()).gte("created_at", new Date(last - 30 * 86_400_000).toISOString()).order("created_at", { ascending: false }).limit(20);
    const sent = (pk ?? []) as Array<{ created_at: string }>;
    const bundleMinAgo = sent[0] ? Math.round((last - Date.parse(sent[0].created_at)) / 60000) : null;
    const staffMsgs = xs.filter((m) => m.sender === "staff" && Date.parse(m.created_at) > last).slice(0, 2);
    let brainPat: string | null = null;
    if (t.decision_id) { const { data: d } = await sb.from("brain_decision_logs").select("suggested_check_pattern").eq("id", t.decision_id).maybeSingle(); brainPat = (d as { suggested_check_pattern?: string | null } | null)?.suggested_check_pattern ?? null; }
    const what = custSentNow ? "お客様が今送ってきた物件" : custSent3d ? "お客様が3日以内に送ってきた物件" : sent.length ? "こちらが送った物件" : "物件なし";
    rows.push({
      id: t.id, conv: t.conversation_id.slice(0, 8), at: t.customer_last_at ?? t.customer_turn_at, pair: staffOf(t) === PC ? "竹内さん 物件確認した／ブレイン 返信" : "竹内さん 返信／ブレイン 物件確認した",
      verdict: t.verdict, hasDraft: !!String(t.draft_last ?? t.draft_first ?? "").replace(/^\s*__[A-Z_]+__\s*$/, "").trim(), what, asked, sent30d: sent.length, bundleMinAgo, brainPat, staffPat: (t.staff_aix ?? []).find((a) => a.burst)?.check_pattern ?? null,
      cust: custTxt.slice(0, 160), staff: staffMsgs.map((m) => `${m.is_aix_generated ? "[AIX]" : ""}${(m.text ?? "").slice(0, 120)}`),
    });
  }
  console.log(`■ 「物件確認した」をいつ使うか（${DAYS}日・竹内さん本人の番 ${rows.length}）`);
  for (const pair of ["竹内さん 返信／ブレイン 物件確認した", "竹内さん 物件確認した／ブレイン 返信"]) {
    const xs = rows.filter((r) => r.pair === pair);
    console.log(`\n${pair}（n ${xs.length}）`);
    const keys = [...new Set(xs.map((r) => `${r.what}｜募集状況を聞いた ${r.asked ? "はい" : "いいえ"}`))].sort();
    for (const k of keys) console.log(`  ${k}: ${xs.filter((r) => `${r.what}｜募集状況を聞いた ${r.asked ? "はい" : "いいえ"}` === k).length}`);
    const pats = new Map<string, number>(); for (const r of xs) { const k = String(pair.startsWith("竹内さん 物件") ? r.staffPat : r.brainPat); pats.set(k, (pats.get(k) ?? 0) + 1); }
    const vs = new Map<string, number>(); for (const r of xs) { const k = `${r.verdict}${r.hasDraft ? "" : "（下書きなし）"}`; vs.set(k, (vs.get(k) ?? 0) + 1); }
    console.log(`  見張りの文の判定（same・same_meaning＝ブレインの下書きが竹内さんの一手と同じ・AIX は後で果たす約束の AIX）: ${[...vs].map(([k, v]) => `${k} ${v}`).join("・")}`);
    console.log(`  物件確認した の値: ${[...pats].map(([k, v]) => `${k} ${v}`).join("・")}`);
  }
  if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(rows, null, 1));
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
