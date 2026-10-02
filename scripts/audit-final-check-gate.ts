// scripts/audit-final-check-gate.ts — 最終チェック（LLM の3パス＋書き直し）が要る下書きかの監査（読み取りのみ・LLM なし）
//
// 2026-10-02 竹内「いま全部ファイナルチェックしているので、ファイナルチェックが必要かどうかの監査をつけたら
//   APIも節約できるし、無駄がなくなる」
//
// やる事:
//   ① 過去の最終チェックの記録を集める
//      A. ai_reply_examples.reply_context_snapshot（送った例ごと・preRevisionCodes＝修正前の指摘／finalCheckCodes）
//      B. line_watch_turns（10/01〜・お客様の番ごと・final_check.pre）
//   ② 下書きの危なさで分ける（app/lib/final-check-gate.ts の needsFinalCheck・本番と同じ関数）
//   ③ LLM の段（rule_check・anomaly_scan・context_check）が見つけた事実・安全の指摘を、群ごとに数える
//   ④ skip になる群で LLM が何か見つけた回を全部並べる（＝本当の指摘か目で読む。見逃し0の線か）
//   ⑤ llm_usage_logs（本番）で1回あたりの費用・所要時間を出し、省ける額を見積もる
//   ⑥ 部分的に省く案（Sonnet の context_check だけ省く）と比べる
//   ⑦ 影の運用の記録（ai_draft_check.gate・line_watch_turns.final_check.gate）があれば、本番の skip 率と見逃しを出す
//
// 実行: npx tsx --env-file=.env.local scripts/audit-final-check-gate.ts [--since=2026-09-10] [--detail] [--cost-days=3]
//   --detail  skip になる下書きを全部表示する（見逃しが無いか目で読む用）
import { createClient } from "@supabase/supabase-js";
import { classifyIssueScope } from "../app/lib/final-check-scope";
import { needsFinalCheck, type FinalCheckGateDecision } from "../app/lib/final-check-gate";
import { detectSensitiveCase } from "../app/lib/sensitive-case";
import { claudeUsageUsd } from "../app/lib/llm-price";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d = "") => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=").slice(1).join("=");
const SINCE = arg("since", "2026-09-10");
const DETAIL = process.argv.includes("--detail");
const COST_FROM = arg("cost-from", "2026-09-30T00:00:00+09:00");

