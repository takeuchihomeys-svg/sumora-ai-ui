// app/lib/brain-gap-finder-server.ts（サーバー専用・DB を読むだけ・LLM なし・$0）
// ブレインの穴を自分で見つける見張りの DB 側。決まりは app/lib/brain-gap-finder.ts（純関数）。
//   読む物: line_watch_turns（番ごとの下書き・ブレインの判断・最終チェック・スタッフの実送信・判定）／brain_decision_logs（digest の la/aix/ds）／
//           messages（お客様の発言・前のこちらの送信・確認事項の一覧）／aix_usage_logs（前の物件確認の結果）／
//           conversations（今の meta の turn_contract の軸・demoted_overrides・出口の削り＝会話の最新の判断の番だけ）
//   書く物: なし（週の見張り /api/cron/reading-audit-weekly が cron_run_logs に結果を残す）
//   2026-10-15 竹内さん（設計知見【最優先】97ea82f3）。戻す: BRAIN_GAP_FINDER=off
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  findingsOfTurn, isBroughtBundle, outageTurnIds, longOpenItems, reopenedItems, summarizeGaps, brief,
  type GapTurn, type GapFinding, type GapSummary,
} from "@/app/lib/brain-gap-finder";
import { buildRequestLedger, splitRequests, TOPIC_JA, type LedgerMsg } from "@/app/lib/request-ledger";
import { matchCompanyFacts } from "@/app/lib/company-facts";
import { isTestConversation } from "@/app/lib/test-conversations";
import { buildAltNameMask, maskPIIForAlt } from "@/app/lib/pii-mask";
import { loadPartyAliasesMany, loadKnownCallNames } from "@/app/lib/pii-known-names";
import { isConditionFormMessage } from "@/app/lib/reply-context";
import { isPostApplyStatus } from "@/app/lib/llm-alt-provider";

const DAY = 86_400_000;
/** お客様自身の言葉だけ（画像・資料の読み取り・条件の様式・申込の様式・URL の行を外す＝語の網の誤爆と個人情報を避ける） */
export function customerOwnWords(text: string | null | undefined): string {
  const t = String(text ?? "");
  if (/^\s*\[(?:画像|動画|ファイル|スタンプ)\]/.test(t)) return "";
  if (isConditionFormMessage(t) || /【お?お?客様記入欄】|【お申込者様記入欄】|^\s*①【/m.test(t)) return "";
  const lines = t.split(/\n+/).filter((l) => !/https?:\/\/|^\s*by\s+\S+\s*$/i.test(l));
  // 2026-10-15 review: 括弧の無い申込の記入（緊急連絡先・勤務先・生年月日…を行ごとに書いた物）は第三者の氏名・生年が要旨に出ていたので、
  //   記入の行が3つ以上ある時は問いの行（？・か）だけ残す
  if (lines.filter((l) => APPLICATION_LINE_RE.test(l)).length >= 3) return lines.filter((l) => !APPLICATION_LINE_RE.test(l) && /[?？]|か[。！!]*\s*$/.test(l)).join("\n").trim();
  return lines.join("\n").trim();
}
const APPLICATION_LINE_RE = /緊急連絡先|連帯保証人|生年月日|昭和|平成|〒|[0-9０-９]{2,4}[-ー－][0-9０-９]{2,4}[-ー－][0-9０-９]{3,4}|続柄|勤務先|勤続|居住年数|住居年数|年収|携帯|フリガナ|^\s*[ァ-ヶー]{2,}[\s　]*[ァ-ヶー]*\s*$|(?:19|20)\d{2}\s*年/;
type Row = Record<string, unknown>;
type TurnRow = {
  id: number; conversation_id: string; customer_turn_at: string; customer_last_at: string | null; conv_status: string | null;
  draft_last: string | null; draft_sentinel: string | null; brain_action: string | null; brain_reply_mode: string | null;
  verdict: string | null; verdict_detail: Row | null; final_check: { final_codes?: string[] | null } | null;
  staff_texts: Array<{ text?: string }> | null; staff_aix: Array<{ aix_type?: string | null }> | null; decision_id: string | null;
};
type Msg = { conversation_id: string; sender: string; text: string | null; created_at: string; is_aix_generated: boolean | null };
type Press = { conversation_id: string; aix_type: string | null; check_pattern: string | null; created_at: string };
type Conv = { id: string; customer_name: string | null; account: string | null; status: string | null; meta_ts: string | null; tc: Row | null; demoted: unknown[] | null; exit_edits: unknown[] | null };

