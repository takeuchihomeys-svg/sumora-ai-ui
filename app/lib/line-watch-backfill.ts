// app/lib/line-watch-backfill.ts
// 見張り（line_watch_turns）の過去の番の埋め戻し（純関数・DB も fetch も LLM も持たない）。
//   2026-10-08 竹内さんの決定 10/08 の1: 見張りの一致の判定（トリガーの控えは 10/01〜）を過去1〜3ヶ月分埋め、場面ごとの一致率を1ヶ月単位で見る。
//
//   番の切り方   … 10巡目の正解の表（scripts/audit-r10-path-truth.ts）と同じ: お客様の連投の最初の発言＝番の鍵（トリガーの customer_turn_at と同じ定義）。
//                  申込以降（申込へ（push 以外）を押した・申込フォームを送った後。否決の後は戻す）は入れない（cron でも「対象外」で数えない番）
//   その時の AI の案 … ai_reply_examples（line_reply）の ai_draft。返事のまとまりの中のスタッフの文と送った時刻が合う物だけ（後の連絡の下書きは使わない）
//   ブレインの判断 … brain_decision_logs（9/05〜）。番の中の判断で、スタッフの最初の行動より前の最後の物（cron の decision の選び方と同じ）
//   判定         … line-watch-turn-eval.evalWatchTurn（毎晩の cron と同じ関数）
//   印           … verdict_detail.backfill（'ai_reply_examples'｜'brain_decision_logs'）。列を足さずに済む形（理由は scripts/line-watch-backfill.ts の頭）
//
//   埋め戻した行は、今の控え（トリガーの行）だけで見る数字（解禁の線 sceneStats・自動返信の関所 auto-reply-readiness）から isBackfillTurn で外す
// テスト: app/lib/__tests__/line-watch-backfill.test.ts
import { staffWindowOf, cleanDraft, type WindowMsg, type WindowPress, type Judgement } from "./line-watch-judge";
import { editCore } from "./edit-diff";
import type { WatchTurnInput, WatchDecision } from "./line-watch-turn-eval";

export const BACKFILL_KEY = "backfill" as const;
export type BackfillSource = "ai_reply_examples" | "brain_decision_logs";

/** 埋め戻した行か（verdict_detail.backfill に印がある） */
export function isBackfillTurn(t: { verdict_detail?: unknown } | null | undefined): boolean {
  const d = t?.verdict_detail;
  return !!d && typeof d === "object" && !Array.isArray(d) && !!(d as Record<string, unknown>)[BACKFILL_KEY];
}

const ms = (s: string) => Date.parse(s);

/** 申込以降の語（scripts/audit-r10-path-truth.ts と同じ: customer-sim-shadow.APPLY_FORM_RE・post-apply-brain-gate.STAFF_FAIL_RE を呼び出し側が渡す） */
export type PostApplyRules = { applyFormRe: RegExp; staffFailRe: RegExp };
export type BfMsg = WindowMsg;
export type BfPress = WindowPress & { app_sub_mode?: string | null };
export type PastTurn = {
  turnAt: string;
  custLastAt: string;
  /** 番の最後のお客様の発言の時点で申込以降か */
  post: boolean;
  /** 番の後にスタッフ（customer 以外）の発言が1つでもあるか（無い番はトリガーが今後この鍵で控える恐れがあるので入れない） */
  laterStaff: boolean;
};

