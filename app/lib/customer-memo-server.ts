// app/lib/customer-memo-server.ts（サーバー専用・DB・DeepSeek。画面側から import しない）
// お客様ごとのメモ（customer-memo.ts）の読み書き・ブレインへの注記・DeepSeek の差分の読み取り・スタッフの手の直し。
//
// 作り方（2026-10-08 竹内さん「人間でいうメモ」）:
//   - 決まった計算で取れる物（もう伝えた事の種類・気持ちの流れの数字）は保存せず毎回組み立てる（鮮度は常に今）
//   - 文から読む必要がある物（芯・妥協・事情・決める人・気にしている事・好き嫌い・NG・具体的に伝えた事・聞かれた事）だけ、
//     ブレインの後（after）に「前回読んだ所より後の通」だけを DeepSeek（推論なし・温度0・固定の前置き＝キャッシュ）で読み、差分の ops を当てて保存する。
//     全文を毎回作り直さない。古い行は retire の印（消さない）。スタッフが付けた・直した行（locked）は DeepSeek が書き換えない。
//   - DeepSeek に渡す前に: 申込の書類・本人確認書類・個人の値の通は落とす（test-pii-guard.applicationMaterialReason）・名前と番号は maskPII・
//     DeepSeek に渡してよい線（post-apply.loadDeepseekCutoff＝申込の記録の後に戻した時刻）より後の通・メモの行だけ渡す・申込中は読まない（申込以降は対象外）。
// 戻す: CUSTOMER_MEMO=off（注記）／CUSTOMER_MEMO_LLM=off（読み取り）／CUSTOMER_MOOD_FLOW=off（気持ちの流れ）
import { supabase } from "@/app/lib/supabase";
import { isPostApplyStatus } from "@/app/lib/llm-alt-provider";
import { loadDeepseekCutoff, filterAfterCutoff } from "@/app/lib/post-apply";
import { applicationMaterialReason } from "@/app/lib/test-pii-guard";
import {
  EMPTY_MEMO, CUSTOMER_MEMO_VERSION, MEMO_LLM_SYSTEM, applyMemoOps, buildCustomerMemoNote, buildMemoLlmUser, customerMemoEnabled, memoViewRows,
  memoLlmMessages, mdOf, parseMemoLlmOutput, resolveOpSources, summarizeTold, toldRuleId, type MemoKind, type MemoMsg, type MemoOp, type MemoViewRow, type StoredMemo,
} from "@/app/lib/customer-memo";
import { buildMoodFlowNote, moodFlowEnabled, resolveMoodFlow, type MoodFlow } from "@/app/lib/customer-mood-flow";
import { buildPaymentTimingNote, extractMoneyReady, paymentTimingEnabled, planApplyTiming, paymentTimingCoreText, type MoneyReady, type ApplyPlan } from "@/app/lib/payment-timing";
// 2026-10-09 竹内さん「決め手の残りはメモとブレインの両方に同じ値で置く」: 決まった計算（customer-mindset.readDecideGaps）を保存せず毎回組み立てる（鮮度は常に今）
import { readDecideGaps, buildDecideGapNote, buildMindsetReplyLinesNote, decideGapEnabled, decideGapLine, hesitationKindOf, type DecideGap, type BrainGap } from "@/app/lib/customer-mindset";
import { readClosingGaps } from "@/app/lib/closing-target";
import { buildMoveTableNote, moveTableMode } from "@/app/lib/mindset-move-table";

/**
 * 2026-10-08 竹内さん「メモの読み取りは影で1週間」: DeepSeek が読んだ行（origin=llm）は保存と画面だけ・ブレインと返信には渡さない。
 * 10/08 夕に既定を on（渡す）にした。CUSTOMER_MEMO_LLM_NOTE=off で影（保存と画面だけ）に戻す。見張りは scripts/audit-customer-memo-shadow.ts
 */
export function memoLlmNoteEnabled(env: Record<string, string | undefined> = process.env): boolean {
  // 2026-10-08 竹内さん「1週間ではなくテストで試したら」: 過去の実会話 40（dry-run 8巡・scripts/yuma-memo-dryrun.ts）で ⚠0・誤りの型を線で落とし、YUMA の前後を見て既定を on に（off で影に戻す）
  return (env.CUSTOMER_MEMO_LLM_NOTE ?? "").trim().toLowerCase() !== "off";
}
function forNote(memo: StoredMemo): StoredMemo {
  return memoLlmNoteEnabled() ? memo : { ...memo, items: memo.items.filter((x) => x.origin === "staff") };
}

