// app/lib/apply-period-summary-server.ts
// 「申込期間のまとめ（個人情報なし）」を Claude で作って保存し、DeepSeek に渡す時に読む（サーバー専用）。
//
// 2026-09-27 竹内「申込中の部分はクロードに切り替えて要約して（審査否決等になって申込から物件提案中にステータスを切り替えた時に
//   連動してクロードが申込期間の部分を要約して DeepSeek に渡す仕組み）」
//
// 【いつ作るか】線（conversations.deepseek_cutoff_at）は DB のトリガー（stamp_deepseek_cutoff）が書く＝トリガーから LLM は呼べない。
//   ① brain-sweep（5分毎）が「線があるのに、その線のまとめが無い会話」を拾って作る（新しい cron は増やさない・夜も動く）
//   ② 返信生成が DeepSeek に回る時にまとめが無ければ、返した後（after）に作る（次の生成から効く）
//   1会話1行（apply_period_summaries・conversation_id が主キー）。戻すたびに線が新しくなる → 作り直す（cutoff_at で見分ける）。
//
// 【期間】申込が始まった時（AIX【申込へ】押下・本人確認書類/収入証明書の受信・status が申込以降になった時のうち一番早い物）〜線。
//   何度も戻した会話は最初の申込から今の線まで（線より前は全部 DeepSeek に渡らないので、まとめも全体を覆う）。
//
// 【渡すのは検査を通った物だけ】status='ok' の block だけ（cutoff_at が今の線以前）。2回目に戻した直後は前の線のまとめを渡しつつ作り直しを頼む。
//   引っかかった時（status='rejected'）は理由（語の種類だけ・本文なし）を残して渡さない＝要約なしで線より後だけ（竹内さんの決まり）。
//
// 【Claude で作る】ヘッダ x-sumora-llm-post-apply=1 ＋ 線の印 blocked を付ける＝出口（llm-alt-provider）はテスト用の切り替え
//   （LLM_TEST_MODE=deepseek-all）の時も必ず Claude のまま（申込中の中身を読む呼び出しなので）。
import Anthropic from "@anthropic-ai/sdk";
import { supabase } from "./supabase";
import { DRAFT_SKIP_STATUSES } from "./conversation-status";
import { LLM_ACTION_HEADER, LLM_CONVERSATION_HEADER, LLM_POST_APPLY_HEADER, LLM_CUTOFF_HEADER } from "./llm-usage-recorder";
import { logLlmUsage } from "./llm-usage-log";
import { loadPreCutoffCustomerChunks, cutoffMs, NO_CUTOFF, type DeepseekCutoff } from "./post-apply";
import { loadPartyAliases, loadKnownCustomerNames } from "./pii-known-names";
import {
  APPLY_SUMMARY_SYSTEM, prepareApplyPeriodInput, buildApplySummaryUserText, parseApplySummary, renderApplySummaryBlock, checkApplySummary, tidyApplySummary,
  type ApplyPeriodMessage,
} from "./apply-period-summary";

/**
 * まとめのモデル＝Sonnet 5。2026-09-27 実物（戻した会話 7件・保存せず）で Haiku 4.5 と比べて決めた:
 *   Haiku は申込フォームの続きの通にあったお客様の**現住所（建物名＋号室）を「申込した物件」に書いた**・見学しただけの物件を申込物件にした・
 *   内覧のキャンセルを申込のキャンセルと取り違えた・否決した保証会社の名前を書いた。Sonnet は同じ入力で分からない欄を空にした（推測しない）。
 *   費用は1件 入力 平均約3,900・最大約1万トークン／出力 約100〜180 → Sonnet でも1件 約$0.01（最大 約$0.02）、戻す会話は月に6〜9件 → 月 $0.2 未満。
 *   （入力の伏せ・スタッフの発言に無い物件名を落とす後処理は、Haiku の取り違えを受けて足した。モデルに関係なく効く）
 * APPLY_SUMMARY_MODEL で差し替えられる
 */
export const APPLY_SUMMARY_MODEL = process.env.APPLY_SUMMARY_MODEL || "claude-sonnet-5";
export const APPLY_SUMMARY_ACTION = "apply_period_summary";
/** 失敗・作りかけ（pending）の行を作り直すまでの間 */
const RETRY_AFTER_MS = 30 * 60_000;
const PENDING_STALE_MS = 3 * 60_000;

