// scripts/audit-viewing-premature.ts
// 実行: npx tsx --env-file=.env.local scripts/audit-viewing-premature.ts   （DAYS=365 SENT_DAYS / DRAFT_DAYS で期間）
//
// 2026-09-30 竹内さん（みことさん事例）「内覧確定していないのに内覧のこと自動返信で入れてしまっている。
//   内覧のことについて伝えるのは内覧が確定（AIX の待ち合わせ場所）を行ったうえで行う形」
//
// 実行前提語ゲート viewing_presumed（app/lib/viewing-premature.ts・action-ledger）を過去の文に当てる（読み取りのみ）。
//   ① こちらの実送信（スタッフ・AI の下書きを送った文・自動返信）… 「その時点の台帳」で決まっていない内覧を決まった予定として書いた文を数え、
//      直す前後を全部並べる（目で読む）。スタッフの実送信に当たった物は「誤削除の候補」として1件ずつ読む
//   ② AI の下書き（ai_reply_examples.ai_draft）… 直る件数と前後
//   ③ 同じ型の他の先回り（申込を受け取った・見積書/物件をお送りした）が、その時点の台帳の実績なしに出た件数
import { createClient } from "@supabase/supabase-js";
import { buildActionLedger, checkDonePresupposition, applyLedgerAutoFix, type LedgerAixRow, type LedgerMessage, type RecordedFact } from "../app/lib/action-ledger";
import { findPrematureViewing } from "../app/lib/viewing-premature";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const SENT_DAYS = Number(process.env.SENT_DAYS ?? process.env.DAYS ?? 365);
const DRAFT_DAYS = Number(process.env.DRAFT_DAYS ?? 60);
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";

type Msg = { conversation_id: string; sender: string; text: string | null; created_at: string; is_aix_generated?: boolean | null };

async function pageAll<T>(q: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let p = 0; p < 200; p++) {
    const { data, error } = await q(p * 1000, p * 1000 + 999);
    if (error) throw new Error(error.message);
    const r = data ?? [];
    out.push(...r);
    if (r.length < 1000) break;
  }
  return out;
}

const convCache = new Map<string, { msgs: Msg[]; aix: LedgerAixRow[]; facts: RecordedFact[] }>();
async function convData(cid: string) {
  const hit = convCache.get(cid);
  if (hit) return hit;
  const msgs = await pageAll<Msg>((a, b) => sb.from("messages").select("conversation_id, sender, text, created_at, is_aix_generated").eq("conversation_id", cid).order("created_at", { ascending: true }).range(a, b));
  const aix = await pageAll<LedgerAixRow & { created_at: string }>((a, b) => sb.from("aix_usage_logs").select("aix_type, created_at, sent_at, generated_text, check_pattern, property_names, estimate_sent, prop_statuses, line_message_id").eq("conversation_id", cid).order("created_at", { ascending: true }).range(a, b));
  const { data: sf } = await sb.from("sent_facts").select("sent_at, origin, aix_type, kind, status, line_message_id, detail, evidence").eq("conversation_id", cid).limit(2000);
  const v = { msgs, aix, facts: (sf ?? []) as unknown as RecordedFact[] };
  convCache.set(cid, v);
  return v;
}

/** その時刻（at より前）の台帳と、直前のお客様の発言 */
async function ledgerAt(cid: string, at: string) {
  const d = await convData(cid);
  const t = Date.parse(at);
  const msgs = d.msgs.filter((m) => Date.parse(m.created_at) < t);
  const lastCust = [...msgs].reverse().find((m) => m.sender === "customer");
  const ledger = buildActionLedger({
    recentAixRows: d.aix.filter((r) => Date.parse(r.sent_at ?? r.created_at ?? "") < t),
    messages: msgs.slice(-80).map((m) => ({ sender: m.sender, text: m.text, createdAt: m.created_at } as LedgerMessage)),
    lineTasks: [], lastCustomerAt: lastCust?.created_at ?? null, now: t,
    recordedFacts: d.facts.filter((f) => Date.parse(f.sent_at) < t),
  });
  // お客様の今回の連投（直前のこちらの発言より後）
  const lastStaffIdx = msgs.map((m) => m.sender).lastIndexOf("staff");
  const customerText = msgs.slice(lastStaffIdx + 1).filter((m) => m.sender === "customer").map((m) => m.text ?? "").join("\n");
  return { ledger, customerText };
}

function one(s: string, n = 160) { return s.replace(/\n/g, " / ").slice(0, n); }