/** 申込の書類・個人の値の通（決め手の残りを読まない） */
function applicationMaterialReasonSafe(t: string | null | undefined): boolean {
  try { return !!applicationMaterialReason(t); } catch { return false; }
}

const TABLE = "customer_memos";
const DAY = 86_400_000;
/** もう伝えた事・気持ちの流れを数える窓 */
export const MEMO_WINDOW_DAYS = 60;
/** 1回の DeepSeek に渡す通の上限（多い時は新しい方から） */
export const MEMO_LLM_MAX_MSGS = 30;

type Row = { conversation_id: string; items: StoredMemo["items"] | null; hidden_rule_ids: string[] | null; llm_watermark: string | null; llm_at: string | null; version: string | null };

/** テストだけ: 表に書かずに手元の箱で読み書きする（本番＝VERCEL_ENV がある時は使わない）。scripts/yuma-customer-memo-test.ts が置く */
function memoOverride(): Map<string, StoredMemo> | null {
  if (process.env.VERCEL_ENV) return null;
  return (globalThis as { __customerMemoOverride?: Map<string, StoredMemo> }).__customerMemoOverride ?? null;
}

export async function loadCustomerMemo(conversationId: string): Promise<StoredMemo> {
  const ov = memoOverride();
  if (ov) return ov.get(conversationId) ?? { ...EMPTY_MEMO, items: [], hiddenRuleIds: [] };
  const { data, error } = await supabase.from(TABLE).select("conversation_id, items, hidden_rule_ids, llm_watermark, llm_at, version").eq("conversation_id", conversationId).maybeSingle();
  if (error || !data) return { ...EMPTY_MEMO, items: [], hiddenRuleIds: [] }; // 表が無い（migrate 前）時も空で動く
  const r = data as Row;
  return { items: Array.isArray(r.items) ? r.items : [], hiddenRuleIds: r.hidden_rule_ids ?? [], llmWatermark: r.llm_watermark, llmAt: r.llm_at, version: r.version };
}

async function saveCustomerMemo(conversationId: string, memo: StoredMemo): Promise<boolean> {
  const ov = memoOverride();
  if (ov) { ov.set(conversationId, memo); return true; }
  const { error } = await supabase.from(TABLE).upsert({
    conversation_id: conversationId, items: memo.items, hidden_rule_ids: memo.hiddenRuleIds, llm_watermark: memo.llmWatermark, llm_at: memo.llmAt ?? null,
    version: CUSTOMER_MEMO_VERSION, updated_at: new Date().toISOString(),
  }, { onConflict: "conversation_id" });
  if (error) { console.warn("[customer-memo] 保存できない:", error.message); return false; }
  return true;
}

async function loadMessages(conversationId: string, sinceIso: string, limit = 400): Promise<MemoMsg[]> {
  const { data } = await supabase.from("messages").select("sender, text, created_at, is_aix_generated").eq("conversation_id", conversationId).gte("created_at", sinceIso).order("created_at", { ascending: false }).limit(limit);
  return ((data ?? []) as Array<{ sender: string; text: string | null; created_at: string; is_aix_generated: boolean | null }>).reverse().map((m) => ({ sender: m.sender, text: m.text, createdAt: m.created_at, isAix: m.is_aix_generated }));
}