// fetch は呼ぶたびに今の globalThis.fetch を使う（使用量の記録 llm-usage-recorder と出口 llm-alt-provider の包みを必ず通す）。
//   2026-09-27 YUMA の確かめ（開発サーバ）: 既定のまま（SDK が作った時の fetch を持つ）だと、この呼び出しは出口（llm-alt-provider）を
//   通っていなかった（歯止めのログが出ない）。渡すようにした後は出口を通り「申込以降は Claude のまま」で Anthropic に行った。
//   ⚠ 開発サーバは HMR で使用量の記録の包みが外れる（llm-alt-provider は包み直すが記録は包み直さない）ので、記録の確認は本番の llm_usage_logs で
//   （action='apply_period_summary'）。出口を通っても x-sumora-llm-post-apply=1 があるので DeepSeek には回らない
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 60_000, maxRetries: 1, fetch: (input, init) => globalThis.fetch(input, init) });

export type ApplySummaryRow = {
  conversation_id: string;
  cutoff_at: string;
  period_start: string | null;
  status: "pending" | "ok" | "rejected" | "empty" | "error";
  block: string | null;
  summary_json: unknown;
  reject_reasons: string[] | null;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  message_count: number | null;
  created_at: string;
};

const T = (s: string | null | undefined) => (s ? Date.parse(s) : NaN);
const sameInstant = (a: string | null | undefined, b: string | null | undefined) => { const x = T(a), y = T(b); return Number.isFinite(x) && x === y; };

/** 申込が始まった時（線以前の申込の記録のうち一番早い物）。無ければ null＝まとめる期間なし */
export async function loadApplyPeriodStart(conversationId: string, cutoffIso: string): Promise<string | null> {
  const [push, docs, hist] = await Promise.all([
    supabase.from("aix_usage_logs").select("created_at").eq("conversation_id", conversationId).eq("aix_type", "application_push").lte("created_at", cutoffIso).order("created_at").limit(1),
    supabase.from("messages").select("created_at").eq("conversation_id", conversationId).eq("sender", "customer").in("image_type", ["id_document", "income_document"]).lte("created_at", cutoffIso).order("created_at").limit(1),
    supabase.from("conversation_stage_history").select("to_status, changed_at").eq("conversation_id", conversationId).lte("changed_at", cutoffIso).order("changed_at").limit(200),
  ]);
  if (push.error || docs.error || hist.error) throw new Error(`apply-summary: start: ${(push.error ?? docs.error ?? hist.error)?.message}`);
  const cands: number[] = [];
  const p = (push.data ?? [])[0] as { created_at?: string } | undefined; if (p?.created_at) cands.push(T(p.created_at));
  const d = (docs.data ?? [])[0] as { created_at?: string } | undefined; if (d?.created_at) cands.push(T(d.created_at));
  const h = ((hist.data ?? []) as Array<{ to_status: string | null; changed_at: string }>).find((x) => DRAFT_SKIP_STATUSES.has(x.to_status ?? ""));
  if (h) cands.push(T(h.changed_at));
  const ok = cands.filter(Number.isFinite);
  return ok.length ? new Date(Math.min(...ok)).toISOString() : null;
}

async function upsertRow(row: Partial<ApplySummaryRow> & { conversation_id: string; cutoff_at: string; status: ApplySummaryRow["status"] }): Promise<void> {
  const { error } = await supabase.from("apply_period_summaries").upsert({ ...row, created_at: new Date().toISOString() }, { onConflict: "conversation_id" });
  if (error) throw new Error(`apply-summary: upsert: ${error.message}`);
}

export type EnsureResult = { conversationId: string; status: ApplySummaryRow["status"] | "skip" | "no_cutoff"; reasons?: string[]; tidied?: string[]; inputTokens?: number; outputTokens?: number; messages?: number };

/**
 * この会話の今の線のまとめが無ければ作る（あれば何もしない）。失敗しても例外は外に出さない（status で返す）。
 * opts.dryRun … 保存しない（モデル比較・確かめ用）。opts.model … モデルを差し替える（比較用）
 */