async function main() {
  const since = new Date(Date.now() - SENT_DAYS * 86400_000).toISOString();
  // ① 実送信: まず語で候補を絞る（全件の台帳は重いので、語が当たる文だけ台帳を組む）
  const sent = await pageAll<Msg>((a, b) => sb.from("messages").select("conversation_id, sender, text, created_at, is_aix_generated")
    .eq("sender", "staff").gte("created_at", since).not("text", "is", null).order("created_at", { ascending: true }).range(a, b));
  const cand = sent.filter((m) => m.conversation_id !== YUMA && findPrematureViewing(m.text ?? "").length > 0);
  console.log(`=== ① こちらの実送信 ${SENT_DAYS}日: ${sent.length}通中、語が当たる文 ${cand.length}通 ===`);
  let confirmed = 0, custFixed = 0;
  const flagged: Array<{ m: Msg; fixed: string; auto: boolean }> = [];
  for (const m of cand) {
    const { ledger, customerText } = await ledgerAt(m.conversation_id, m.created_at);
    const h = checkDonePresupposition(m.text ?? "", ledger, { customerMessage: customerText, name: "" }).find((x) => x.key === "viewing_presumed");
    if (!h) continue;
    if (h.exempt === "evidence") { confirmed++; continue; }
    if (h.exempt) { custFixed++; continue; }
    const { data: sch } = await sb.from("scheduled_messages").select("id").eq("conversation_id", m.conversation_id).eq("status", "sent").eq("text", m.text ?? "").limit(1);
    flagged.push({ m, fixed: applyLedgerAutoFix(m.text ?? "", ledger, { customerMessage: customerText, name: "" }).text, auto: (sch ?? []).length > 0 });
  }
  console.log(`  内覧が決まっている（待ち合わせ案内済み）で通す: ${confirmed}通`);
  console.log(`  お客様が決まった内覧を自分から言ったので通す: ${custFixed}通`);
  console.log(`  **決まっていない内覧を決まった予定として書いた: ${flagged.length}通**（うち自動返信 ${flagged.filter((f) => f.auto).length}通）\n`);
  for (const f of flagged) {
    console.log(`  [${f.m.created_at.slice(0, 16)}] conv=${f.m.conversation_id.slice(0, 8)} ${f.auto ? "自動返信" : f.m.is_aix_generated ? "AIX" : "スタッフ/下書き送信"}`);
    console.log(`    前: ${one(f.m.text ?? "")}`);
    console.log(`    後: ${one(f.fixed)}`);
  }

  // ② AI の下書き
  const dSince = new Date(Date.now() - DRAFT_DAYS * 86400_000).toISOString();
  const drafts = await pageAll<{ conversation_id: string; created_at: string; ai_draft: string | null; sent_reply: string | null }>((a, b) =>
    sb.from("ai_reply_examples").select("conversation_id, created_at, ai_draft, sent_reply").gte("created_at", dSince).not("ai_draft", "is", null).range(a, b));
  const dc = drafts.filter((d) => d.conversation_id !== YUMA && findPrematureViewing(d.ai_draft ?? "").length > 0);
  console.log(`\n=== ② AI の下書き ${DRAFT_DAYS}日: ${drafts.length}件中、語が当たる ${dc.length}件 ===`);
  let dConfirmed = 0, dFixed = 0;
  for (const d of dc) {
    // 下書きは送信の直前に作られる（created_at は送信の保存時刻）。その時点の台帳で見る
    const { ledger, customerText } = await ledgerAt(d.conversation_id, d.created_at);
    const h = checkDonePresupposition(d.ai_draft ?? "", ledger, { customerMessage: customerText, name: "" }).find((x) => x.key === "viewing_presumed");
    if (!h || h.exempt) { dConfirmed++; continue; }
    dFixed++;
    console.log(`  [${d.created_at.slice(0, 16)}] conv=${d.conversation_id.slice(0, 8)}`);
    console.log(`    下書き: ${one(d.ai_draft ?? "")}`);
    console.log(`    直す後: ${one(applyLedgerAutoFix(d.ai_draft ?? "", ledger, { customerMessage: customerText, name: "" }).text)}`);
    console.log(`    送った: ${one(d.sent_reply ?? "")}`);
  }
  console.log(`  通す（決まっている・免除）: ${dConfirmed}件 / 直す: ${dFixed}件`);

  // ③ 同じ型の他の先回り（既存の実行前提語ゲートの語）を、直近の実送信で数える（読むだけ）
  const recent = sent.filter((m) => Date.parse(m.created_at) >= Date.now() - 30 * 86400_000 && m.conversation_id !== YUMA);
  const other = new Map<string, number>();
  const otherEx: string[] = [];
  const APPLY_RECEIVED_RE = /お申込み?(?:情報|書類)?(?:を)?(?:受け取り|受け付け|承り)(?:ました|致しました|いたしました)/;
  for (const m of recent) {
    const t = m.text ?? "";
    if (!/再度|改めて|お送りした|ご提案した|お申込|本日は.{0,6}内覧/.test(t)) continue;
    const { ledger, customerText } = await ledgerAt(m.conversation_id, m.created_at);
    for (const h of checkDonePresupposition(t, ledger, { customerMessage: customerText, name: "" })) {
      if (h.exempt || h.key === "viewing_presumed") continue;
      other.set(h.key, (other.get(h.key) ?? 0) + 1);
      if (otherEx.length < 12) otherEx.push(`  [${h.key}] ${m.created_at.slice(0, 10)} ${one(h.sentence, 90)}`);
    }
    if (APPLY_RECEIVED_RE.test(t) && !ledger.facts.applicationGuided) {
      other.set("apply_received_without_guide", (other.get("apply_received_without_guide") ?? 0) + 1);
      if (otherEx.length < 12) otherEx.push(`  [apply_received] ${m.created_at.slice(0, 10)} ${one(t, 90)}`);
    }
  }
  console.log(`\n=== ③ 他の先回り（直近30日の実送信・その時点の台帳に実績なし）===`);
  console.log(`  ${[...other].map(([k, n]) => `${k}=${n}`).join(" / ") || "0件"}`);
  for (const e of otherEx) console.log(e);
}
main().catch((e) => { console.error(e); process.exit(1); });