/** 前回までのブレインの気持ちの判断（古い→新しい・最大4）。今回の判断より前の物だけ */
async function loadPrevEmotions(conversationId: string, beforeIso: string): Promise<string[]> {
  return (await loadPrevBrain(conversationId, beforeIso)).emotions;
}
/** 前回のブレインの状態（mindset の state）と決め手の残り（digest.mg）。2026-10-09 */
async function loadPrevBrain(conversationId: string, beforeIso: string): Promise<{ emotions: string[]; state: string | null; hesitation: string | null; gap: BrainGap | null }> {
  const { data } = await supabase.from("brain_decision_logs").select("digest, created_at").eq("conversation_id", conversationId).lt("created_at", beforeIso).not("digest", "is", null).order("created_at", { ascending: false }).limit(8);
  const rows = (data ?? []) as Array<{ digest: { emo?: string | null; ms?: string | null; mg?: { p?: string | null; pt?: string; s?: string; q?: string } | null } | null; created_at: string }>;
  const lastMs = rows.find((r) => r.digest?.ms)?.digest?.ms ?? null;
  const g = rows[0]?.digest?.mg ?? null;
  // 決め手の残りは直前の判断の物だけ（古い判断の残りを今に持ち込まない＝穴:G6）・2日以内
  const fresh = rows[0] && Date.now() - Date.parse(rows[0].created_at) <= 2 * 86_400_000;
  const gap: BrainGap | null = fresh && g && g.pt && (g.s === "a" || g.s === "b" || g.s === "c") ? { point: g.pt, solve: g.s, property: g.p ?? null, quote: g.q ?? "" } : null;
  return { emotions: emotionsOf(rows), state: lastMs ? lastMs.split("|")[0] || null : null, hesitation: lastMs ? lastMs.split("|")[2] || null : null, gap };
}
function emotionsOf(data: ReadonlyArray<{ digest: { emo?: string | null } | null }>): string[] {
  const out: string[] = [];
  for (const r of data as Array<{ digest: { emo?: string | null } | null }>) { const e0 = r.digest?.emo; const e = e0 === "冷めかけ" ? "離れかけ" : e0; if (e && out[out.length - 1] !== e) out.push(e); if (out.length >= 4) break; }
  return out.reverse();
}

export type MemoBundle = {
  memo: StoredMemo; told: ReturnType<typeof summarizeTold>; mood: MoodFlow | null; prevEmotions: string[];
  /** お金を用意できる日（payment-timing・決まった計算） */
  money: MoneyReady | null;
  /** 入居の希望（条件の move_in_time を暦日に・無ければ null） */
  desiredMoveInMs: number | null;
  /** AI の要約（property_customers.ai_summary_json）の言葉づかい・時期感（2026-10-08 竹内「メモの言葉づかいにまとめてよい」） */
  summaryStyle: { style: string | null; urgency: string | null; at: string | null } | null;
  /** 決め手の残り（決まった計算・新しい順）・前回のブレインが読んだ決め手の残りと状態（2026-10-09） */
  gaps: DecideGap[];
  prevBrain: { state: string | null; hesitation: string | null; gap: BrainGap | null };
  /** 今のお客様の連投（最後の束）の文 */
  lastCustomerTurn: string;
};

async function loadCustomerSide(conversationId: string, now: number): Promise<{ desiredMoveInMs: number | null; summaryStyle: MemoBundle["summaryStyle"] }> {
  try {
    const { data: conv } = await supabase.from("conversations").select("property_customer_id").eq("id", conversationId).maybeSingle();
    const pcid = (conv as { property_customer_id?: string | null } | null)?.property_customer_id;
    if (!pcid) return { desiredMoveInMs: null, summaryStyle: null };
    const { data: pc } = await supabase.from("property_customers").select("move_in_time, ai_summary_json, ai_summary_at").eq("id", pcid).maybeSingle();
    const r = pc as { move_in_time?: string | null; ai_summary_json?: { style?: unknown; urgency?: unknown } | null; ai_summary_at?: string | null } | null;
    const { resolveMoveInStart } = await import("@/app/lib/contact-promise");
    const mv = r?.move_in_time ? resolveMoveInStart(r.move_in_time, now) : null;
    const st = typeof r?.ai_summary_json?.style === "string" ? r.ai_summary_json.style : null;
    const ug = typeof r?.ai_summary_json?.urgency === "string" ? r.ai_summary_json.urgency : null;
    const ymdMs = mv ? Date.UTC(mv.ymd.y, mv.ymd.m - 1, mv.ymd.d) - 9 * 3600_000 : null;
    const style = st && st !== "普通" ? st : null, urgency = ug && ug !== "未確認" ? ug : null;
    return { desiredMoveInMs: ymdMs, summaryStyle: style || urgency ? { style, urgency, at: r?.ai_summary_at ?? null } : null };
  } catch { return { desiredMoveInMs: null, summaryStyle: null }; }
}

