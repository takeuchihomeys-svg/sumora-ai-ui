// scripts/audit-final-check-coverage.ts — 最終チェックの「掛かり方・省き方・直らない物・見逃し」の点検（読み取りのみ・LLM なし）
//
// 2026-10-06 竹内「最終チェックの部分ちゃんとできているのか、最終チェック必要か不必要なのかの部分甘くなっていないか
//   抜けている部分や追加する必要があるクエリなどあるか徹底的に調査する」
//
// ① 経路ごとに「AI が書いた文」に最終チェックが掛かった割合（ai_reply_examples.entry_source × reply_context_snapshot.preRevisionCodes）
// ② 省く／直さない道（暗黙の省き）ごとに、スタッフがそのまま送った率・直した率・使わなかった率
//    道: 指摘0 / 文体だけで書き直しなし / 書き直した / 事実の warning が残った（書き直しが捨てられた・時間切れ・根拠の引用が本文に無い）/ block が残った / センシティブ
// ③ 画面に出た指摘（finalCheckCodes）の種類ごとに、そのまま送られた率・直された率
// ④ line_watch_turns（10/01〜・根拠の引用 evidence あり）で、指摘の引用がスタッフの実送信に残ったか（＝直されずに届いた）
// ⑤ AIX（最終チェックを通らない）の AI の文に決定論の検査を当て直し、block の種類と、その引用がスタッフの実送信に残ったか
// ⑥ 見逃し: 最終チェックで事実の指摘が無かったのに、スタッフが数字・日付・号室・物件名・呼び名を変えて送った回（目で読む用）
//
// 実行: npx tsx --env-file=.env.local scripts/audit-final-check-coverage.ts [--since=2026-09-20] [--detail] [--no-aix]
import { createClient } from "@supabase/supabase-js";
import { classifyIssueScope, isStyleNoErrorCode } from "../app/lib/final-check-scope";
import { runDeterministicChecks, type FinalCheckContext, type CheckIssue } from "../app/lib/final-check";
import { resolveAddressName } from "../app/lib/validate-reply";
import { isUsableExampleText } from "../app/lib/example-hygiene";
import { MSG_SEP } from "../app/lib/reply-context";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d = "") => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=").slice(1).join("=");
const SINCE = arg("since", "2026-09-20");
const DETAIL = process.argv.includes("--detail");
const NO_AIX = process.argv.includes("--no-aix");
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
async function page(table: string, select: string, build: (q: any) => any): Promise<Row[]> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const out: Row[] = [];
  for (let p = 0; p < 60; p++) {
    const { data, error } = await build(sb.from(table).select(select)).range(p * 1000, p * 1000 + 999);
    if (error) { console.log(`⚠ ${table}: ${error.message}`); break; }
    out.push(...(data ?? [])); if ((data ?? []).length < 1000) break;
  }
  return out;
}
const norm = (s: string) => String(s ?? "").replace(/\p{Extended_Pictographic}|\u{FE0F}|\u{200D}/gu, "").replace(/[\s　！!。、]+/g, "");
const one = (s: string, n = 120) => String(s ?? "").replace(/\s*\n\s*/g, " / ").slice(0, n);
const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : "-");
const codeOf = (x: string) => String(x).split(":")[0];
const sevOf = (x: string) => String(x).split(":")[1] ?? "";

type Outcome = "as_is" | "edited" | "not_used";
function outcomeOf(e: Row): Outcome {
  const d = norm(e.ai_draft ?? ""), s = norm(e.sent_reply ?? "");
  if (d && s && d === s) return "as_is";
  if (e.was_ai_used || (e.ai_similarity ?? 0) >= 0.5) return "edited";
  return "not_used";
}
function tally(rows: Row[]): string {
  const n = rows.length; const c = { as_is: 0, edited: 0, not_used: 0 } as Record<Outcome, number>;
  for (const r of rows) c[outcomeOf(r)]++;
  return `n=${n}  そのまま ${pct(c.as_is, n)}  直して送る ${pct(c.edited, n)}  使わない ${pct(c.not_used, n)}`;
}