/** 会話のメッセージ（古い順）から番を切る */
export function pastTurnsOf(msgs: ReadonlyArray<BfMsg>, presses: ReadonlyArray<BfPress>, rules: PostApplyRules): PastTurn[] {
  const postStarts = [
    ...presses.filter((p) => p.aix_type === "application_push" && (p.app_sub_mode ?? "") !== "push").map((p) => ms(p.created_at)),
    ...msgs.filter((m) => m.sender !== "customer" && rules.applyFormRe.test(m.text ?? "")).map((m) => ms(m.created_at)),
  ].sort((a, b) => a - b);
  const fails = msgs.filter((m) => rules.staffFailRe.test(m.text ?? "")).map((m) => ms(m.created_at));
  const isPost = (at: number) => {
    const st = postStarts.filter((x) => x <= at);
    if (!st.length) return false;
    const last = st[st.length - 1];
    return !fails.some((f) => f > last && f <= at);
  };
  const out: PastTurn[] = [];
  for (let i = 0; i < msgs.length; i++) {
    if (msgs[i].sender !== "customer" || (i > 0 && msgs[i - 1].sender === "customer")) continue;
    let j = i;
    while (j + 1 < msgs.length && msgs[j + 1].sender === "customer") j++;
    out.push({ turnAt: msgs[i].created_at, custLastAt: msgs[j].created_at, post: isPost(ms(msgs[j].created_at)), laterStaff: j + 1 < msgs.length });
  }
  return out;
}

/** 手本の行（ai_reply_examples の一部の列） */
export type BfExample = {
  id: string; conversation_id: string; sent_at: string | null; created_at: string; ai_draft: string | null;
  entry_source: string | null; pii_redacted_at?: string | null; customer_intent?: string | null; tpo_label?: string | null;
  /** reply_context_snapshot があるか・その draftHead（generate-reply が送信の時点の下書きの頭 200字を残す） */
  has_snapshot?: boolean | null; draft_head?: string | null;
};
/** 送った時刻の合わせ（手本の sent_at は送信の API の後＝messages.created_at の 0〜数秒後。実測 +1.0〜1.4秒） */
export const EXAMPLE_MATCH_BEFORE_MS = 5_000;
export const EXAMPLE_MATCH_AFTER_MS = 20_000;

/**
 * 古い下書き（前の番の下書きが作り直されずに入力欄に残っていた物）か。
 *   手本には下書きを作った時刻が無い → 番の始まりより前に送った手本の下書きと中身が同じなら古い（cron の pickJudgeDraft の stale と同じ考え）。
 *   実物 8/10 583171e6: 「家賃10〜11で2LDKで探せますか？」の番の手本の下書きが、前の番（初期費用の依頼）の御見積書の約束のままだった
 */
export function isStaleExampleDraft(ex: BfExample, turnAt: string, examples: ReadonlyArray<BfExample>): boolean {
  const core = editCore(cleanDraft(ex.ai_draft).text ?? "");
  if (!core) return false;
  return examples.some((e) => e.id !== ex.id && ms(e.sent_at ?? e.created_at) < ms(turnAt) && editCore(cleanDraft(e.ai_draft).text ?? "") === core);
}

/**
 * 返事のまとまりの文に合う手本（最初の文に一番近い物）。line_reply 以外・個人情報で伏せた手本・下書きの文が無い手本は使わない。
 *   まとまりの外（後の連絡）の文に合う手本は使わない（その下書きは後の連絡の案で、番の返事の案ではない）
 */
export function exampleForBurst(burstTexts: ReadonlyArray<{ at: string }>, examples: ReadonlyArray<BfExample>, opt: { requireDraft?: boolean } = {}): BfExample | null {
  const needDraft = opt.requireDraft !== false;
  const usable = examples.filter((e) => e.entry_source === "line_reply" && !e.pii_redacted_at && (!needDraft || !!cleanDraft(e.ai_draft).text) && (e.sent_at || e.created_at));
  for (const t of burstTexts) {
    const at = ms(t.at);
    const hits = usable
      .map((e) => ({ e, d: ms(e.sent_at ?? e.created_at) - at }))
      .filter((x) => x.d >= -EXAMPLE_MATCH_BEFORE_MS && x.d <= EXAMPLE_MATCH_AFTER_MS)
      .sort((a, b) => Math.abs(a.d) - Math.abs(b.d));
    if (hits.length) return hits[0].e;
  }
  return null;
}

export type BfDecision = WatchDecision & { suggested_action: string | null; suggested_reply_mode: string | null; conversation_status: string | null };

/**
 * 番に寄せるブレインの判断（cron の line-watch-turn-eval と同じ選び方: analyzed_msg_ts が番の中・無ければ番の後に作られた・スタッフの最初の行動まで）。
 *   返すのは「スタッフが見た最後の判断」と、その番で控えたはずの回数
 */