/** 言葉づかい・時期感（AI の要約）。返信と画面だけ（ブレインは【顧客プロファイル】で同じ値を読んでいる） */
function summaryStyleText(s: MemoBundle["summaryStyle"]): string {
  if (!s) return "";
  return [s.style ? `文体 ${s.style}` : "", s.urgency ? `引越しの時期感 ${s.urgency}` : ""].filter(Boolean).join("・");
}

export async function loadMemoBundle(conversationId: string, o: { nowMs?: number } = {}): Promise<MemoBundle> {
  const now = o.nowMs ?? Date.now();
  const sinceIso = new Date(now - MEMO_WINDOW_DAYS * DAY).toISOString();
  const [memo, msgs, prev, side] = await Promise.all([
    loadCustomerMemo(conversationId),
    loadMessages(conversationId, sinceIso),
    loadPrevBrain(conversationId, new Date(now).toISOString()).catch(() => ({ emotions: [] as string[], state: null, hesitation: null, gap: null })),
    loadCustomerSide(conversationId, now),
  ]);
  const prevEmotions = moodFlowEnabled() ? prev.emotions : [];
  const gaps = decideGapEnabled() ? readDecideGaps(msgs.filter((m) => !applicationMaterialReasonSafe(m.text)), { nowMs: now, closingReads: (t) => readClosingGaps(t) }) : [];
  let k = msgs.length; while (k - 1 >= 0 && msgs[k - 1].sender === "customer") k--;
  const lastCustomerTurn = msgs.slice(k).map((m) => String(m.text ?? "")).join("\n");
  const money = paymentTimingEnabled() ? extractMoneyReady(msgs.filter((m) => m.sender === "customer").map((m) => ({ text: m.text, createdAt: m.createdAt })), now) : null;
  // 今の番（お客様の連投）より前のこちらの送信だけを「もう伝えた」に数える＝今の番の後に作る下書きは含めない
  return { memo, told: summarizeTold(msgs), mood: moodFlowEnabled() ? resolveMoodFlow(msgs) : null, prevEmotions, money, desiredMoveInMs: side.desiredMoveInMs, summaryStyle: side.summaryStyle, gaps, prevBrain: { state: prev.state, hesitation: prev.hesitation, gap: prev.gap }, lastCustomerTurn };
}

/** ブレインの毎回変わる並びに足す注記（メモ＋気持ちの流れ）。何も無ければ空文字 */
export async function customerMemoNoteFor(conversationId: string, o: { scene?: string | null; nowMs?: number; customerName?: string | null } = {}): Promise<{ note: string; memoChars: number; moodChars: number; items: number; pay: (ApplyPlan & { core: string }) | null }> {
  const now = o.nowMs ?? Date.now();
  const b = await loadMemoBundle(conversationId, { nowMs: now });
  const memoNote = customerMemoEnabled() ? buildCustomerMemoNote({ memo: forNote(b.memo), told: b.told, scene: o.scene, nowMs: now }) : "";
  const moodNote = moodFlowEnabled() ? buildMoodFlowNote(b.mood, { prevEmotions: b.prevEmotions }).trim() : "";
  const payNote = buildPaymentTimingNote(b.money, { nowMs: now, desiredMoveInMs: b.desiredMoveInMs, scene: o.scene, customerName: o.customerName });
  // 10/08 A/B の判断（ブレインが B の時に申込へを外す・返信の方向に使う）。条件の場面では出さない（注記と同じ）
  const plan = payNote && b.money ? planApplyTiming({ moneyDayMs: b.money.fromDayMs, nowMs: now, desiredMoveInMs: b.desiredMoveInMs }) : null;
  const pay = plan ? { ...plan, core: paymentTimingCoreText(plan, o.customerName) } : null;
  const gapNote = buildDecideGapNote({ gaps: b.gaps, brainGap: b.prevBrain.gap, hesitation: hesitationKindOf(b.lastCustomerTurn) });
  // 状態×一手→反応の表（2026-10-09 竹内さん「テストで動かす」）: 既定は影（ログだけ）・MINDSET_MOVE_TABLE=on で渡す。状態は前回のブレインの状態（今回の状態はこの判断で決まる）
  const mode = moveTableMode();
  const moveNote = mode !== "off" ? buildMoveTableNote(b.prevBrain.state) : "";
  if (moveNote) console.log(JSON.stringify({ tag: "brain:mindset-move-table", conversationId, mode, state: b.prevBrain.state, chars: moveNote.length }));
  if (gapNote) console.log(JSON.stringify({ tag: "brain:decide-gap", conversationId, gaps: b.gaps.slice(0, 3).map((g) => `${g.point}:${g.solve}${g.conditional ? ":cond" : ""}`), brainGap: b.prevBrain.gap ? `${b.prevBrain.gap.point}:${b.prevBrain.gap.solve}` : null }));
  return { note: [memoNote, moodNote, payNote, gapNote, mode === "on" ? moveNote : ""].filter(Boolean).join("\n\n"), memoChars: memoNote.length, moodChars: moodNote.length + payNote.length, items: b.memo.items.filter((x) => !x.retiredAt).length, pay };
}