// 決定論の段が出す code（generate-reply の DET_CODES_RE と同じ＋決定論の関数が出す物）。これ以外が LLM の段の指摘
const DET_RE = /^(?:BANNED_WORD|THANK_OPENING|GRATITUDE_OPENING|CONDITION_OPENING|EXCLAMATION_OVERUSE|NG_PROPERTY_MENTION|INTRO_REPEAT|WE_DO_MISSING_DET|GENERIC_ONLY_REPLY|REPLY_SKELETON_MISSING|CONCERN_UNADDRESSED|EMPTY_CLOSER|PAIR_ELEMENT_MISSING|SPLIT_ACK_REPLY|FEELING_TEMPLATE|SYMPATHY_ECHO|NAME_|PROMISE_ECHO_MISSING|TIME_INVALID_HONIJITSU|EMOJI_RULE_DET|SYSTEM_MARKER_LEAK|QUOTE_UNBALANCED|NEGATIVE_APOLOGY|HASTY_PROMISE|ESTIMATE_NO_TRIGGER|STATE_REGRESSION|VIEWING_BEFORE_VACANCY|APPLY_WITHOUT_INTENT|POST_APPLY_VIEWING|TENSE_MISMATCH|FEEDBACK_PREMATURE|GOCHOUGO_|CONFIRM_|PHOTO_|JUSHU_|GUIDE_|SASETE_OVERUSE|APPLY_PUSH_NO_INTENT|UNSENT_CLAIM|SELF_HONORIFIC|ECHO_CONFIRM|LIST_STRUCTURE|DOUBLE_KEIGO|FABRICATED_POLICY_DET|FAREWELL_ON_MOVEOUT_INFO|DISCLOSURE_ASSERTION|VACANCY_ASSERTION|MOVEIN_DATE_ASSERTION|SCREENING_ASSURANCE|OPENING_GREETING_|OPENER_MISMATCH|PREEMPTIVE_HEDGE|FABRICATED_SEARCH_REPORT|CONDITION_RELAX_UNASKED|HEDGE_WITHOUT_SEARCH_DECL|SELF_HEDGE_ECHO|CLOSER_MISSING|COMMIT_AFTER_DELIVERABLE|NANISOTSU_MISPLACED|PASSIVE_CLOSER|RESULT_EXCUSE|CONDITION_ECHO_MISSING|SCHEDULE_ASSERT_UNCONFIRMED|FACT_DEFERRED_ANSWER|WIDEN_EXCUSE_REDUNDANT|REASSURANCE_NO_BASIS|URGENCY_NO_INTENT|CONSIDER_PUSH|HUMBLE_WAIT|DONE_PRESUPPOSED_WITHOUT_EVIDENCE|PROMISE_ECHO_MISMATCH|UNPROMPTED_PROPOSAL|CELL_AVOID_CONFLICT|ECHO_FROM_BRAIN_NOT_CUSTOMER|CLOSING_FORWARD_PUSH|TYPO_|COMPANY_FACT_|UNANCHORED_VOCAB|UNGROUNDED_CONDITION|RENT_NEGOTIATION_PROMISE|MGMT_DISCOUNT_|APPLY_THANKS_|PARTIALLY_UNCHECKED|UNCHECKED_AUTO_SEND|SENSITIVE_CASE|DUPLICATE_OF_SENT|REPEATED_SENTENCE|VIEWING_DATE_ASK_WITHOUT_AIX|VOCAB_MIRROR_MISMATCH)/;
/** LLM の段ごとの code（プロンプトの定義から） */
function passOf(code: string): "rule_check" | "anomaly_scan" | "context_check" {
  if (/^FABRICATED_/.test(code)) return "anomaly_scan";
  if (/^(?:RULE_VIOLATION|AIX_BOUNDARY_|TIMING_VOCAB_MISMATCH|ADVERSARIAL)/.test(code)) return "rule_check";
  return "context_check";
}
type LlmHit = { code: string; sev: string; pass: string };
function llmFactHits(codes: string[] | null | undefined): LlmHit[] {
  return (codes ?? []).map((x) => String(x).split(":")).filter(([c]) => c && !DET_RE.test(c) && classifyIssueScope(c) !== "style")
    .map(([c, s]) => ({ code: c, sev: s ?? "?", pass: passOf(c) }));
}
const detBlockOf = (codes: string[] | null | undefined) => (codes ?? []).some((x) => { const [c, s] = String(x).split(":"); return DET_RE.test(c) && s === "block" && classifyIssueScope(c) !== "style"; });

async function page(table: string, select: string, build: (q: any) => any) { // eslint-disable-line @typescript-eslint/no-explicit-any
  const out: Array<Record<string, any>> = []; // eslint-disable-line @typescript-eslint/no-explicit-any
  for (let p = 0; p < 50; p++) {
    const { data, error } = await build(sb.from(table).select(select)).range(p * 1000, p * 1000 + 999);
    if (error) { console.log(`⚠ ${table}: ${error.message}`); break; }
    out.push(...(data ?? [])); if ((data ?? []).length < 1000) break;
  }
  return out;
}
const one = (s: string, n = 140) => String(s ?? "").replace(/\s*\n\s*/g, " / ").slice(0, n);
const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : "-");

type Run = {
  src: "example" | "watch"; id: string; conv: string; at: string;
  draft: string; customer: string; sent: string | null;
  pre: string[]; fin: string[]; revised: boolean;
  firstContact: boolean; autoSend: boolean;
  gate: FinalCheckGateDecision; hits: LlmHit[];
};