export async function ensureApplyPeriodSummary(conversationId: string, opts: { force?: boolean; dryRun?: boolean; model?: string } = {}): Promise<EnsureResult & { block?: string }> {
  try {
    const { data: conv, error } = await supabase.from("conversations").select("id, customer_name, deepseek_cutoff_at").eq("id", conversationId).maybeSingle();
    if (error) throw new Error(error.message);
    const cutoff = (conv as { deepseek_cutoff_at?: string | null } | null)?.deepseek_cutoff_at ?? null;
    if (!cutoff) return { conversationId, status: "no_cutoff" };
    const cutoffIso = new Date(cutoff).toISOString();
    if (!opts.force && !opts.dryRun) {
      const { data: ex } = await supabase.from("apply_period_summaries").select("cutoff_at, status, created_at").eq("conversation_id", conversationId).maybeSingle();
      const r = ex as Pick<ApplySummaryRow, "cutoff_at" | "status" | "created_at"> | null;
      if (r && sameInstant(r.cutoff_at, cutoffIso)) {
        const age = Date.now() - T(r.created_at);
        if (r.status === "ok" || r.status === "rejected" || r.status === "empty") return { conversationId, status: "skip" };
        if (r.status === "pending" && age < PENDING_STALE_MS) return { conversationId, status: "skip" };
        if (r.status === "error" && age < RETRY_AFTER_MS) return { conversationId, status: "skip" };
      }
    }
    const start = await loadApplyPeriodStart(conversationId, cutoffIso);
    if (!start) {
      if (!opts.dryRun) await upsertRow({ conversation_id: conversationId, cutoff_at: cutoffIso, period_start: null, status: "empty", block: null, summary_json: null, reject_reasons: null, model: null, message_count: 0 });
      return { conversationId, status: "empty", messages: 0 };
    }
    const { data: msgs, error: mErr } = await supabase.from("messages").select("created_at, sender, text, image_type")
      .eq("conversation_id", conversationId).gte("created_at", start).lte("created_at", cutoffIso)
      .order("created_at", { ascending: false }).limit(300);
    if (mErr) throw new Error(mErr.message);
    const rows = ((msgs ?? []) as ApplyPeriodMessage[]).reverse();
    const customerName = String((conv as { customer_name?: string | null } | null)?.customer_name ?? "").trim();
    const [aliases, known, netChunks] = await Promise.all([
      loadPartyAliases(conversationId),
      loadKnownCustomerNames(),
      loadPreCutoffCustomerChunks(supabase, conversationId, cutoffIso),
    ]);
    const prepared = prepareApplyPeriodInput(rows, { names: [customerName, ...aliases] });
    if (!prepared.text.trim()) {
      if (!opts.dryRun) await upsertRow({ conversation_id: conversationId, cutoff_at: cutoffIso, period_start: start, status: "empty", block: null, summary_json: null, reject_reasons: null, model: null, message_count: 0 });
      return { conversationId, status: "empty", messages: 0 };
    }
    if (!opts.dryRun) await upsertRow({ conversation_id: conversationId, cutoff_at: cutoffIso, period_start: start, status: "pending", block: null, summary_json: null, reject_reasons: null, model: null, message_count: prepared.used });

    const model = opts.model ?? APPLY_SUMMARY_MODEL;
    const res = await client.messages.create({
      model,
      max_tokens: 1200,
      // Haiku 4.5 は温度0で揺れを抑える。Sonnet 5 は温度を受け付けない（400）ので思考を切るだけ（要約に思考は要らない・出力の費用）
      ...(/haiku/.test(model) ? { temperature: 0 } : { thinking: { type: "disabled" as const } }),
      system: APPLY_SUMMARY_SYSTEM,
      messages: [{ role: "user", content: buildApplySummaryUserText(prepared.text) }],
    }, {
      headers: {
        [LLM_ACTION_HEADER]: APPLY_SUMMARY_ACTION,
        [LLM_CONVERSATION_HEADER]: conversationId,
        // 申込中の中身を読む呼び出し＝必ず Claude（出口の最優先の歯止め・テスト用の切り替えでも回らない）
        [LLM_POST_APPLY_HEADER]: "1",
        [LLM_CUTOFF_HEADER]: "blocked",
      },
    });
    logLlmUsage(APPLY_SUMMARY_ACTION, res.usage, { conversationId, model });
    const text = res.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    const parsedRaw = parseApplySummary(text);
    // 手続きの項目・スタッフの発言に無い物件名（お客様の現住所だった実物あり）を落とす（個人情報の検査の前の後処理）
    const tidy = parsedRaw ? tidyApplySummary(parsedRaw, prepared.staffText) : null;
    const parsed = tidy?.summary ?? null;
    const usage = { inputTokens: res.usage?.input_tokens ?? 0, outputTokens: res.usage?.output_tokens ?? 0 };
    if (!parsed) {
      if (!opts.dryRun) await upsertRow({ conversation_id: conversationId, cutoff_at: cutoffIso, period_start: start, status: "error", reject_reasons: ["parse"], model, input_tokens: usage.inputTokens, output_tokens: usage.outputTokens, message_count: prepared.used });
      return { conversationId, status: "error", reasons: ["parse"], ...usage, messages: prepared.used };
    }
    const reasons = checkApplySummary(parsed, { conversationId, customerName, partyAliases: aliases, knownNames: known, netChunks });
    const block = reasons.length ? "" : renderApplySummaryBlock(parsed, { from: start, to: cutoffIso });
    const status: ApplySummaryRow["status"] = reasons.length ? "rejected" : block ? "ok" : "empty";
    if (!opts.dryRun) {
      await upsertRow({
        conversation_id: conversationId, cutoff_at: cutoffIso, period_start: start, status,
        // 引っかかった要約は本文を残さない（個人情報が入っているかもしれない物を DB に置かない）。理由の種類だけ
        block: status === "ok" ? block : null, summary_json: status === "ok" ? parsed : null,
        reject_reasons: reasons.length ? reasons : null, model, input_tokens: usage.inputTokens, output_tokens: usage.outputTokens, message_count: prepared.used,
      });
    }
    console.log(JSON.stringify({ tag: "apply-summary:made", conversationId, status, reasons, tidied: tidy?.dropped ?? [], model, messages: prepared.used, ...usage }));
    return { conversationId, status, reasons, tidied: tidy?.dropped ?? [], ...usage, messages: prepared.used, ...(opts.dryRun ? { block: status === "ok" ? block : "" } : {}) };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn("[apply-summary] 作れなかった:", conversationId, msg.slice(0, 200));
    if (!opts.dryRun) {
      try {
        const { data: conv } = await supabase.from("conversations").select("deepseek_cutoff_at").eq("id", conversationId).maybeSingle();
        const c = (conv as { deepseek_cutoff_at?: string | null } | null)?.deepseek_cutoff_at;
        if (c) await upsertRow({ conversation_id: conversationId, cutoff_at: new Date(c).toISOString(), status: "error", reject_reasons: ["error"], block: null, summary_json: null });
      } catch { /* 記録できなくても次の sweep がもう一度試す */ }
    }
    return { conversationId, status: "error", reasons: ["error"] };
  }
}