/** 画面用（行・気持ちの見立て） */
export async function customerMemoView(conversationId: string): Promise<{ rows: MemoViewRow[]; mood: { hint: string; changes: string[]; prevEmotions: string[] } | null; llmAt: string | null }> {
  const now = Date.now();
  const b = await loadMemoBundle(conversationId, { nowMs: now });
  return {
    rows: [
      ...memoViewRows({ memo: b.memo, told: b.told, nowMs: now }),
      ...(summaryStyleText(b.summaryStyle) ? [{ id: "summary:style", kind: "style" as const, label: "言葉づかい", text: summaryStyleText(b.summaryStyle), source: `AI の要約${b.summaryStyle?.at ? ` ${mdOf(b.summaryStyle.at)}` : ""}`, origin: "rule" as const, locked: false }] : []),
      ...b.gaps.slice(0, 3).map((g, i) => ({ id: `rule:gap:${i}`, kind: "decide_gap" as const, label: "決め手の残り", text: decideGapLine(g), source: `${g.at ? mdOf(g.at) : ""} お客様「${g.quote}」`, origin: "rule" as const, locked: false })),
      ...(b.money ? [{ id: "rule:money", kind: "circumstance" as const, label: "お金の時期", text: `${mdOf(new Date(b.money.fromDayMs).toISOString())} 以降に用意`, source: `${mdOf(b.money.saidAt)} お客様「${b.money.quote.slice(0, 30)}」`, origin: "rule" as const, locked: false }] : []),
    ],
    mood: b.mood ? { hint: b.mood.hint, changes: b.mood.changes, prevEmotions: b.prevEmotions } : null,
    llmAt: b.memo.llmAt ?? null,
  };
}

const newId = (p: string) => `${p}-${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-3)}`;

/** スタッフの手の直し（追加・直す・外す・決まった計算の行を外す／戻す）。手で付けた・直した行は locked */
export async function applyStaffMemoEdit(conversationId: string, edit: { op: "add"; kind: MemoKind; text: string } | { op: "update"; id: string; text: string } | { op: "retire"; id: string; reason?: string } | { op: "hide_rule"; id: string } | { op: "unhide_rule"; id: string }): Promise<{ ok: boolean; error?: string }> {
  const memo = await loadCustomerMemo(conversationId);
  const nowIso = new Date().toISOString();
  let next: StoredMemo = memo;
  if (edit.op === "hide_rule" || edit.op === "unhide_rule") {
    if (!/^told:/.test(edit.id)) return { ok: false, error: "決まった計算の行ではない" };
    const set = new Set(memo.hiddenRuleIds); if (edit.op === "hide_rule") set.add(edit.id); else set.delete(edit.id);
    next = { ...memo, hiddenRuleIds: [...set] };
  } else {
    const op: MemoOp = edit.op === "add" ? { op: "add", kind: edit.kind, text: edit.text, at: nowIso, by: "staff", certainty: "sure", ttlDays: null }
      : edit.op === "update" ? { op: "update", id: edit.id, text: edit.text } : { op: "retire", id: edit.id, reason: edit.reason ?? "スタッフが外した" };
    const r = applyMemoOps(memo, [op], { origin: "staff", nowIso, newId: () => newId("s") });
    if (!r.applied) return { ok: false, error: "当てられない（同じ中身がある・行が無い）" };
    next = r.memo;
  }
  return { ok: await saveCustomerMemo(conversationId, next) };
}
export { toldRuleId };