async function readAll<T>(q: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>, max = 60_000): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < max; i += 1000) {
    const r = await q(i, i + 999);
    if (r.error) throw new Error(r.error.message);
    const d = (r.data ?? []) as T[];
    out.push(...d);
    if (d.length < 1000) break;
  }
  return out;
}
const chunks = <T,>(a: T[], n: number): T[][] => { const out: T[][] = []; for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n)); return out; };

export type BrainGapReport = {
  ok: boolean; days: number; since: string; until: string;
  summary: GapSummary | null;
  /** 確認事項の見張りの数（今週） */
  ledger: { open: number; reopened: number; topics: Record<string, number> };
  /** 初回の持ち込み（今週）: 番・AI の下書きあり・下書きに一言なし（うちスタッフは書いた） */
  brought: { turns: number; withDraft: number; missing: number; staffHad: number };
  /** 新しい turn_contract の軸が入った番の数（0 の間は語と流れの手がかりだけ） */
  axisTurns: number;
  /** 申込の後でブレインを回さない番（決まり通り・穴に数えない） */
  skippedPostApply: number;
  /** 下書きも判断も届いていない番が続いた区間（障害の疑い）の番の数と区間（穴に数えない） */
  skippedOutage: number;
  outageRange: { from: string; to: string } | null;
  errors: string[];
};

