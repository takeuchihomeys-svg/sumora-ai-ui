// scripts/audit-exits-vs-human.ts
// 2026-10-02 竹内「弱い部分見つけて強化する…初期のころ制約かけまくっていたので、理想の文がぶつかってしまって
//   できないようになっている可能性もあるので、そこもみつける。実際のLINEや直近の成約データを参考に改善する」
//
// 【何を測るか】スタッフが実際に送った文（AIX の本文を除く手打ち・AI 下書きを直して送った文）を、
//   生成の出口（返信の本文を書き換える決定論の関数）に**本番と同じ順で**1つずつ通し、
//   「人が良いと判断して送った文を、どの出口が何件書き換えるか」を出口ごと・中の規則ごとに数える。
//   人の文を書き換える出口＝理想の文とぶつかっている候補（制約の掛けすぎ・古い規則の当てすぎ）。
//   送信の関門（draftToSendableText・detectPlaceholders）に当たる文＝人が送れない文。
//   最終チェックの決定論部分は別の常設スクリプト（audit-final-check-vs-staff.ts）で測る（重ねない）。
//
// 【成約データ】会話の状態が申込以降（applying / screening / contract / approved / closed_won）の会話は「成約」として分けて数える。
//   申込以降の通は対象外（project_post_apply_out_of_scope）＝申込に変わった時刻（conversation_stage_history）より前の送信だけ。
//
// 実行: npx tsx --env-file=.env.local scripts/audit-exits-vs-human.ts [--days=60] [--cache=<path>] [--top=6] [--json=<path>]
//   DB は読むだけ・LLM は呼ばない（入口 llm-test-harness は不要）。本文は個人情報を含むので --json/--cache はリポジトリの外に置く。
import { createClient } from "@supabase/supabase-js";
import * as fs from "fs";
import { validateAndClean, detectPlaceholders, resolveAddressName } from "@/app/lib/validate-reply";
import { draftToSendableText } from "@/app/lib/draft-text";
import { stripVagueDeferral } from "@/app/lib/viewing-access";
import { stripPointlessGuidance, fixAbsenceWording } from "@/app/lib/reply-phrasing";
import { resolveApologyOnly, ensureApologyOpener } from "@/app/lib/apology-ack";
import { stripVagueQuantifier } from "@/app/lib/vague-quantifier";
import { sentFullSupportToday, stripRepeatedFullSupport } from "@/app/lib/full-support-line";
import { dedupeRepeatedEmoji } from "@/app/lib/emoji-repeat";
import { buildActionLedger, applyLedgerAutoFix, type LedgerAixRow, type LedgerTask } from "@/app/lib/action-ledger";
import { analyzeSubstance, classifyLastStaffTurn, classifyCustomerResponse, MSG_SEP } from "@/app/lib/reply-context";
import { resolveGreeting, enforceOpening, isProgressPushMessage, computeAlreadyGreetedToday } from "@/app/lib/greeting";
import { isConditionFormMessage } from "@/app/lib/line-reply-prompts";
import { isUsableExampleText } from "@/app/lib/example-hygiene";
import { isTestConversation } from "@/app/lib/test-conversations";

type Msg = { id: string; sender: string; text: string; created_at: string; is_aix_generated: boolean | null };
type Conv = { id: string; customer_name: string | null; status: string | null; applyAt: string | null; msgs: Msg[]; aix: LedgerAixRow[]; tasks: LedgerTask[] };
type Ex = { conversation_id: string; sent_reply: string; ai_draft: string | null; was_ai_used: boolean | null; was_ai_modified: boolean | null; is_starred: boolean | null; application_success: boolean | null; outcome_status: string | null };
type Raw = { fetchedAt: string; days: number; convs: Conv[]; examples: Ex[] };

const args = new Map<string, string>();
for (const a of process.argv.slice(2)) { const m = /^--([^=]+)(?:=(.*))?$/.exec(a); if (m) args.set(m[1], m[2] ?? "true"); }
const DAYS = Number(args.get("days") ?? "60");
const CACHE = args.get("cache") ?? null;
const TOP = Number(args.get("top") ?? "6");
const JSON_OUT = args.get("json") ?? null;
const APPLY_STATUSES = ["applying", "application", "screening", "contract", "approved", "closed_won"];

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const norm = (s: string) => (s ?? "").replace(/\s+/g, "");
const one = (s: string) => (s ?? "").replace(/\s+/g, " ").trim();