export function customerMemoLlmEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return customerMemoEnabled(env) && (env.CUSTOMER_MEMO_LLM ?? "").trim().toLowerCase() !== "off";
}

const inFlight = new Set<string>();

/**
 * 前回読んだ所より後の新しい通だけ DeepSeek で読み、差分を当てて保存する（ブレインの後に after で呼ぶ）。
 * お客様の新しい発言が無い・申込以降・鍵が無い時は何もしない。失敗しても投げない。
 */
export async function refreshCustomerMemoLlm(conversationId: string): Promise<{ called: boolean; applied: number; reason?: string }> {
  if (!customerMemoLlmEnabled()) return { called: false, applied: 0, reason: "off" };
  if (!(process.env.DEEPSEEK_API_KEY ?? "").trim()) return { called: false, applied: 0, reason: "no_key" };
  if (inFlight.has(conversationId)) return { called: false, applied: 0, reason: "in_flight" };
  inFlight.add(conversationId);
  try {
    const { data: conv } = await supabase.from("conversations").select("id, status, customer_name, line_source_type").eq("id", conversationId).maybeSingle();
    const c = conv as { status?: string | null; customer_name?: string | null; line_source_type?: string | null } | null;
    if (!c) return { called: false, applied: 0, reason: "no_conv" };
    if (isPostApplyStatus(c.status) || c.line_source_type === "group") return { called: false, applied: 0, reason: "out_of_scope" };
    const memo = await loadCustomerMemo(conversationId);
    const now = Date.now();
    const sinceIso = memo.llmWatermark && Date.parse(memo.llmWatermark) > now - MEMO_WINDOW_DAYS * DAY ? memo.llmWatermark : new Date(now - MEMO_WINDOW_DAYS * DAY).toISOString();
    let msgs = (await loadMessages(conversationId, sinceIso, 200)).filter((m) => !memo.llmWatermark || Date.parse(m.createdAt) > Date.parse(memo.llmWatermark));
    // 申込の記録の後に戻した会話は、戻した時刻より後の通だけ（申込中＝null は読まない）
    const cutoff = await loadDeepseekCutoff(supabase as never, conversationId);
    if (cutoff === null) return { called: false, applied: 0, reason: "post_apply" };
    msgs = filterAfterCutoff(msgs, (m) => m.createdAt, cutoff);
    if (!msgs.some((m) => m.sender === "customer")) return { called: false, applied: 0, reason: "no_new_customer_msg" };
    msgs = msgs.slice(-MEMO_LLM_MAX_MSGS);
    const lastAt = msgs[msgs.length - 1].createdAt;
    const sendMsgs = memoLlmMessages(msgs, [c.customer_name]);
    if (!sendMsgs.some((m) => m.sender === "customer")) {
      await saveCustomerMemo(conversationId, { ...memo, llmWatermark: lastAt });
      return { called: false, applied: 0, reason: "only_documents" };
    }
    const { callDeepSeekRead } = await import("@/app/lib/vision-alt-provider");
    // 今のメモも線より後に作った行だけ見せる（線より前＝申込中の中身から作った行は渡さない）
    const memoForLlm = { ...memo, items: filterAfterCutoff(memo.items, (x) => x.sourceAt ?? x.updatedAt, cutoff) };
    const user = buildMemoLlmUser({ memo: memoForLlm, nowMs: now, msgs: sendMsgs });
    const read = await callDeepSeekRead(MEMO_LLM_SYSTEM, user, { maxTokens: 900, timeoutMs: 40_000 }, (t) => parseMemoLlmOutput(t));
    for (const a of read.attempts) {
      void import("@/app/lib/llm-usage-recorder").then(({ recordAltUsage }) => recordAltUsage({
        model: a.res?.model ?? "deepseek-flash", action: "customer_memo", conversationId,
        usage: { input_tokens: Math.max(0, (a.res?.usage.input ?? 0) - (a.res?.usage.cacheHit ?? 0)), output_tokens: a.res?.usage.output ?? 0, cache_read_input_tokens: a.res?.usage.cacheHit ?? 0 },
        status: a.res ? 200 : 0, errorType: a.ok ? null : (a.res ? "empty_or_unparsable" : "no_response"),
        durationMs: a.ms, sysHead: `【お客様のメモ${a.retry ? "・読み直し" : ""}】${CUSTOMER_MEMO_VERSION}`, sysKeyFull: null, maxTokens: 900,
      })).catch(() => {});
    }
    if (!read.value) return { called: true, applied: 0, reason: "unparsable" }; // 水位は進めない＝次の回で読み直す
    const resolved = resolveOpSources(read.value, sendMsgs);
    const r = applyMemoOps(memo, resolved.ops, { origin: "llm", nowIso: new Date().toISOString(), newId: () => newId("l") });
    await saveCustomerMemo(conversationId, { ...r.memo, llmWatermark: lastAt, llmAt: new Date().toISOString() });
    console.log(JSON.stringify({ tag: "customer-memo:llm", conversationId, msgs: sendMsgs.length, ops: read.value.length, dropped: resolved.dropped.map((d) => d.why), applied: r.applied, refused: r.refused }));
    return { called: true, applied: r.applied };
  } catch (e) {
    console.warn("[customer-memo] refresh failed:", conversationId, e instanceof Error ? e.message : String(e));
    return { called: false, applied: 0, reason: "error" };
  } finally { inFlight.delete(conversationId); }
}