/** 期間の番を読んで穴を集める（[sinceMs, untilMs)） */
async function collect(sb: SupabaseClient, sinceMs: number, untilMs: number, errors: string[]): Promise<{ findings: GapFinding[]; turns: number; ledger: BrainGapReport["ledger"]; brought: BrainGapReport["brought"]; axisTurns: number; skippedPostApply: number; skippedOutage: number; outageRange: BrainGapReport["outageRange"] }> {
  const since = new Date(sinceMs).toISOString(), until = new Date(untilMs).toISOString();
  const turns = (await readAll<TurnRow>((f, t) => sb.from("line_watch_turns")
    .select("id, conversation_id, customer_turn_at, customer_last_at, conv_status, draft_last, draft_sentinel, brain_action, brain_reply_mode, verdict, verdict_detail, final_check, staff_texts, staff_aix, decision_id")
    .gte("customer_turn_at", since).lt("customer_turn_at", until).order("customer_turn_at").order("id").range(f, t)))
    .filter((r) => !isTestConversation(r.conversation_id));
  const convIds = [...new Set(turns.map((r) => r.conversation_id))];

  // 判断ログの要点
  const digestById = new Map<string, { la?: string | null; aix?: string | null; ds?: string | null }>();
  for (const ids of chunks(turns.map((r) => r.decision_id).filter((x): x is string => !!x), 150)) {
    const { data, error } = await sb.from("brain_decision_logs").select("id, digest, decision_source").in("id", ids);
    if (error) { errors.push(`brain_decision_logs: ${error.message}`); break; }
    for (const r of (data ?? []) as Array<{ id: string; digest: Row | null; decision_source: string | null }>) {
      const d = r.digest ?? {};
      digestById.set(r.id, { la: (d.la as string | null) ?? null, aix: (d.aix as string | null) ?? null, ds: (d.ds as string | null) ?? r.decision_source ?? null });
    }
  }
  // 会話ごとの発言（確認事項の一覧に 14 日さかのぼる）・押した AIX・今の meta
  const msgSince = new Date(sinceMs - 14 * DAY).toISOString();
  const msgs = new Map<string, Msg[]>(), presses = new Map<string, Press[]>(), convs = new Map<string, Conv>();
  for (const ids of chunks(convIds, 40)) {
    const [m, p, c] = await Promise.all([
      readAll<Msg>((f, t) => sb.from("messages").select("conversation_id, sender, text, created_at, is_aix_generated").in("conversation_id", ids).gte("created_at", msgSince).lt("created_at", until).order("conversation_id").order("created_at").range(f, t)),
      readAll<Press>((f, t) => sb.from("aix_usage_logs").select("conversation_id, aix_type, check_pattern, created_at").in("conversation_id", ids).gte("created_at", msgSince).lt("created_at", until).order("created_at").range(f, t)),
      sb.from("conversations").select("id, customer_name, account, status, meta_ts:suggested_aix_meta->>analyzed_msg_ts, tc:suggested_aix_meta->turn_contract, demoted:suggested_aix_meta->demoted_overrides, exit_edits:ai_draft_check->tpo_debug->postprocess->exitEdits").in("id", ids),
    ]);
    for (const x of m) { const a = msgs.get(x.conversation_id) ?? []; a.push(x); msgs.set(x.conversation_id, a); }
    for (const x of p) { const a = presses.get(x.conversation_id) ?? []; a.push(x); presses.set(x.conversation_id, a); }
    if (c.error) errors.push(`conversations: ${c.error.message}`);
    for (const x of (c.data ?? []) as Conv[]) convs.set(x.id, x);
  }

  // 2026-10-20 決定 209b9a92: 代表の番の文（cron_run_logs に残る・見張りの報告）も、表示名だけでなく当事者の呼び名・登録名と他のお客様の呼び名を伏せる
  const altParty = await loadPartyAliasesMany(convIds).catch(() => new Map<string, string[]>());
  const altOthers = await loadKnownCallNames().catch(() => [] as string[]);
  const maskOf = (cid: string, name: string | null | undefined) => { const m = buildAltNameMask([name], altParty.get(cid) ?? [], altOthers); return (s: string) => maskPIIForAlt(s, m); };

  const findings: GapFinding[] = [];
  let axisTurns = 0, skippedPostApply = 0;
  const brought = { turns: 0, withDraft: 0, missing: 0, staffHad: 0 };
  const firstBroughtAt = new Map<string, string>();
  for (const [cid, list] of msgs) {
    // 会話の最初の持ち込みの束（連投の最初の発言の時刻）
    let k = 0;
    while (k < list.length) {
      if (list[k].sender !== "customer") { k++; continue; }
      let j = k; const b: string[] = [];
      while (j < list.length && list[j].sender === "customer") { b.push(String(list[j].text ?? "")); j++; }
      if (isBroughtBundle(b.join("\n"))) { firstBroughtAt.set(cid, list[k].created_at); break; }
      k = j;
    }
  }

  // 下書きも判断も控えに入っていない番が続いた区間（控えの止まり・ブレインの障害ではない＝outageTurnIds の注）は穴に数えない
  const outage = outageTurnIds(turns.map((r) => ({ id: r.id, at: r.customer_turn_at, missing: !r.draft_last && !r.draft_sentinel && !r.brain_action })));
  let skippedOutage = 0;
  for (const r of turns) {
    if (outage.has(String(r.id))) { skippedOutage++; continue; }
    const list = msgs.get(r.conversation_id) ?? [];
    const conv = convs.get(r.conversation_id);
    const tAt = Date.parse(r.customer_turn_at), tLast = Date.parse(r.customer_last_at ?? r.customer_turn_at);
    // 申込の後でブレインを回さない番（post-apply-brain-gate の決定）は穴に数えない
    if (((r.verdict_detail ?? {}) as { reason?: string }).reason === "no_brain" && isPostApplyStatus(r.conv_status ?? conv?.status ?? null)) { skippedPostApply++; continue; }
    const custText = list.filter((m) => m.sender === "customer" && Date.parse(m.created_at) >= tAt && Date.parse(m.created_at) <= tLast).map((m) => customerOwnWords(m.text)).filter(Boolean).join("\n");
    const before = list.filter((m) => m.sender !== "customer" && Date.parse(m.created_at) < tAt);
    const prev = before[before.length - 1];
    const pressBefore = (presses.get(r.conversation_id) ?? []).filter((p) => Date.parse(p.created_at) < tAt);
    const prevCheck = [...pressBefore].reverse().find((p) => p.check_pattern)?.check_pattern ?? null;
    const materialBefore = before.some((m) => /^\s*\[画像\]|https?:\/\//.test(String(m.text ?? "")) || !!m.is_aix_generated)
      || pressBefore.some((p) => /property|estimate|recommend|pickup/.test(p.aix_type ?? ""));
    const latest = !!conv?.meta_ts && Date.parse(conv.meta_ts) >= tAt && Date.parse(conv.meta_ts) <= tLast + 60_000;
    const asks = latest && conv?.tc && Array.isArray((conv.tc as { asks?: unknown }).asks) ? ((conv.tc as { asks: Row[] }).asks) : [];
    const axis = asks.filter((a) => typeof a.about === "string").map((a) => ({ about: a.about as string, property: (a.property as string | null) ?? null, when: (a.when as string | null) ?? null, whose: (a.whose as string | null) ?? null, route: (a.route as string | null) ?? null }));
    if (axis.length) axisTurns++;
    const firstBrought = firstBroughtAt.get(r.conversation_id) === r.customer_turn_at || (!!firstBroughtAt.get(r.conversation_id) && Math.abs(Date.parse(firstBroughtAt.get(r.conversation_id)!) - tAt) < 1000);
    const staffTexts = (r.staff_texts ?? []).map((x) => String(x.text ?? "")).filter(Boolean);
    const t: GapTurn = {
      id: r.id, conversationId: r.conversation_id, turnAt: r.customer_turn_at, status: r.conv_status,
      customerText: custText, prevStaffText: String(prev?.text ?? ""), prevCheckPattern: prevCheck,
      staffTexts, staffWriter: ((r.verdict_detail ?? {}) as { staff_writer?: string }).staff_writer ?? null,
      staffAix: (r.staff_aix ?? []).map((x) => String(x.aix_type ?? "")).filter(Boolean),
      draft: r.draft_last, sentinel: r.draft_sentinel, brainAction: r.brain_action, brainReplyMode: r.brain_reply_mode,
      verdict: r.verdict, detail: r.verdict_detail, finalCodes: (r.final_check?.final_codes ?? []).filter((x): x is string => typeof x === "string"),
      digest: r.decision_id ? digestById.get(r.decision_id) ?? null : null,
      materialBefore, firstBrought,
      companyFactHit: custText.trim() ? matchCompanyFacts(custText, { account: conv?.account ?? null }).length > 0 : false,
      axis: axis.length ? axis : null,
      situation: latest && conv?.tc && typeof (conv.tc as { situation?: unknown }).situation === "string" ? (conv.tc as { situation: string }).situation : null,
      demotedOverrides: latest && Array.isArray(conv?.demoted) ? conv!.demoted!.length : 0,
      exitEdits: latest && Array.isArray(conv?.exit_edits) ? conv!.exit_edits!.length : 0,
    };
    const mask = maskOf(r.conversation_id, conv?.customer_name);
    if (firstBrought) {
      brought.turns++;
      if (r.draft_last) { brought.withDraft++; if (!/最大限[^\n。]{0,24}割引[^\n。]{0,40}見積|見積[^\n。]{0,16}最大限/.test(r.draft_last)) { brought.missing++; if (/最大限[^\n。]{0,24}割引/.test(staffTexts.join("\n"))) brought.staffHad++; } }
    }
    findings.push(...findingsOfTurn(t, mask));
  }

  // 確認事項（request ledger）: 期間内に言われた物
  const ledger = { open: 0, reopened: 0, topics: {} as Record<string, number> };
  const topicOf = (text: string) => splitRequests([text], new Date(0).toISOString()).map((x) => x.topic);
  for (const [cid, list] of msgs) {
    const conv = convs.get(cid);
    const mask = maskOf(cid, conv?.customer_name);
    const lm: LedgerMsg[] = list.map((m) => ({ sender: m.sender, text: m.text, createdAt: m.created_at, isAix: m.is_aix_generated }));
    const items = buildRequestLedger(lm, untilMs, { windowDays: 14 }).filter((x) => Date.parse(x.saidAt) >= sinceMs && Date.parse(x.saidAt) < untilMs);
    const staffAfter = (at: string) => list.some((m) => m.sender !== "customer" && Date.parse(m.created_at) > Date.parse(at));
    for (const it of longOpenItems(items, untilMs).filter((x) => x.topic !== "other" && staffAfter(x.saidAt))) {
      ledger.open++; ledger.topics[TOPIC_JA[it.topic as keyof typeof TOPIC_JA] ?? it.topic] = (ledger.topics[TOPIC_JA[it.topic as keyof typeof TOPIC_JA] ?? it.topic] ?? 0) + 1;
      const after = list.find((m) => m.sender !== "customer" && Date.parse(m.created_at) > Date.parse(it.saidAt));
      findings.push({ kind: "ledger_open", cause: "unknown", sub: `種類:${TOPIC_JA[it.topic as keyof typeof TOPIC_JA] ?? it.topic}（返した後も未対応）`, tags: [], conversationId: cid, turnId: `L:${cid.slice(0, 8)}:${it.saidAt}`, at: it.saidAt, customer: brief(it.quote, mask), staff: brief(after?.text, mask) });
    }
    // 持ち込みの束の項目（「お送り頂いた物件（N件）」）は新しい URL の持ち込みを問い直しと取り違えるので外す
    const own = list.map((m) => ({ sender: m.sender, text: m.sender === "customer" ? customerOwnWords(m.text) : m.text, createdAt: m.created_at }));
    for (const x of reopenedItems(items.filter((i) => i.topic !== "other" && !/^お送り頂いた物件/.test(i.quote)), own, topicOf)) {
      ledger.reopened++;
      findings.push({ kind: "ledger_reopen", cause: "situation", sub: `完了の判定（${TOPIC_JA[x.item.topic as keyof typeof TOPIC_JA] ?? x.item.topic}）が早い`, tags: ["confirmed_judgement"], conversationId: cid, turnId: `R:${cid.slice(0, 8)}:${x.at}`, at: x.at, customer: brief(x.again, mask), staff: `前の問い「${brief(x.item.quote, mask, 20)}」` });
    }
  }
  const outAt = turns.filter((r) => outage.has(String(r.id))).map((r) => r.customer_turn_at).sort();
  const outageRange = outAt.length ? { from: outAt[0], to: outAt[outAt.length - 1] } : null;
  return { findings, turns: turns.length - skippedPostApply - skippedOutage, ledger, brought, axisTurns, skippedPostApply, skippedOutage, outageRange };
}

export async function runBrainGapFinder(sb: SupabaseClient, opts: { days?: number; nowMs?: number; examples?: number } = {}): Promise<BrainGapReport & { findings: GapFinding[] }> {
  const days = opts.days ?? 7, now = opts.nowMs ?? Date.now();
  const sinceMs = now - days * DAY;
  const errors: string[] = [];
  const r: BrainGapReport & { findings: GapFinding[] } = { ok: true, days, since: new Date(sinceMs).toISOString(), until: new Date(now).toISOString(), summary: null, ledger: { open: 0, reopened: 0, topics: {} }, brought: { turns: 0, withDraft: 0, missing: 0, staffHad: 0 }, axisTurns: 0, skippedPostApply: 0, skippedOutage: 0, outageRange: null, errors, findings: [] };
  try {
    const cur = await collect(sb, sinceMs, now, errors);
    let prevFindings: GapFinding[] = [];
    try { prevFindings = (await collect(sb, sinceMs - days * DAY, sinceMs, errors)).findings; } catch (e) { errors.push(`prev: ${e instanceof Error ? e.message : String(e)}`); }
    r.summary = summarizeGaps(cur.findings, prevFindings, cur.turns, { examples: opts.examples ?? 3 });
    r.ledger = cur.ledger; r.brought = cur.brought; r.axisTurns = cur.axisTurns; r.skippedPostApply = cur.skippedPostApply; r.skippedOutage = cur.skippedOutage; r.outageRange = cur.outageRange; r.findings = cur.findings;
  } catch (e) {
    r.ok = false; errors.push(e instanceof Error ? e.message : String(e));
  }
  return r;
}

/** cron_run_logs に残す形（本文は要旨30字・会話は id の先頭8字だけ・全件の一覧は持たない） */
export function compactGapReport(r: BrainGapReport): Record<string, unknown> {
  const s = r.summary;
  const ex = (e: GapFinding) => ({ c: e.conversationId.slice(0, 8), at: e.at.slice(0, 16), k: e.kind, sub: e.sub.slice(0, 60), cust: e.customer, staff: e.staff });
  return {
    ok: r.ok, days: r.days, since: r.since, until: r.until, axisTurns: r.axisTurns, skippedPostApply: r.skippedPostApply, skippedOutage: r.skippedOutage, outageRange: r.outageRange, ledger: r.ledger, brought: r.brought, errors: r.errors.slice(0, 5),
    turns: s?.turns ?? 0, findings: s?.findings ?? 0, byKind: s?.byKind ?? null, byKindPrev: s?.byKindPrev ?? null,
    byCause: (s?.byCause ?? []).map((c) => ({ cause: c.cause, n: c.n, prev: c.prev, diff: c.diff, fix: c.fix, subs: c.subs, examples: c.examples.map(ex) })),
    byTag: (s?.byTag ?? []).map((t) => ({ tag: t.tag, n: t.n, causes: t.causes, examples: t.examples.map(ex) })),
  };
}