export function decisionsForTurn(turnAt: string, custLastAt: string, staffFirstAt: string | null, endAt: string, decisions: ReadonlyArray<BfDecision>): { last: BfDecision | null; n: number } {
  const until = ms(staffFirstAt ?? endAt);
  const seen = decisions.filter((d) => {
    const inTurn = d.analyzed_msg_ts ? ms(d.analyzed_msg_ts) >= ms(turnAt) - 1000 && ms(d.analyzed_msg_ts) <= ms(custLastAt) + 1000 : ms(d.created_at) >= ms(turnAt);
    return inTurn && ms(d.created_at) <= until;
  });
  return { last: seen.length ? seen[seen.length - 1] : null, n: seen.length };
}

export type BackfillPlan = {
  input: WatchTurnInput;
  source: BackfillSource;
  example: BfExample | null;
  decision: BfDecision | null;
  /** 場面の材料（tpo＝手本の reply_context_snapshot.tpo_label／intent＝ブレインの digest か手本の customer_intent） */
  sceneSrc: "tpo" | "brain_intent" | "example_intent" | "none";
  /** 手本はあったが下書きが前の番の物のまま（使わない） */
  staleExample: string | null;
  /**
   * 手本はあるが下書きの欄が空・印だけ（その時 AI の下書きの文は無かった＝cron の「下書きが無い」と同じ）。手本そのものが無い番（LINE の公式アプリから送った・
   *   AIX で送った）は下書きの有無が分からない＝別に扱う（guardBackfillJudgement の hasDraft）
   */
  draftKnownAbsent: boolean;
  intentFallback: string | null;
  customerLastAt: string;
};
export type SkipReason = "post_apply" | "no_later_staff" | "no_draft_no_brain" | "no_staff_action";

/**
 * 埋め戻しの番で、材料が足りずに決まらない判定を na にする（2026-10-08 竹内さん「下書きが無い番は na のまま（数えない）」）。
 *   judgeTurn はそのまま当てた上で、その時の材料が手本・ブレインの記録に残っていない所だけ外す（元の判定は bf_raw に残す）:
 *   ①下書きが分からない（手本が無い・古い下書き）: ブレインの AIX とスタッフの押した AIX で決まる番（aix_same・aix_other）だけ残す。
 *     手本があって下書きの欄が空・印だけの番は「下書きが無かった」と分かる＝cron と同じく判定する（hasDraft=true で渡す）
 *     他（aix_but_text・aix_ack_by_text・text_but_aix 等）は下書きの文が要る（AI は AIX と一緒に返事の下書きも出す・2段の約束は下書きで見る）
 *   ②ブレインの判断が無い（9/05 より前・番に判断が無い）: AI が AIX を出したかが分からない → スタッフが AIX を押した番（text_but_aix・
 *     text_plus_aix・two_stage_fulfilled）は数えない。文の判定（下書き×送った文）は残す
 */
export const BF_KEEP_WITHOUT_DRAFT = new Set(["aix_same", "aix_other"]);
export const BF_NEEDS_BRAIN = new Set(["text_but_aix", "text_plus_aix", "two_stage_fulfilled"]);
export function guardBackfillJudgement(j: Judgement, o: { hasDraft: boolean; hasBrain: boolean }): Judgement & { bfNa: "no_draft" | "no_brain" | null } {
  const reason = j.detail.reason;
  let why: "no_draft" | "no_brain" | null = null;
  if (j.verdict && j.verdict !== "na") {
    if (!o.hasDraft && !BF_KEEP_WITHOUT_DRAFT.has(reason)) why = "no_draft";
    else if (!o.hasBrain && BF_NEEDS_BRAIN.has(reason)) why = "no_brain";
  }
  if (!why) return { ...j, bfNa: null };
  return { verdict: "na", detail: { ...j.detail, bf_raw: { verdict: j.verdict, reason } } as Judgement["detail"], bfNa: why };
}

