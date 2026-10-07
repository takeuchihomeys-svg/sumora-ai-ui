// scripts/audit-p0-staff-only-facts.ts — P0「AIX と返信の分け方」（設計知見 ca55d42b・2026-10-07 竹内さん「ここのLINE返信のさいは絶対にする」）が
//   返信の下書きで守られているかを数える（読み取りのみ・LLM 0）。
//   スタッフだけが知る情報（管理会社に確認した事・募集状況・交渉の結果・撮影した写真・見積の金額・内覧の日程の確定）を、
//   AI の下書きが本文で言い切っている番を型ごとに数え、①その事実が前の会話にスタッフ（AIX を含む）から出ているか（＝引用ならよい）
//   ②スタッフが実際に送った文にも同じ型があるか（残した／消した）③見張りの番（line_watch_turns）で最終チェックの前後に消えたか、を出す。
//   型の判定の一部は app/lib/staff-confirm-facts.ts の findStaffOnlyFact（自動送信の関所と同じ線）を使う＝二重にしない。
// 実行: npx tsx --env-file=.env.local scripts/audit-p0-staff-only-facts.ts [--days=60] [--show=vacancy,...|all]
import { createClient } from "@supabase/supabase-js";
import { TEST_CONVERSATION_IDS } from "../app/lib/test-conversations";
import { findStaffOnlyFact, STAFF_RESULT_RES } from "../app/lib/staff-confirm-facts";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const DAYS = Number(arg("days", "60"));
const SHOW = arg("show").split(",").filter(Boolean);
const since = new Date(Date.now() - DAYS * 86400_000).toISOString();
const skip = new Set<string>(TEST_CONVERSATION_IDS);
const one = (s: string | null | undefined, n = 120) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

/** 型（findStaffOnlyFact の1件目に加えて、文ごとに全部の型を数える。確認済みの言い切り・物件の条件の言い切りは監査だけの型） */
const EXTRA: Array<[string, RegExp, RegExp?]> = [
  // 管理会社の回答・交渉の結果・撮影した写真・入居可能日は app/lib/staff-confirm-facts.ts の STAFF_RESULT_RES（自動送信の関所と同じ線）
  ...STAFF_RESULT_RES.map((r) => [r.kind, r.re, r.exclude] as [string, RegExp, RegExp?]),
  ["confirm_done", /確認(?:させて(?:頂|いただ)きました|致しました|いたしました|しました)(?:ところ|が|、|！|!|\s|$)/, /お客様が|ご確認|確認(?:頂|いただ)/],
  ["property_condition", /(?:ペット|犬|猫|駐車場|駐輪場|バイク置き場|楽器|ルームシェア|二人入居|2人入居|法人契約|保証人不要|フリーレント|インターネット無料|ネット無料)[^。\n]{0,12}(?:可能です|可能となります|大丈夫です|空いて(?:おります|います)|ございます|出来ます|できます|付いて(?:おります|います)|無料です)/, /(?:れ|け)ば|場合|でしょうか|ですか|ますか|ご希望|お探し|条件で|ピックアップ/],
];
type Hit = { kind: string; text: string };
function hitsOf(t: string): Hit[] {
  const out: Hit[] = [];
  const f = findStaffOnlyFact(t);
  if (f) out.push({ kind: f.kind, text: f.text });
  for (const s of String(t ?? "").split(/(?<=[。！!？?\n])/)) {
    for (const [k, re, ex] of EXTRA) { const m = s.match(re); if (m && !(ex && ex.test(s)) && !out.some((h) => h.kind === k)) out.push({ kind: k, text: s.trim().slice(0, 120) }); }
  }
  return out;
}
/** その事実が前の会話（スタッフ・AIX の本文 14日）にもう出ているか: 同じ型の言い切り＋（日付・金額があれば同じ数字） */
function grounded(h: Hit, prior: string[]): boolean {
  const nums = (h.text.normalize("NFKC").match(/[0-9]{1,2}\s*[\/月]\s*[0-9]{1,2}|[0-9][0-9,]{3,}/g) ?? []).map((x) => x.replace(/\s/g, ""));
  return prior.some((p) => {
    const hs = hitsOf(p);
    if (!hs.some((x) => x.kind === h.kind)) return false;
    const pn = p.normalize("NFKC").replace(/\s/g, "");
    return nums.every((n) => pn.includes(n));
  });
}