async function main() {
  // ── ① 材料 ──
  const convAuto = new Map<string, boolean>();
  for (const c of await page("conversations", "id, auto_send_enabled", (q) => q.eq("auto_send_enabled", true))) convAuto.set(String(c.id), true);

  const ex = await page("ai_reply_examples", "id, conversation_id, created_at, sent_reply, ai_draft, customer_message, reply_context_snapshot", (q) => q.gte("created_at", SINCE).order("created_at"));
  const runs: Run[] = [];
  for (const e of ex) {
    const s = e.reply_context_snapshot as Record<string, any> | null; // eslint-disable-line @typescript-eslint/no-explicit-any
    if (!s?.preRevisionCodes) continue;
    const draft = String(e.ai_draft ?? "").trim() || String(s.draftHead ?? "").trim();
    const customer = String(e.customer_message ?? "");
    const pre = s.preRevisionCodes as string[], fin = (s.finalCheckCodes ?? []) as string[];
    const firstContact = s.greeting?.kind === "first";
    const autoSend = convAuto.get(String(e.conversation_id)) === true;
    const gate = needsFinalCheck({
      draft, customerText: customer, customerName: s.address_name?.name ?? null,
      isSensitive: !!detectSensitiveCase(customer), isAutoSendConversation: autoSend,
      isFirstContact: firstContact, detBlock: detBlockOf(pre),
    });
    const hits = llmFactHits(pre);
    runs.push({ src: "example", id: String(e.id), conv: String(e.conversation_id), at: String(e.created_at), draft, customer, sent: String(e.sent_reply ?? ""),
      pre, fin, revised: hits.length > 0 && llmFactHits(fin).length < hits.length, firstContact, autoSend, gate, hits });
  }
  // B. line_watch_turns（お客様の番ごと）。お客様の発言は messages から（番の最初〜最後）
  const lw = await page("line_watch_turns", "id, conversation_id, customer_turn_at, customer_last_at, draft_first, draft_last, final_check, staff_texts, created_at", (q) => q.not("final_check", "is", null).order("created_at"));
  for (const t of lw) {
    const fc = t.final_check as Record<string, any> | null; // eslint-disable-line @typescript-eslint/no-explicit-any
    const draft = String(t.draft_first ?? "").trim();
    if (!fc || !draft || /^\[|^__/.test(draft)) continue;
    const { data: msgs } = await sb.from("messages").select("text, sender, created_at").eq("conversation_id", t.conversation_id)
      .eq("sender", "customer").gte("created_at", t.customer_turn_at).lte("created_at", t.customer_last_at ?? t.customer_turn_at).order("created_at").limit(20);
    const customer = (msgs ?? []).map((m) => String(m.text ?? "")).join("\n");
    const pre = (fc.pre ?? []) as string[], fin = (fc.final_codes ?? []) as string[];
    const autoSend = convAuto.get(String(t.conversation_id)) === true;
    const gate = needsFinalCheck({ draft, customerText: customer, isSensitive: !!detectSensitiveCase(customer), isAutoSendConversation: autoSend, detBlock: detBlockOf(pre) });
    const hits = llmFactHits(pre);
    const staff = Array.isArray(t.staff_texts) ? (t.staff_texts as string[]).join(" / ") : (t.staff_texts ? String(t.staff_texts) : null);
    runs.push({ src: "watch", id: String(t.id), conv: String(t.conversation_id), at: String(t.created_at), draft, customer, sent: staff, pre, fin,
      revised: Number(fc.revision_count ?? 0) > 0, firstContact: false, autoSend, gate, hits });
  }

  console.log(`=== ① 材料: 最終チェックの記録 ${runs.length}回（送った例 ${runs.filter((r) => r.src === "example").length}・LINE の見張り ${runs.filter((r) => r.src === "watch").length}・${SINCE}〜）===`);

  // ── ②③ 群ごとの指摘 ──
  const groups = new Map<string, Run[]>();
  for (const r of runs) {
    const k = r.gate.run === "skip" ? "skip（決まり文句だけ×了承だけ）" : r.gate.reasons.includes("draft_has_content") ? "full: 下書きに中身あり" : `full: ${r.gate.reasons.join("+")}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(r);
  }
  console.log(`\n=== ②③ 群ごとに、LLM の段が見つけた事実・安全の指摘（修正前）===`);
  console.log(`   群                                       回数   LLMの指摘あり   うち block   rule/anomaly/context`);
  for (const [k, rs] of [...groups].sort((a, b) => b[1].length - a[1].length)) {
    const h = rs.filter((r) => r.hits.length);
    const b = rs.filter((r) => r.hits.some((x) => x.sev === "block"));
    const byPass = ["rule_check", "anomaly_scan", "context_check"].map((p) => rs.filter((r) => r.hits.some((x) => x.pass === p)).length).join("/");
    console.log(`   ${k.padEnd(40)} ${String(rs.length).padStart(4)}   ${String(h.length).padStart(4)} (${pct(h.length, rs.length).padStart(6)})   ${String(b.length).padStart(4)}       ${byPass}`);
  }
  // 下書きの中身あり × お客様が了承だけ（＝Sonnet だけ省く案の対象）
  const ackContent = runs.filter((r) => r.gate.run === "full" && r.gate.reasons.join() === "draft_has_content");
  const skip = runs.filter((r) => r.gate.run === "skip");
  console.log(`\n   skip の割合: ${skip.length}/${runs.length}（${pct(skip.length, runs.length)}）`);

  // ── ④ skip の群で LLM が何か見つけた回（全部読む）──
  console.log(`\n=== ④ skip になる下書きで、LLM の段が事実・安全の指摘を出した回（本当の指摘か目で読む）===`);
  for (const r of skip.filter((x) => x.hits.length)) {
    console.log(`${"─".repeat(70)}\n   [${r.src}] ${r.at.slice(0, 16)} conv=${r.conv.slice(0, 8)} 指摘=${r.hits.map((x) => `${x.code}:${x.sev}`).join(",")} 修正後=${r.fin.join(",") || "なし"}${r.revised ? "（書き直しあり）" : ""}`);
    console.log(`   客: ${one(r.customer)}\n   案: ${one(r.draft)}\n   実: ${one(r.sent ?? "")}`);
  }
  if (DETAIL) {
    console.log(`\n=== skip になる下書き 全${skip.length}件 ===`);
    for (const r of skip) console.log(`   [${r.src}] 客「${one(r.customer, 50)}」→ 案「${one(r.draft, 80)}」${r.sent && r.sent.trim() !== r.draft.trim() ? ` → 実「${one(r.sent, 80)}」` : "（そのまま）"}`);
  }

  // ── ⑤ 費用・所要時間（本番の llm_usage_logs）──
  const logs = await page("llm_usage_logs", "created_at, model, action, env, input_uncached, cache_read, cache_write_5m, cache_write_1h, cache_write, output_tokens, duration_ms",
    (q) => q.eq("env", "production").like("action", "final_check%").gte("created_at", new Date(COST_FROM).toISOString()).order("created_at"));
  const days = Math.max(1, (Date.now() - new Date(COST_FROM).getTime()) / 86400_000);
  const by = new Map<string, { n: number; usd: number; ms: number[] }>();
  for (const l of logs) {
    const a = String(l.action);
    const b = by.get(a) ?? { n: 0, usd: 0, ms: [] };
    b.n++; b.usd += claudeUsageUsd(l as never); if (Number.isFinite(Number(l.duration_ms))) b.ms.push(Number(l.duration_ms));
    by.set(a, b);
  }
  const med = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };
  console.log(`\n=== ⑤ 本番の最終チェックの費用（${COST_FROM.slice(0, 10)}〜・${days.toFixed(1)}日・llm_usage_logs の単価）===`);
  for (const [a, b] of [...by].sort((x, y) => y[1].usd - x[1].usd)) console.log(`   ${a.padEnd(34)} ${String(b.n).padStart(4)}回  $${b.usd.toFixed(3).padStart(7)}  1回 $${(b.usd / b.n).toFixed(4)}  中央値 ${med(b.ms)}ms`);
  const g = (a: string) => by.get(a) ?? { n: 0, usd: 0, ms: [] };
  const checks = g("final_check_rule_check").n || 1;
  const perRunAll = ["final_check_rule_check", "final_check_anomaly_scan", "final_check_context_check", "final_check_revision", "final_check_recheck", "final_check_verify"].reduce((s, a) => s + g(a).usd, 0) / checks;
  const perRunCtx = g("final_check_context_check").usd / checks;
  const perDay = checks / days;
  // skip の群は書き直しがほぼ起きない（上の表）＝省ける額は3パス分＋その群で実際に起きた書き直しの割合
  const skipShare = skip.length / Math.max(1, runs.length);
  const skipRevShare = skip.filter((r) => r.revised).length / Math.max(1, skip.length);
  const passUsd = (g("final_check_rule_check").usd + g("final_check_anomaly_scan").usd + g("final_check_context_check").usd) / checks;
  const revUsd = (g("final_check_revision").usd + g("final_check_recheck").usd) / Math.max(1, g("final_check_revision").n);
  const savedPerSkip = passUsd + skipRevShare * revUsd;
  console.log(`   1日 ${perDay.toFixed(1)}回の検査・1回あたり（書き直し込み）$${perRunAll.toFixed(4)}＝1日 $${(perRunAll * perDay).toFixed(2)}`);
  console.log(`\n=== ⑥ 案の比べ（見積もり）===`);
  console.log(`   A. skip（決まり文句だけ×了承だけ・3パス＋書き直しを省く）: 対象 ${pct(skip.length, runs.length)} → 1日 約 ${(perDay * skipShare).toFixed(1)}回・$${(perDay * skipShare * savedPerSkip).toFixed(3)}／日・待ち時間 約 ${Math.max(med(g("final_check_rule_check").ms), med(g("final_check_context_check").ms), med(g("final_check_anomaly_scan").ms))}ms 短く`);
  const ctxMiss = ackContent.filter((r) => r.hits.some((x) => x.pass === "context_check"));
  console.log(`   B. Sonnet の context_check だけ省く（下書きに中身あり×お客様は了承だけ ${ackContent.length}回）: $${(perDay * (ackContent.length / Math.max(1, runs.length)) * perRunCtx).toFixed(3)}／日 ／ ただし context_check の指摘を見逃す回 ${ctxMiss.length}（${pct(ctxMiss.length, ackContent.length)}）→ 採らない`);
  for (const r of ctxMiss.slice(0, 8)) console.log(`      見逃し例: ${r.hits.filter((x) => x.pass === "context_check").map((x) => x.code).join(",")} 客「${one(r.customer, 40)}」案「${one(r.draft, 90)}」`);

  // ── ⑧ 書き直し（Sonnet の revision＋Haiku の recheck）の引き金 ──
  //   2026-10-02 監査で分かった事: 費用の一番の塊は3パスではなく書き直し。runFinalCheckWithRevision は warning でも書き直しを走らせ、
  //   文体（style）の warning も対象になる（route が style を画面から外すのはその後）＝見せない指摘のために書き直しを払っている回がある
  {
    const exRuns = runs.filter((r) => r.src === "example");
    let blk = 0, factWarn = 0, styleOnly = 0, none = 0;
    for (const r of exRuns) {
      const rev = r.pre.filter((x) => !/:info$/.test(x) && !/^TYPO_/.test(x));
      if (rev.some((x) => x.endsWith(":block") && classifyIssueScope(x.split(":")[0]) !== "style")) blk++;
      else if (rev.some((x) => classifyIssueScope(x.split(":")[0]) !== "style")) factWarn++;
      else if (rev.length) styleOnly++;
      else none++;
    }
    console.log(`\n=== ⑧ 書き直しの引き金（送った例 ${exRuns.length}回・修正前の指摘で）===`);
    console.log(`   事実・安全の block ${blk}（${pct(blk, exRuns.length)}）／ 事実・安全の warning だけ ${factWarn}（${pct(factWarn, exRuns.length)}）／ 文体の指摘だけ ${styleOnly}（${pct(styleOnly, exRuns.length)}）／ 指摘なし ${none}`);
    console.log(`   書き直し1回 $${revUsd.toFixed(4)}（revision＋recheck）・本番の書き直し ${g("final_check_revision").n}回／${days.toFixed(1)}日 ＝ $${((g("final_check_revision").usd + g("final_check_recheck").usd) / days).toFixed(2)}／日`);
    console.log(`   → 文体だけの回の書き直しを止めると 最大 1日 約 $${(perDay * (styleOnly / Math.max(1, exRuns.length)) * revUsd).toFixed(2)}（文体は画面に出さない決まり＝9/21。final-check.ts の warning の修正の入口で style を外す。竹内さんの判断待ち）`);
  }

  // ── ⑦ 影の運用の記録（実装後）──
  // 記録は2か所: conversations.ai_draft_check.tpo_debug.finalCheckGate（会話ごとの最新）／ai_reply_examples.reply_context_snapshot.finalCheckGate（送った例ごと）。
  //   pre は修正前の指摘＝影の運用では skip と判定しても LLM の段は走っているので、「skip で LLM が見つけた物」がそのまま見逃しの候補になる
  //   （作り直しがあった回は first_pass_issues も見る）
  type ShadowRow = { where: string; id: string; gate: { run?: string; applied?: boolean; reasons?: string[] }; pre: string[]; draft: string };
  const shadowRows: ShadowRow[] = [];
  for (const c of await page("conversations", "id, ai_draft, ai_draft_check, updated_at", (q) => q.gte("updated_at", "2026-10-02").not("ai_draft_check", "is", null))) {
    const k = c.ai_draft_check as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    const g = k?.tpo_debug?.finalCheckGate ?? k?.gate;
    if (g) shadowRows.push({ where: "会話の最新", id: String(c.id), gate: g, pre: [...(k.first_pass_issues ?? []), ...(k.pre_revision_issues ?? [])], draft: String(c.ai_draft ?? "") });
  }
  for (const e of ex) {
    const s = e.reply_context_snapshot as Record<string, any> | null; // eslint-disable-line @typescript-eslint/no-explicit-any
    if (s?.finalCheckGate) shadowRows.push({ where: "送った例", id: String(e.id), gate: s.finalCheckGate, pre: s.preRevisionCodes ?? [], draft: String(e.ai_draft ?? "") });
  }
  if (shadowRows.length) {
    for (const where of ["会話の最新", "送った例"]) {
      const rs = shadowRows.filter((r) => r.where === where);
      if (!rs.length) continue;
      const sk = rs.filter((r) => r.gate.run === "skip");
      const skHit = sk.filter((r) => llmFactHits(r.pre).length);
      const reasons = new Map<string, number>();
      for (const r of rs) for (const x of r.gate.reasons ?? []) reasons.set(x, (reasons.get(x) ?? 0) + 1);
      console.log(`\n=== ⑦ 影の運用（${where}）: 判定 ${rs.length}・skip ${sk.length}（${pct(sk.length, rs.length)}）・実際に省いた ${rs.filter((r) => r.gate.applied).length}・skip で LLM が事実・安全を指摘 ${skHit.length} ===`);
      console.log(`   理由: ${[...reasons].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join("・")}`);
      for (const r of skHit) console.log(`   ⚠ 見逃し候補（目で読む）: ${r.id.slice(0, 8)} ${JSON.stringify(r.pre)} 案「${one(r.draft, 80)}」`);
    }
  } else console.log(`\n=== ⑦ 影の運用の記録はまだ無い（tpo_debug.finalCheckGate）===`);
}
main().catch((e) => { console.error(e); process.exit(1); });