async function fetchRaw(): Promise<Raw> {
  const since = new Date(Date.now() - DAYS * 86400e3).toISOString();
  const cids = new Set<string>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("messages").select("conversation_id").eq("sender", "staff").gte("created_at", since).range(from, from + 999);
    if (error) throw error;
    for (const r of data ?? []) cids.add((r as { conversation_id: string }).conversation_id);
    if (!data || data.length < 1000) break;
  }
  const ids = [...cids].filter((c) => !isTestConversation(c));
  const convs: Conv[] = [];
  const meta = new Map<string, { customer_name: string | null; status: string | null }>();
  for (let i = 0; i < ids.length; i += 100) {
    const { data } = await sb.from("conversations").select("id, customer_name, status").in("id", ids.slice(i, i + 100));
    for (const c of (data ?? []) as Array<{ id: string; customer_name: string | null; status: string | null }>) meta.set(c.id, c);
  }
  const applyAt = new Map<string, string>();
  for (let i = 0; i < ids.length; i += 100) {
    const { data } = await sb.from("conversation_stage_history").select("conversation_id, to_status, changed_at").in("conversation_id", ids.slice(i, i + 100)).in("to_status", APPLY_STATUSES).order("changed_at", { ascending: true });
    for (const r of (data ?? []) as Array<{ conversation_id: string; changed_at: string }>) if (!applyAt.has(r.conversation_id)) applyAt.set(r.conversation_id, r.changed_at);
  }
  const queue = [...ids];
  const worker = async () => {
    for (let cid = queue.shift(); cid; cid = queue.shift()) {
      const [m, a, t] = await Promise.all([
        sb.from("messages").select("id, sender, text, created_at, is_aix_generated").eq("conversation_id", cid).order("created_at", { ascending: false }).limit(1000),
        sb.from("aix_usage_logs").select("aix_type, check_pattern, created_at, sent_at, line_message_id, generated_text, property_names, estimate_sent, template_name").eq("conversation_id", cid).order("created_at", { ascending: false }).limit(300),
        sb.from("line_tasks").select("task_type, status, created_at, completed_at, result").eq("conversation_id", cid).limit(300),
      ]);
      const mm = meta.get(cid);
      convs.push({ id: cid, customer_name: mm?.customer_name ?? null, status: mm?.status ?? null, applyAt: applyAt.get(cid) ?? null,
        msgs: ((m.data ?? []) as Msg[]).reverse().filter((x) => typeof x.text === "string"), aix: (a.data ?? []) as LedgerAixRow[], tasks: (t.data ?? []) as LedgerTask[] });
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  const examples: Ex[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("ai_reply_examples").select("conversation_id, sent_reply, ai_draft, was_ai_used, was_ai_modified, is_starred, application_success, outcome_status")
      .eq("entry_source", "line_reply").gte("created_at", since).range(from, from + 999);
    if (error) throw error;
    examples.push(...((data ?? []) as Ex[]));
    if (!data || data.length < 1000) break;
  }
  return { fetchedAt: new Date().toISOString(), days: DAYS, convs, examples };
}

type Change = { exit: string; codes: string[]; before: string; after: string };
type Row = { cid: string; msgId: string; kind: "human" | "ai_edited" | "ai_unedited" | "unknown"; closed: boolean; cust: string; sent: string; changes: Change[] };

/** 2つの文の違う所（先頭と末尾の共通部分を除いた真ん中）を短く見せる */
function diffSpan(a: string, b: string): { before: string; after: string } {
  let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++;
  let j = 0; while (j < a.length - i && j < b.length - i && a[a.length - 1 - j] === b[b.length - 1 - j]) j++;
  const ctx = 12;
  return { before: one(a.slice(Math.max(0, i - ctx), a.length - j + ctx)), after: one(b.slice(Math.max(0, i - ctx), b.length - j + ctx)) };
}

(async () => {
  let raw: Raw;
  if (CACHE && fs.existsSync(CACHE)) raw = JSON.parse(fs.readFileSync(CACHE, "utf8")) as Raw;
  else { raw = await fetchRaw(); if (CACHE) fs.writeFileSync(CACHE, JSON.stringify(raw)); }
  const since = Date.now() - DAYS * 86400e3;
  const exByConv = new Map<string, Ex[]>();
  for (const e of raw.examples) exByConv.set(e.conversation_id, [...(exByConv.get(e.conversation_id) ?? []), e]);

  const rows: Row[] = [];
  let skippedPostApply = 0;
  for (const conv of raw.convs) {
    const msgs = conv.msgs;
    const closed = APPLY_STATUSES.includes(conv.status ?? "");
    const applyMs = conv.applyAt ? Date.parse(conv.applyAt) : Infinity;
    for (let idx = 0; idx < msgs.length; idx++) {
      const m = msgs[idx];
      if (m.sender !== "staff" || m.is_aix_generated) continue;
      const sendAt = Date.parse(m.created_at);
      if (!(sendAt >= since)) continue;
      if (sendAt >= applyMs) { skippedPostApply++; continue; }
      const text = (m.text ?? "").trim();
      // 「[画像] …」で始まる行は画像の読み取りの説明（送った本文ではない）なので数えない
      if (text.length < 6 || /^\[(画像|動画|スタンプ|ファイル)\]/.test(text) || !isUsableExampleText(text)) continue;
      const before = msgs.slice(0, idx);
      const custUnits: string[] = [];
      for (let j = before.length - 1; j >= 0 && before[j].sender !== "staff"; j--) if (before[j].sender === "customer") custUnits.unshift(before[j].text);
      const cust = custUnits.join(MSG_SEP);
      // 下書きとの関係（ai_reply_examples の一致）
      const ex = (exByConv.get(conv.id) ?? []).find((e) => norm(e.sent_reply).slice(0, 40) === norm(text).slice(0, 40));
      const kind: Row["kind"] = !ex ? "unknown" : ex.was_ai_used === false ? "human" : ex.was_ai_modified ? "ai_edited" : "ai_unedited";
      const lastStaff = [...before].reverse().find((x) => x.sender === "staff");
      const lastCust = [...before].reverse().find((x) => x.sender === "customer");
      const aixRows = conv.aix.filter((r) => Date.parse(r.created_at ?? "") < sendAt - 1000);
      const ledger = buildActionLedger({
        recentAixRows: aixRows,
        messages: before.slice(-30).map((x) => ({ sender: x.sender, text: x.text, createdAt: x.created_at, isAix: !!x.is_aix_generated })),
        lineTasks: conv.tasks.filter((t) => Date.parse(t.created_at ?? "") < sendAt), lastCustomerAt: before[before.length - 1]?.created_at ?? null, now: sendAt,
      });
      const addr = resolveAddressName({ messages: before.map((x) => ({ sender: x.sender, text: x.text, createdAt: x.created_at })), displayName: conv.customer_name ?? "" });
      const changes: Change[] = [];
      let cur = text;
      const step = (exit: string, next: string, codes: string[] = []) => {
        if (next !== cur) { const d = diffSpan(cur, next); changes.push({ exit, codes, before: d.before, after: d.after }); cur = next; }
      };
      try {
        // ① 冒頭（挨拶・開口語）の決定論: generate-reply の enforceOpening と同じ判定
        if (custUnits.length > 0) {
          const staffTurn = classifyLastStaffTurn(lastStaff?.text ?? "", { recentAixRows: aixRows, lastStaffAt: lastStaff?.created_at ?? null, ledger });
          const sub = analyzeSubstance(cust, custUnits, { staffAskedQuestion: staffTurn.kind === "question_to_customer" });
          const cr = classifyCustomerResponse(sub, staffTurn, { ledger, isConditionPresented: isConditionFormMessage(cust) });
          const recent = before.slice(-20).map((x) => ({ sender: x.sender, text: x.text, createdAt: x.created_at, isAix: !!x.is_aix_generated }));
          const firstEver = !before.some((x) => x.sender === "staff" && (x.text ?? "").trim() && !/^\[(画像|動画)\]$/.test(x.text));
          const g = resolveGreeting({
            customerName: addr.name, isFirstEverReply: firstEver, alreadyGreetedToday: computeAlreadyGreetedToday(recent, sendAt) ?? false,
            recentMessages: recent, jstHour: new Date(sendAt + 9 * 3600e3).getUTCHours(), now: sendAt,
            isProgressPush: isProgressPushMessage(cust, { isAckOnly: sub.isAckOnly }), isSubstantive: (t) => analyzeSubstance(t).has,
            customerKind: cr.kind, customerSecondary: cr.secondary, substanceKinds: sub.kinds,
          });
          const o = enforceOpening(cur, g);
          step(`opening(${g.kind}/${g.opener ?? "-"})`, o.cleaned, o.fixes.map((f) => f.replace(/[「」].*$/, "")));
        }
        // ② validateAndClean（ゲート＋表層修正）。issues の名前ごとに数える
        const vr = validateAndClean(cur, {
          aixGates: true, customerName: addr.name, nameAliases: addr.aliases, customerMessage: cust, lastStaffMsg: lastStaff?.text ?? "",
          now: sendAt, customerMessageAt: lastCust?.created_at ?? null, lastStaffMessageAt: lastStaff?.created_at ?? null,
        });
        step("validateAndClean", vr.cleaned, vr.issues.map((s) => s.replace(/^表層修正: /, "").replace(/×\d+$/, "").replace(/^AIXゲート違反\(置換済\): /, "GATE:").slice(0, 60)));
        step("stripVagueDeferral", stripVagueDeferral(cur));
        step("stripPointlessGuidance", stripPointlessGuidance(cur));
        step("fixAbsenceWording", fixAbsenceWording(cur));
        step("ensureApologyOpener", ensureApologyOpener(cur, resolveApologyOnly(cust).apology));
        { const q = stripVagueQuantifier(cur); step("stripVagueQuantifier", q.text, q.removed); }
        { const fs2 = stripRepeatedFullSupport(cur, sentFullSupportToday(before.map((x) => ({ sender: x.sender, text: x.text, created_at: x.created_at, createdAt: x.created_at })) as never, sendAt)); step("stripRepeatedFullSupport", fs2.text, fs2.removed); }
        { const lf = applyLedgerAutoFix(cur, ledger, { customerMessage: cust, name: addr.name ? `${addr.name}さん` : "", isDeliverableReply: false }); step("applyLedgerAutoFix", lf.text, lf.applied.map((a) => a.replace(/:.*/, ""))); }
        { const dr = dedupeRepeatedEmoji(cur); step("dedupeRepeatedEmoji", dr.text, dr.changes.map((c) => `${c.from}→${c.to || "(削除)"}`)); }
        // ③ 送信の関門（人の文がここに当たると送れない）
        if (draftToSendableText(text) === null) changes.push({ exit: "SEND_BLOCK:draftToSendableText", codes: [], before: one(text).slice(0, 80), after: "(送れない)" });
        else if (draftToSendableText(text) !== text.trim()) changes.push({ exit: "SEND_STRIP:draftToSendableText", codes: [], ...diffSpan(text.trim(), draftToSendableText(text) ?? "") });
        const ph = detectPlaceholders(text);
        if (ph.length) changes.push({ exit: "SEND_BLOCK:detectPlaceholders", codes: ph, before: one(text).slice(0, 80), after: "(送れない)" });
      } catch (e) {
        changes.push({ exit: "ERROR", codes: [String(e instanceof Error ? e.message : e).slice(0, 80)], before: "", after: "" });
      }
      rows.push({ cid: conv.id, msgId: m.id, kind, closed, cust: one(cust.split(MSG_SEP).join(" ／ ")).slice(0, 90), sent: one(text).slice(0, 120), changes });
    }
  }

  const pct = (a: number, b: number) => `${b ? ((100 * a) / b).toFixed(1) : "0"}%`;
  const n = rows.length;
  const byKind = (k: Row["kind"]) => rows.filter((r) => r.kind === k).length;
  console.log(`人の送信（AIX の本文を除く・${DAYS}日・申込以降 ${skippedPostApply} 通は除外）: ${n} 通` +
    `（人が書いた human ${byKind("human")}・AI を直した ai_edited ${byKind("ai_edited")}・AI のまま ai_unedited ${byKind("ai_unedited")}・下書きの記録なし unknown ${byKind("unknown")}）／成約の会話の通 ${rows.filter((r) => r.closed).length}`);
  const changed = rows.filter((r) => r.changes.length > 0);
  console.log(`どれかの出口で変わる/止まる通: ${changed.length}/${n} = ${pct(changed.length, n)}`);
  // 出口ごと（コード単位）
  type Agg = { n: number; human: number; closed: number; unedited: number; ex: Row[] };
  const agg = new Map<string, Agg>();
  for (const r of rows) {
    const keys = new Set<string>();
    for (const c of r.changes) { if (c.codes.length) for (const k of c.codes) keys.add(`${c.exit} :: ${k}`); else keys.add(c.exit); }
    for (const k of keys) {
      const a = agg.get(k) ?? { n: 0, human: 0, closed: 0, unedited: 0, ex: [] };
      a.n++; if (r.kind !== "ai_unedited") a.human++; if (r.closed) a.closed++; if (r.kind === "ai_unedited") a.unedited++;
      if (a.ex.length < TOP && r.kind !== "ai_unedited") a.ex.push(r);
      agg.set(k, a);
    }
  }
  console.log(`\n■ 出口・規則ごと（通数／うち人の文（AI のままを除く）／うち成約の会話／AI のまま）`);
  const sorted = [...agg].sort((a, b) => b[1].human - a[1].human);
  for (const [k, a] of sorted) console.log(`  ${String(a.n).padStart(4)} 人${String(a.human).padStart(4)} 成約${String(a.closed).padStart(3)} AIのまま${String(a.unedited).padStart(3)}  ${k}`);
  console.log(`\n■ 例（人の文・出口ごとに上位${TOP}件）`);
  for (const [k, a] of sorted) {
    if (!a.ex.length) continue;
    console.log(`  [${k}]`);
    for (const r of a.ex) {
      const c = r.changes.find((x) => k.startsWith(x.exit));
      console.log(`    ${r.cid.slice(0, 8)}/${r.msgId.toString().slice(0, 8)} ${r.kind}${r.closed ? "・成約" : ""} 顧客「${r.cust.slice(0, 60)}」`);
      console.log(`       前「${c?.before ?? ""}」\n       後「${c?.after ?? ""}」`);
    }
  }
  if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify({ n, rows }, null, 1));
})().catch((e) => { console.error(e); process.exit(2); });