/** まとめを作る必要がある会話（線があって、その線の行が無い・古い・作り直し待ち）。brain-sweep から */
export async function pendingApplySummaryConversations(limit = 2): Promise<string[]> {
  const [{ data: convs, error: e1 }, { data: sums, error: e2 }] = await Promise.all([
    supabase.from("conversations").select("id, deepseek_cutoff_at").not("deepseek_cutoff_at", "is", null).order("deepseek_cutoff_at", { ascending: false }).limit(500),
    supabase.from("apply_period_summaries").select("conversation_id, cutoff_at, status, created_at").limit(2000),
  ]);
  if (e1 || e2) throw new Error(`apply-summary: pending: ${(e1 ?? e2)?.message}`);
  const byId = new Map(((sums ?? []) as Array<Pick<ApplySummaryRow, "conversation_id" | "cutoff_at" | "status" | "created_at">>).map((s) => [s.conversation_id, s]));
  const out: string[] = [];
  for (const c of (convs ?? []) as Array<{ id: string; deepseek_cutoff_at: string }>) {
    const s = byId.get(c.id);
    const age = s ? Date.now() - T(s.created_at) : Infinity;
    const need = !s || !sameInstant(s.cutoff_at, c.deepseek_cutoff_at)
      || (s.status === "error" && age >= RETRY_AFTER_MS)
      || (s.status === "pending" && age >= PENDING_STALE_MS);
    if (need) out.push(c.id);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * DeepSeek に渡すまとめのブロック。今の線（cutoff が ISO）と同じ線で作られ、検査を通った物（status=ok）だけ。無ければ ""。
 * missing … 作り直しを頼むべきか（行が無い・線が古い）。読めない時は ""（渡さない側）
 */
export async function loadApplyPeriodNote(conversationId: string | null | undefined, cutoff: DeepseekCutoff | undefined): Promise<{ note: string; missing: boolean }> {
  if (!conversationId || typeof cutoff !== "string") return { note: "", missing: false };
  const line = cutoffMs(cutoff);
  if (line === null || line === NO_CUTOFF) return { note: "", missing: false };
  try {
    const { data, error } = await supabase.from("apply_period_summaries").select("cutoff_at, status, block").eq("conversation_id", conversationId).maybeSingle();
    if (error) return { note: "", missing: false };
    const r = data as Pick<ApplySummaryRow, "cutoff_at" | "status" | "block"> | null;
    if (!r) return { note: "", missing: true };
    // まとめの線は今の線以前であること（同じ時刻が普通。2回目に戻した直後は前の線のまとめを渡し、新しい線の分は sweep が作り直す）。
    //   前の線のまとめも検査を通った物なので渡してよい。今の線より後の線で作った物は（時計のずれ等）渡さない
    const at = T(r.cutoff_at);
    if (!Number.isFinite(at) || at > line) return { note: "", missing: false };
    // 前の線のまとめ（2回目以降に戻した直後）は渡しつつ、作り直しを頼む（YUMA の確かめで、前の線のまとめが残っていて新しい線の分が作られなかった）
    return { note: r.status === "ok" && r.block ? r.block : "", missing: at < line };
  } catch {
    return { note: "", missing: false };
  }
}