async function main() {
  const rows: Array<{ id: string; conversation_id: string; created_at: string; sent_at: string | null; customer_message: string | null; ai_draft: string | null; sent_reply: string | null }> = [];
  for (let p = 0; p < 10; p++) {
    const { data, error } = await sb.from("ai_reply_examples").select("id, conversation_id, created_at, sent_at, customer_message, ai_draft, sent_reply")
      .eq("entry_source", "line_reply").gte("created_at", since).not("ai_draft", "is", null).order("created_at").range(p * 1000, p * 1000 + 999);
    if (error) throw new Error(error.message);
    rows.push(...((data ?? []) as typeof rows)); if ((data ?? []).length < 1000) break;
  }
  const use = rows.filter((r) => !skip.has(r.conversation_id) && (r.ai_draft ?? "").trim().length > 5 && !/^__|\[AIX誘導中\]/.test((r.ai_draft ?? "").trim()));
  type Agg = { n: number; ungrounded: number; staffKept: number; staffDropped: number; samples: string[] };
  const agg = new Map<string, Agg>();
  let draftsWithHit = 0;
  for (const r of use) {
    const hs = hitsOf(r.ai_draft ?? "");
    if (!hs.length) continue;
    draftsWithHit++;
    const { data: prev } = await sb.from("messages").select("sender, text, created_at").eq("conversation_id", r.conversation_id).neq("sender", "customer")
      .lt("created_at", r.created_at).gte("created_at", new Date(Date.parse(r.created_at) - 14 * 86400_000).toISOString()).order("created_at", { ascending: false }).limit(60);
    const prior = ((prev ?? []) as Array<{ text: string | null }>).map((m) => m.text ?? "");
    const sentHits = hitsOf(r.sent_reply ?? "");
    for (const h of hs) {
      const a = agg.get(h.kind) ?? { n: 0, ungrounded: 0, staffKept: 0, staffDropped: 0, samples: [] };
      a.n++;
      const g = grounded(h, prior);
      if (!g) {
        a.ungrounded++;
        const kept = sentHits.some((x) => x.kind === h.kind);
        if (kept) a.staffKept++; else a.staffDropped++;
        if (SHOW.includes("all") || SHOW.includes(h.kind)) a.samples.push(`${r.conversation_id.slice(0, 8)} ${r.created_at.slice(0, 16)} 客「${one(r.customer_message, 50)}」\n      AI「${one(h.text, 110)}」\n      人「${one(r.sent_reply, 110)}」${kept ? "（人も同じ型）" : "（人は消した）"}`);
      }
      agg.set(h.kind, a);
    }
  }
  console.log(`AI の下書き ${use.length}通（${DAYS}日・YUMA 除く・AIX 誘導の印を除く）／ スタッフだけが知る事実の言い切りがある下書き ${draftsWithHit}通`);
  for (const [k, a] of [...agg.entries()].sort((x, y) => y[1].n - x[1].n)) {
    console.log(`  ${k.padEnd(20)} 言い切り ${String(a.n).padStart(3)} ／ 前の会話に無い（作り事の疑い） ${String(a.ungrounded).padStart(3)}（人も同じ型で送った ${a.staffKept}・人は消した ${a.staffDropped}）`);
    for (const s of a.samples) console.log(`    - ${s}`);
  }

  // 見張りの番: 最終チェックの前（draft_first）と後（draft_last）で、言い切りが消えたか（出口が効いているか）
  const { data: wt } = await sb.from("line_watch_turns").select("conversation_id, draft_first, draft_last, final_check").gte("customer_turn_at", since).not("draft_first", "is", null).limit(2000);
  const pick = (x: unknown) => { const t = String(x ?? ""); return /^__\w+__$/.test(t.trim()) ? "" : t; };
  const ex = new Map<string, { first: number; last: number }>();
  for (const t of ((wt ?? []) as Array<{ conversation_id: string; draft_first: string | null; draft_last: string | null }>).filter((t) => !skip.has(t.conversation_id))) {
    const f = hitsOf(pick(t.draft_first)).map((h) => h.kind);
    const l = hitsOf(pick(t.draft_last) || pick(t.draft_first)).map((h) => h.kind);
    for (const k of new Set([...f, ...l])) { const e = ex.get(k) ?? { first: 0, last: 0 }; if (f.includes(k)) e.first++; if (l.includes(k)) e.last++; ex.set(k, e); }
  }
  console.log(`\n見張りの番（${DAYS}日・最終チェックの前→後）:`);
  for (const [k, e] of ex) console.log(`  ${k.padEnd(20)} 前 ${e.first} → 後 ${e.last}`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => setTimeout(() => process.exit(process.exitCode ?? 0), 300));