/** 事実の語（数字・日付・号室・円・万）を取り出す */
function factTokens(s: string): string[] {
  const t = String(s ?? "").normalize("NFKC");
  const out = new Set<string>();
  for (const m of t.matchAll(/\d{1,2}\/\d{1,2}|\d{1,2}月\d{1,2}日|\d{1,2}日|\d{1,2}[:：時]\d{0,2}分?|\d{2,5}号室|\d+(?:\.\d+)?万円?|\d{1,3}(?:,\d{3})+円?|\d+円|\d+ヶ月|\d+(?:\.\d+)?㎡|徒歩\d+分/g)) out.add(m[0]);
  return [...out];
}

async function main() {
  console.log(`=== 最終チェックの点検（${SINCE}〜・YUMA を除く） ===\n`);
  const ex = (await page("ai_reply_examples", "id, conversation_id, created_at, sent_at, entry_source, aix_action, ai_draft, sent_reply, customer_message, was_ai_used, was_ai_modified, ai_similarity, reply_context_snapshot",
    (q) => q.gte("created_at", SINCE).order("created_at"))).filter((e) => e.conversation_id !== YUMA);

  // ── ① 経路ごとの掛かり方 ──
  console.log("■① AI が書いた文に最終チェックが掛かった割合（経路別・ai_draft がある送信の例）");
  const bySrc = new Map<string, { n: number; fc: number }>();
  for (const e of ex) {
    if (!String(e.ai_draft ?? "").trim() || /^__/.test(String(e.ai_draft))) continue;
    const k = String(e.entry_source ?? "?");
    const v = bySrc.get(k) ?? { n: 0, fc: 0 }; v.n++; if (e.reply_context_snapshot?.preRevisionCodes) v.fc++; bySrc.set(k, v);
  }
  for (const [k, v] of [...bySrc].sort((a, b) => b[1].n - a[1].n)) console.log(`  ${k.padEnd(18)} 下書き ${String(v.n).padStart(4)}  最終チェックあり ${String(v.fc).padStart(4)}（${pct(v.fc, v.n)}）`);
  const aixActs = new Map<string, number>();
  for (const e of ex) if (String(e.entry_source ?? "").startsWith("aix") && String(e.ai_draft ?? "").trim()) aixActs.set(String(e.aix_action ?? "?"), (aixActs.get(String(e.aix_action ?? "?")) ?? 0) + 1);
  console.log(`  AIX の種類（多い順）: ${[...aixActs].sort((a, b) => b[1] - a[1]).slice(0, 14).map(([k, n]) => `${k} ${n}`).join(" / ")}`);

  // ── ② 省く・直さない道ごとの結果 ──
  const fcRows = ex.filter((e) => e.entry_source === "line_reply" && e.reply_context_snapshot?.preRevisionCodes && String(e.ai_draft ?? "").trim() && isUsableExampleText(e.sent_reply ?? ""));
  console.log(`\n■② 最終チェックが掛かった返信の下書き ${fcRows.length}件: 道ごとのスタッフの扱い`);
  const lane = (e: Row): string => {
    const s = e.reply_context_snapshot;
    const pre: string[] = s.preRevisionCodes ?? [];
    const fin: string[] = s.finalCheckCodes ?? [];
    const gate = s.finalCheckGate ?? null;
    const preReal = pre.filter((x) => sevOf(x) !== "info");
    const finFact = fin.filter((x) => sevOf(x) !== "info" && classifyIssueScope(codeOf(x)) !== "style");
    if (fin.some((x) => codeOf(x) === "SENSITIVE_CASE")) return "6 センシティブ（書き直しなし）";
    if (preReal.length === 0) return "1 指摘なし";
    if (gate?.draftIn || (s.revisionOutcome === "ok" && finFact.length === 0 && preReal.some((x) => classifyIssueScope(codeOf(x)) !== "style"))) {
      return finFact.length ? "3b 書き直した・事実の指摘が残る" : "3a 書き直した or 事実の指摘が消えた";
    }
    if (gate?.revisionSkipped === "style_only" || preReal.every((x) => classifyIssueScope(codeOf(x)) === "style" || isStyleNoErrorCode(codeOf(x)))) return "2 文体だけ（書き直しなし）";
    if (finFact.some((x) => sevOf(x) === "block")) return "5 block が残った（直せず）";
    if (finFact.length) return "4 事実の warning が残った（書き直されず）";
    return "7 その他";
  };
  const lanes = new Map<string, Row[]>();
  for (const e of fcRows) { const k = lane(e); lanes.set(k, [...(lanes.get(k) ?? []), e]); }
  for (const [k, rows] of [...lanes].sort()) console.log(`  ${k.padEnd(30)} ${tally(rows)}`);
  const gateRows = fcRows.filter((e) => e.reply_context_snapshot.finalCheckGate);
  const gateRun = new Map<string, number>();
  for (const e of gateRows) { const g = e.reply_context_snapshot.finalCheckGate; const k = `${g.run}/${g.mode}`; gateRun.set(k, (gateRun.get(k) ?? 0) + 1); }
  console.log(`  要否の判定（影の運用）: ${[...gateRun].map(([k, n]) => `${k} ${n}`).join(" / ") || "記録なし"}`);
  const reasons = new Map<string, number>();
  for (const e of gateRows) for (const r of e.reply_context_snapshot.finalCheckGate.reasons ?? []) reasons.set(r, (reasons.get(r) ?? 0) + 1);
  console.log(`  full の理由: ${[...reasons].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(" / ")}`);
  // 2026-10-06〜: 書き直しを採らなかった理由（finalCheckGate.revisionDropped・CheckResult.revision_dropped）
  const dropped = new Map<string, Row[]>();
  for (const e of gateRows) { const d = e.reply_context_snapshot.finalCheckGate.revisionDropped; if (d) dropped.set(d, [...(dropped.get(d) ?? []), e]); }
  console.log(`  書き直しを採らなかった理由: ${[...dropped].map(([k, rows]) => `${k} ${rows.length}`).join(" / ") || "記録なし（10/06 以降の下書きから記録）"}`);

  // ── ③ 画面に出た指摘の種類ごと ──
  console.log("\n■③ 画面に出た指摘（finalCheckCodes・文体を除く）の種類ごとのスタッフの扱い");
  const byCode = new Map<string, Row[]>();
  for (const e of fcRows) {
    const fin: string[] = e.reply_context_snapshot.finalCheckCodes ?? [];
    for (const c of new Set(fin.filter((x) => sevOf(x) !== "info" && classifyIssueScope(codeOf(x)) !== "style"))) byCode.set(c, [...(byCode.get(c) ?? []), e]);
  }
  for (const [k, rows] of [...byCode].sort((a, b) => b[1].length - a[1].length)) console.log(`  ${k.padEnd(40)} ${tally(rows)}`);
  const noShown = fcRows.filter((e) => !(e.reply_context_snapshot.finalCheckCodes ?? []).some((x: string) => sevOf(x) !== "info" && classifyIssueScope(codeOf(x)) !== "style"));
  console.log(`  （参考）事実・安全の指摘なし                ${tally(noShown)}`);

  // ── ④ 指摘の引用が実送信に残ったか（line_watch_turns） ──
  const lw = (await page("line_watch_turns", "id, conversation_id, customer_turn_at, final_check, staff_texts", (q) => q.not("final_check", "is", null).order("id"))).filter((t) => t.conversation_id !== YUMA);
  console.log(`\n■④ line_watch_turns ${lw.length}番: 画面に出た指摘の引用がスタッフの実送信に残ったか（残った＝直されずに届いた／誤発火）`);
  const ev = new Map<string, { n: number; kept: number; fixed: number; noSend: number; ex: string[] }>();
  for (const t of lw) {
    const sent = (Array.isArray(t.staff_texts) ? t.staff_texts : []).map((x: any) => (typeof x === "string" ? x : x?.text ?? "")).join("\n"); // eslint-disable-line @typescript-eslint/no-explicit-any
    for (const i of (t.final_check?.issues ?? []) as Array<{ code: string; severity: string; evidence?: string }>) {
      if (classifyIssueScope(i.code) === "style") continue;
      const k = `${i.code}:${i.severity}`; const v = ev.get(k) ?? { n: 0, kept: 0, fixed: 0, noSend: 0, ex: [] }; v.n++;
      const e = norm(i.evidence ?? "");
      if (!sent.trim()) v.noSend++;
      else if (e.length >= 6 && norm(sent).includes(e)) { v.kept++; if (v.ex.length < 4) v.ex.push(one(i.evidence ?? "", 60)); }
      else v.fixed++;
      ev.set(k, v);
    }
  }
  for (const [k, v] of [...ev].sort((a, b) => b[1].n - a[1].n)) {
    console.log(`  ${k.padEnd(40)} n=${String(v.n).padStart(3)}  引用が届いた ${v.kept}  直された/別の文 ${v.fixed}  まだ送っていない ${v.noSend}`);
    if (DETAIL) for (const x of v.ex) console.log(`      └ 届いた引用: ${x}`);
  }

  // ── ⑤ AIX に決定論の検査を当て直す ──
  if (!NO_AIX) {
    const aix = ex.filter((e) => String(e.entry_source ?? "").startsWith("aix") && String(e.ai_draft ?? "").trim() && isUsableExampleText(e.ai_draft ?? "") && e.conversation_id);
    console.log(`\n■⑤ AIX の AI の文 ${aix.length}件（最終チェックを通らない）に決定論の検査を当て直す`);
    const convIds = [...new Set(aix.map((e) => String(e.conversation_id)))];
    const msgsOf = new Map<string, Row[]>();
    const names = new Map<string, string>();
    for (let i = 0; i < convIds.length; i += 100) {
      const { data } = await sb.from("conversations").select("id, customer_name").in("id", convIds.slice(i, i + 100));
      for (const c of data ?? []) names.set(String(c.id), String(c.customer_name ?? ""));
    }
    const queue = [...convIds];
    await Promise.all(Array.from({ length: 6 }, async () => {
      for (let cid = queue.shift(); cid; cid = queue.shift()) {
        const { data } = await sb.from("messages").select("sender, text, created_at, is_aix_generated").eq("conversation_id", cid).order("created_at", { ascending: false }).limit(400);
        msgsOf.set(cid, ((data ?? []) as Row[]).reverse().filter((m) => typeof m.text === "string"));
      }
    }));
    const hit = new Map<string, { n: number; kept: number; changed: number; acts: Map<string, number>; ex: string[] }>();
    let checked = 0, anyBlock = 0;
    for (const e of aix) {
      const msgs = msgsOf.get(String(e.conversation_id)) ?? [];
      const at = Date.parse(e.sent_at ?? e.created_at);
      const before = msgs.filter((m) => Date.parse(m.created_at) < at - 1000);
      const custUnits: string[] = [];
      for (let j = before.length - 1; j >= 0 && before[j].sender !== "staff"; j--) if (before[j].sender === "customer") custUnits.unshift(before[j].text);
      const addr = resolveAddressName({ messages: before.map((x) => ({ sender: x.sender, text: x.text, createdAt: x.created_at })), displayName: names.get(String(e.conversation_id)) ?? "", pcName: "" });
      const ctx: FinalCheckContext = {
        lastCustomerMessage: custUnits.join(MSG_SEP), recentMessages: before.slice(-10).map((x) => ({ sender: x.sender, text: x.text, createdAt: x.created_at, isAix: !!x.is_aix_generated })),
        customerName: addr.name, nameAliases: addr.aliases, now: at, isDeliverableReply: true, isAix: true,
      };
      let issues: CheckIssue[] = [];
      try { issues = runDeterministicChecks(String(e.ai_draft), ctx); } catch { continue; }
      checked++;
      const blocks = issues.filter((i) => i.severity === "block" && classifyIssueScope(i.code) !== "style");
      if (blocks.length) anyBlock++;
      const sentN = norm(e.sent_reply ?? "");
      for (const b of blocks) {
        const v = hit.get(b.code) ?? { n: 0, kept: 0, changed: 0, acts: new Map<string, number>(), ex: [] as string[] }; v.n++;
        const evn = norm(b.evidence ?? "");
        if (evn.length >= 4 && sentN.includes(evn)) v.kept++; else v.changed++;
        v.acts.set(String(e.aix_action), (v.acts.get(String(e.aix_action)) ?? 0) + 1);
        if (v.ex.length < 5) v.ex.push(`[${e.aix_action}] 引用「${one(b.evidence ?? "", 50)}」 ${evn.length >= 4 && sentN.includes(evn) ? "→送った文に残る" : "→送った文で変わった"}`);
        hit.set(b.code, v);
      }
    }
    console.log(`  検査 ${checked}件・block（文体を除く）が1つでもある ${anyBlock}件（${pct(anyBlock, checked)}）`);
    for (const [k, v] of [...hit].sort((a, b) => b[1].n - a[1].n)) {
      console.log(`  ${k.padEnd(36)} n=${String(v.n).padStart(3)}  送った文に残る ${v.kept}  変わった ${v.changed}  （${[...v.acts].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([a, n]) => `${a} ${n}`).join("・")}）`);
      if (DETAIL) for (const x of v.ex) console.log(`      └ ${x}`);
    }
  }

  // ── ⑦ AIX の文でスタッフが事実の語（数字・日付・号室・金額）を消した／変えた回（AIX は最終チェックを通らない） ──
  {
    const aixUsed = ex.filter((e) => String(e.entry_source ?? "").startsWith("aix") && String(e.ai_draft ?? "").trim() && isUsableExampleText(e.ai_draft ?? "") && outcomeOf(e) !== "not_used");
    const byAct = new Map<string, { n: number; changed: number; ex: string[] }>();
    for (const e of aixUsed) {
      const k = String(e.aix_action ?? "?"); const v = byAct.get(k) ?? { n: 0, changed: 0, ex: [] }; v.n++;
      const st = new Set(factTokens(e.sent_reply));
      const gone = factTokens(e.ai_draft).filter((x) => !st.has(x));
      if (gone.length && outcomeOf(e) === "edited") { v.changed++; if (v.ex.length < 4) v.ex.push(`消えた語 ${gone.slice(0, 4).join("・")} ｜ 下書き: ${one(e.ai_draft, 110)} ｜ 送った: ${one(e.sent_reply, 110)}`); }
      byAct.set(k, v);
    }
    const tot = [...byAct.values()].reduce((a, v) => ({ n: a.n + v.n, c: a.c + v.changed }), { n: 0, c: 0 });
    console.log(`\n■⑦ AIX の文（使った ${tot.n}件）でスタッフが事実の語を消した／変えた回 ${tot.c}件（${pct(tot.c, tot.n)}）`);
    for (const [k, v] of [...byAct].sort((a, b) => b[1].changed - a[1].changed).slice(0, 10)) {
      console.log(`  ${k.padEnd(36)} 使った ${String(v.n).padStart(3)}  事実の語が変わった ${v.changed}（${pct(v.changed, v.n)}）`);
      if (DETAIL) for (const x of v.ex) console.log(`      └ ${x}`);
    }
  }

  // ── ⑥ 見逃しの候補: 事実の指摘なし・スタッフが事実の語を変えた ──
  console.log("\n■⑥ 見逃しの候補: 最終チェックで事実の指摘が出なかったのに、スタッフが数字・日付・号室・金額を消した／変えた回");
  const miss: Row[] = [];
  for (const e of noShown) {
    if (outcomeOf(e) !== "edited") continue;
    const dt = factTokens(e.ai_draft), st = new Set(factTokens(e.sent_reply));
    const gone = dt.filter((x) => !st.has(x));
    if (gone.length) miss.push({ ...e, gone });
  }
  const used = noShown.filter((e) => outcomeOf(e) !== "not_used");
  console.log(`  事実の指摘なし・使った ${used.length}件のうち、事実の語を消した／変えた ${miss.length}件（${pct(miss.length, used.length)}）`);
  for (const e of miss.slice(0, DETAIL ? 60 : 12)) {
    console.log(`  - ${String(e.created_at).slice(0, 10)} ${String(e.conversation_id).slice(0, 8)} 消えた語 ${(e.gone as string[]).join("・")}`);
    console.log(`      お客様: ${one(e.customer_message ?? "", 90)}`);
    console.log(`      下書き: ${one(e.ai_draft, 160)}`);
    console.log(`      送った: ${one(e.sent_reply, 160)}`);
  }
}

main().catch((e) => { console.error(e); process.exit(2); });