/**
 * 返信の下書き（DeepSeek）に渡す注記。DeepSeek に渡してよい線より後に作った行だけ（線より前＝申込中の中身から作った行は渡さない）・申込中は空。
 * ブレインと同じ形（場面で要る種類・もう伝えた事は種類の名前だけ・気持ちの流れ）。
 */
export async function customerMemoReplyNoteFor(conversationId: string, o: { scene?: string | null; nowMs?: number } = {}): Promise<string> {
  if (!customerMemoEnabled()) return "";
  const now = o.nowMs ?? Date.now();
  const cutoff = await loadDeepseekCutoff(supabase as never, conversationId);
  if (cutoff === null) return "";
  const b = await loadMemoBundle(conversationId, { nowMs: now });
  const memo = { ...b.memo, items: filterAfterCutoff(b.memo.items, (x) => x.sourceAt ?? x.updatedAt, cutoff) };
  const memoNote = buildCustomerMemoNote({ memo: forNote(memo), told: b.told, scene: o.scene, nowMs: now, maxItems: 6 });
  const moodNote = moodFlowEnabled() ? buildMoodFlowNote(b.mood, { prevEmotions: b.prevEmotions }).trim() : "";
  const payNote = buildPaymentTimingNote(b.money, { nowMs: now, desiredMoveInMs: b.desiredMoveInMs, scene: o.scene });
  const style = summaryStyleText(b.summaryStyle);
  // 決め手の残り（線より後の発言の物だけ）
  const gapsAfter = cutoff ? b.gaps.filter((g) => !g.at || Date.parse(g.at) > Date.parse(String(cutoff))) : b.gaps;
  const gapNote = buildDecideGapNote({ gaps: gapsAfter, brainGap: b.prevBrain.gap, hesitation: null });
  // 今の状態で竹内さんが足している1行の率（返信の番の直前のブレインの状態＝今回の判断）。既定 off・MINDSET_REPLY_LINES=on で入る
  const linesNote = buildMindsetReplyLinesNote(b.prevBrain.state, b.prevBrain.hesitation);
  return [memoNote, style ? `【お客様の言葉づかい（AI の要約）】\n- ${style}` : "", moodNote, payNote, gapNote, linesNote].filter(Boolean).join("\n\n");
}

/** AIX【申込へ】の文に添える一文（A の時だけ・B は null）。お金の用意の時期が分かっている会話だけ */
export async function paymentPlanFor(conversationId: string, customerName?: string | null): Promise<(ApplyPlan & { core: string }) | null> {
  if (!paymentTimingEnabled()) return null;
  const b = await loadMemoBundle(conversationId);
  if (!b.money) return null;
  const plan = planApplyTiming({ moneyDayMs: b.money.fromDayMs, nowMs: Date.now(), desiredMoveInMs: b.desiredMoveInMs });
  return { ...plan, core: paymentTimingCoreText(plan, customerName) };
}