/**
 * 番1つの埋め戻しの計画。入れない番は理由を返す。
 *   入れるのは「スタッフが何か返した（文か AIX）」かつ「下書きかブレインの判断がある」番だけ（トリガーの行も、下書きかブレインが動いた番にだけできる）
 */
export function planBackfillTurn(o: {
  conversationId: string; turn: PastTurn; msgs: ReadonlyArray<BfMsg>; presses: ReadonlyArray<BfPress>;
  examples: ReadonlyArray<BfExample>; decisions: ReadonlyArray<BfDecision>; nowMs: number;
}): BackfillPlan | { skip: SkipReason } {
  if (o.turn.post) return { skip: "post_apply" };
  if (!o.turn.laterStaff) return { skip: "no_later_staff" };
  const w = staffWindowOf({ customerTurnAt: o.turn.turnAt, msgs: o.msgs, presses: o.presses, nowMs: o.nowMs });
  if (!w.staffFirstAt) return { skip: "no_staff_action" };
  const ex0 = exampleForBurst(w.texts.filter((t) => t.burst), o.examples);
  const stale = !!ex0 && isStaleExampleDraft(ex0, o.turn.turnAt, o.examples);
  const ex = stale ? null : ex0;
  // 下書きの文が無い手本（空・[AIX誘導中] 等の印）＝その時の下書きは無かったと分かる
  const exBare = !ex0 ? exampleForBurst(w.texts.filter((t) => t.burst), o.examples, { requireDraft: false }) : null;
  //   ※ 手本の ai_draft は画面の手元の値。ブレインが AIX の時は画面が下書きを隠す（page.tsx・reply_mode=aix で aiDraft=null）ので、空でも下書きがあった事がある
  //     （9月〜の空の手本 815 のうち 34 は snapshot の draftHead に下書きが残る）→ snapshot があって draftHead も空の時だけ「無かった」と見る
  const draftKnownAbsent = !!exBare && !cleanDraft(exBare.ai_draft).text && exBare.has_snapshot === true && !String(exBare.draft_head ?? "").trim();
  const dec = decisionsForTurn(o.turn.turnAt, w.customerLastAt, w.staffFirstAt, w.endAt, o.decisions);
  if (!ex && !dec.last) return { skip: "no_draft_no_brain" };
  const cd = ex ? cleanDraft(ex.ai_draft) : exBare ? cleanDraft(exBare.ai_draft) : { text: null, sentinel: null };
  const tpo = ((ex ?? exBare)?.tpo_label ?? "").trim() || null;
  const brainIntent = (dec.last?.intent ?? "").trim() || null;
  const exIntent = ((ex ?? exBare)?.customer_intent ?? "").trim() || null;
  const input: WatchTurnInput = {
    conversation_id: o.conversationId,
    customer_turn_at: o.turn.turnAt,
    conv_status: dec.last?.conversation_status ?? null,
    draft_last: cd.text ? ex!.ai_draft : null,
    // 下書きを作った時刻は手本に残っていない（送った時刻だけ）＝ draft_ready_before_staff は数えない（null）
    draft_last_at: null,
    draft_first: null,
    draft_first_at: null,
    draft_versions: cd.text ? 1 : 0,
    draft_sentinel: cd.sentinel,
    brain_action: dec.last?.suggested_action ?? null,
    brain_reply_mode: dec.last?.suggested_reply_mode ?? null,
    brain_versions: dec.n,
    tpo_label: tpo,
  };
  return {
    input, source: ex ? "ai_reply_examples" : "brain_decision_logs", example: ex, decision: dec.last, staleExample: stale ? ex0!.id : null, draftKnownAbsent,
    sceneSrc: tpo ? "tpo" : brainIntent ? "brain_intent" : exIntent ? "example_intent" : "none",
    intentFallback: brainIntent ? null : exIntent,
    customerLastAt: w.customerLastAt,
  };
}

/** 月（日本時間 YYYY-MM） */
export function jstMonthOf(iso: string): string {
  const d = new Date(ms(iso) + 9 * 3600_000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
