// app/lib/brain-attention.ts
// 「次にやる事」をブレインの判断だけから決める（純関数・DB/サーバー依存なし・画面からも使える）
//
// 2026-10-08 竹内さんの決定（原文）:
//   1「タスクは、ブレインの判断（AIX要対応）から作る形に一本化する」
//   2「ブレインの判断に寄せる」（グループの今日のターゲット全リスト・daily-brief の【返信あり】【最優先】【新着】）
//   3「（物件出し依頼 自動検知の通知は）やめて良い ブレイン最優先」
//   4「（hot＝物件を出すべき人は）ブレインの判断にする」
//   5「ブレインの2択に寄せる。ブレインが画面に反映させる」
//   追加（ターゲットの正の基準）「ターゲットは、一度内覧に行った事がある人・申込をしたけど審査に落ちた人が最優先。
//     それと新規のお客さんや、継続して食いついて物件検索しているお客さんは明確なターゲット」
//
// 旧（ブレイン以外が決めていた所）:
//   ・タスク（line_tasks）… お客様の発言の語（autoDetectTask）・スタッフ送信の語（send-line-message）・画面の語／印 で作っていた
//   ・要対応（is_flagged）… 受信のたびに true（実質 全員）。今日のターゲット・daily-brief・画面の絞り込み／橙／次に返信すべき1件 の元
//   ・hot … 受信のたびに property_customers.status を機械的に hot へ
//   ・画面の帯 … 送った文の正規表現（P4 物件オススメ／全力サポートの2択）・status だけ（P2〜P2.6）・テンプレの点滅（status か「お申込み」）
// 新: 全部ここの関数（ブレインの判断＝suggested_aix_meta と AIX要対応＝aix_action_items の pending）から決める。
//   戻す環境変数は各所（BRAIN_TASKS_ONLY・DRAFT_BLOCK_BY_TASK・BRAIN_ATTENTION・BRAIN_TARGET_LIST・HOT_BY_BRAIN・NEXT_PUBLIC_BRAIN_ATTENTION）
import { BRAIN_AIX_LABELS, sameAixAction } from "@/app/lib/aix-button-view";
import { propertyCheckKindFor } from "@/app/lib/aix-taxonomy";
import { brainPausedCustomer } from "@/app/lib/aix-item-cleanup";
import { aixButtonText } from "@/app/lib/aix-action-text";

/** ブレインの判断のうち、ここで読む項目だけ（suggested_aix_meta の部分集合） */
export type AttentionMeta = {
  action?: string | null;
  reply_mode?: string | null;
  source?: string | null;
  decision_source?: string | null;
  check_pattern?: string | null;
  first_contact_pickup?: string | null;
  pending_pickup?: boolean | null;
  analyzed_msg_ts?: string | null;
  purchase_signal_level?: string | null;
  checkpoint_stage?: string | null;
  customer_intent?: string | null;
  hesitancy_pattern?: string | null;
  condition_change_type?: string | null;
  two_choice_mode?: boolean | null;
  alt_actions?: string[] | null;
};

/** 申込以降（ブレインの管轄外・別のツール）。審査落ちで切り替え中の人だけは例外で対象（project_post_apply_out_of_scope） */
export const POST_APPLY_STATUSES = new Set(["applying", "application", "screening", "approved", "contract", "closed_won", "closed_lost", "lost"]);
const CLOSED_STATUSES = new Set(["closed_won", "closed_lost", "lost", "contract"]);

/** 物件を届ける AIX（物件ピックアップした・物件オススメ・物件検索） */
export const PROPERTY_AIX = new Set(["property_send", "property_recommendation", "property_search"]);

const isLive = (m: AttentionMeta | null | undefined): m is AttentionMeta => !!m && m.source !== "cached";
const isPromise = (m: AttentionMeta, kind: "pickup" | "check" | "estimate") =>
  (m.decision_source ?? "").startsWith(`promise:${kind}`) || (kind === "pickup" && (m.decision_source ?? "") === "signal:pending_pickup");

/** ブレインが「この発言に AIX が要る」と判断した AIX（実在のボタン・reply_mode=aix・初回の条件受領）。無ければ null */
export function brainAixOf(meta: AttentionMeta | null | undefined): string | null {
  if (!isLive(meta)) return null;
  if (meta.first_contact_pickup && BRAIN_AIX_LABELS[meta.first_contact_pickup]) return meta.first_contact_pickup;
  if (meta.action && BRAIN_AIX_LABELS[meta.action] && meta.reply_mode === "aix") return meta.action;
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. タスク（line_tasks）— ブレインの判断から作る1か所
// ─────────────────────────────────────────────────────────────────────────────
export type BrainTaskType = "property_check" | "property_send" | "estimate_sheet";

/**
 * ブレインの判断から「やること（line_tasks）」に置く種類。
 *   物件確認（property_check） … ブレインが AIX【物件確認した】（募集状況・室内写真・未定）と判断／確認の約束を果たす番（promise:check）
 *                                 ※ 条件・交渉の確認（確認した（条件・交渉））は募集状況の確認ではないので置かない（台帳が「募集状況の確認の約束」と読むため）
 *   見積書対応（estimate_sheet） … ブレインが AIX【見積書送る】と判断／見積の約束（promise:estimate）
 *   物件出し（property_send）   … こちらが既にピックアップを約束している（promise:pickup・signal:pending_pickup・pending_pickup=true）時だけ
 *     ⚠ 約束していない AIX【物件ピックアップした】は line_tasks に置かない。台帳（action-ledger）は pending の物件出しを
 *       「こちらがピックアップを宣言した（未履行）」と読む → pending_pickup → AIX要対応が取り下がらない、のループになる。
 *       その番の「やること」は AIX要対応（aix_action_items）そのもの（画面の帯・朝の報告はそちらから出す）
 * cached（今回の発言を見ていない判断）は null（何も変えない）。
 */
export function brainTaskTypes(meta: AttentionMeta | null | undefined): BrainTaskType[] | null {
  if (!isLive(meta)) return null;
  const out: BrainTaskType[] = [];
  const aix = brainAixOf(meta);
  const checkSide = propertyCheckKindFor(meta.check_pattern ?? null)?.ui_button === "確認した（条件・交渉）";
  if ((aix === "property_check_result" || (meta.action === "property_check_result" && isPromise(meta, "check"))) && !checkSide) out.push("property_check");
  if (aix === "estimate_sheet" || (meta.action === "estimate_sheet" && isPromise(meta, "estimate"))) out.push("estimate_sheet");
  if (meta.pending_pickup === true || (PROPERTY_AIX.has(meta.action ?? "") && isPromise(meta, "pickup"))) out.push("property_send");
  return out;
}

/**
 * ブレインの今の判断で、ブレインが前に置いたやること（印 result_note="brain"）のうち取り下げる種類。
 *   物件出し は「約束が残っていない」とブレインがはっきり言った時（pending_pickup=false）だけ取り下げる（約束は台帳が持つ）
 */
export function brainTaskTypesToCancel(meta: AttentionMeta | null | undefined): BrainTaskType[] {
  const want = brainTaskTypes(meta);
  if (!want) return [];
  const out: BrainTaskType[] = [];
  if (!want.includes("property_check")) out.push("property_check");
  if (!want.includes("estimate_sheet")) out.push("estimate_sheet");
  if (!want.includes("property_send") && meta?.pending_pickup === false) out.push("property_send");
  return out;
}

/** ブレイン由来のやることの印（line_tasks.result_note。完了の時に結果のメモで上書きされてよい） */
export const BRAIN_TASK_NOTE = "brain";

// ─────────────────────────────────────────────────────────────────────────────
// 2. 要対応（スタッフが動く番）— is_flagged の代わり
// ─────────────────────────────────────────────────────────────────────────────
export type AttentionInput = {
  meta: AttentionMeta | null | undefined;
  /** aix_action_items の pending（1会話1件）の action */
  pendingAixAction?: string | null;
  lastSender?: string | null;
  status?: string | null;
};

/**
 * ブレインの判断で「スタッフが動く番」か。
 *   AIX要対応が pending／ブレインの今の判断が AIX（お客様が最後・または約束を果たす番）／物件出しの約束が残っている（pending_pickup）
 *   申込以降・成約・失注は出さない（ブレインの管轄外）
 */
export function brainNeedsStaff(i: AttentionInput): { needs: boolean; reason: string | null } {
  if (CLOSED_STATUSES.has(String(i.status ?? ""))) return { needs: false, reason: null };
  if (i.pendingAixAction && BRAIN_AIX_LABELS[i.pendingAixAction]) return { needs: true, reason: `AIX要対応:${i.pendingAixAction}` };
  const m = i.meta;
  if (!isLive(m)) return { needs: false, reason: null };
  const aix = brainAixOf(m);
  const byPromise = /^(promise:|signal:pending_pickup)/.test(m.decision_source ?? "");
  if (aix && (i.lastSender === "customer" || byPromise)) return { needs: true, reason: `brain:${aix}` };
  if (m.pending_pickup === true) return { needs: true, reason: "pending_pickup" };
  return { needs: false, reason: null };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. 今日のターゲット（グループの全リスト・daily-brief・hot）
// ─────────────────────────────────────────────────────────────────────────────
export type TargetTier = "viewed" | "screening_failed" | "new" | "engaged";
export const TARGET_TIER_RANK: Record<TargetTier, number> = { viewed: 1, screening_failed: 2, new: 3, engaged: 4 };
export const TARGET_TIER_LABEL: Record<TargetTier, string> = { viewed: "内覧済み", screening_failed: "審査落ち・切り替え", new: "新規", engaged: "物件検索中" };

export type TargetInput = {
  status: string | null;
  lineStatus?: string | null;
  createdAt?: string | null;
  /** 最後のお客様の発言の時刻（無ければ updated_at と last_sender から） */
  lastCustomerAt?: string | null;
  meta: AttentionMeta | null | undefined;
  pendingAixAction?: string | null;
  /** 内覧に行った（viewing_history done・日付経過 lapsed）の一番新しい日（YYYY-MM-DD か ISO） */
  lastViewedAt?: string | null;
  /** 審査落ちで切り替え中（スタッフが申込から戻した印 status_manual_back_at／ブレインの correction:screening_failed_switch／お客様の審査落ちの報告） */
  screeningFailedAt?: string | null;
  /** スタッフの送信がまだ無い（初回の挨拶前） */
  staffNeverReplied?: boolean;
  nowMs: number;
};

const DAY = 86_400_000;
const tms = (s: string | null | undefined) => { const v = s ? Date.parse(s) : NaN; return Number.isFinite(v) ? v : NaN; };
const daysSince = (s: string | null | undefined, now: number) => { const v = tms(s); return Number.isFinite(v) ? (now - v) / DAY : Infinity; };

/** 内覧済み・審査落ちの人を最優先に残す期間（お客様の発言か内覧・否決の日から） */
export const TARGET_PRIORITY_DAYS = 30;
/** 新規の期間（会話の作成から） */
export const TARGET_NEW_DAYS = 3;
/** 食いつき（継続して物件検索）の期間（お客様の最後の発言から） */
export const TARGET_ENGAGED_DAYS = 7;

/**
 * 今日のターゲットの段（無ければ null）。並びは ①内覧済み ②審査落ち（切り替え中）③新規 ④継続して食いついて物件検索中。
 *   止まった・断った（ブレインの取り下げと同じ線 brainPausedCustomer・intent=negative）人は ③④ に入れない（①② は最優先なので残す）
 */
export function classifyTarget(i: TargetInput): { tier: TargetTier; reason: string } | null {
  const status = String(i.status ?? "");
  if (i.lineStatus === "blocked") return null;
  if (CLOSED_STATUSES.has(status)) return null;
  const custDays = daysSince(i.lastCustomerAt, i.nowMs);
  const failed = !!i.screeningFailedAt && daysSince(i.screeningFailedAt, i.nowMs) <= TARGET_PRIORITY_DAYS * 2;
  // 申込以降は審査落ちの切り替えだけ
  if (POST_APPLY_STATUSES.has(status) && !failed) return null;
  if (failed && Math.min(custDays, daysSince(i.screeningFailedAt, i.nowMs)) <= TARGET_PRIORITY_DAYS) return { tier: "screening_failed", reason: "申込→審査落ち（切り替え中）" };
  if (i.lastViewedAt && Math.min(custDays, daysSince(i.lastViewedAt, i.nowMs)) <= TARGET_PRIORITY_DAYS) return { tier: "viewed", reason: "一度内覧に行った" };
  const m = isLive(i.meta) ? i.meta : null;
  // 取り下げと同じ線だけ（intent=negative 単独では外さない: 実物 チンシャン 10/08 は物件1件への否定で、物件出しの約束は残っている）
  const paused = !!m && brainPausedCustomer(m as Parameters<typeof brainPausedCustomer>[0]).paused;
  if (paused) return null;
  if (daysSince(i.createdAt, i.nowMs) <= TARGET_NEW_DAYS || (i.staffNeverReplied && custDays <= TARGET_NEW_DAYS)) return { tier: "new", reason: "新規のお客様" };
  if (custDays <= TARGET_ENGAGED_DAYS) {
    const e = engagedSignal(m, i.pendingAixAction ?? null);
    if (e) return { tier: "engaged", reason: e };
  }
  return null;
}

/** ブレインが「物件に食いついている・物件を出す番」と読んだ印（無ければ null） */
export function engagedSignal(m: AttentionMeta | null, pendingAixAction: string | null): string | null {
  if (pendingAixAction && (PROPERTY_AIX.has(pendingAixAction) || pendingAixAction === "property_check_result" || pendingAixAction === "estimate_sheet" || pendingAixAction === "viewing_invite"))
    return `AIX要対応:${pendingAixAction}`;
  if (!m) return null;
  if (m.first_contact_pickup) return "初回の条件";
  if (m.pending_pickup === true) return "物件出しの約束";
  if (m.action && PROPERTY_AIX.has(m.action)) return `物件の判断:${m.action}`;
  if (m.condition_change_type) return `条件の言い直し:${m.condition_change_type}`;
  if (m.purchase_signal_level === "strong" || m.purchase_signal_level === "peak") return `購買の強さ:${m.purchase_signal_level}`;
  if (m.purchase_signal_level === "soft" && (m.checkpoint_stage === "hearing" || m.checkpoint_stage === "proposing" || m.checkpoint_stage === "viewing")) return "物件への質問";
  return null;
}

/**
 * hot（今日物件を出すべき人）をブレインで決める。ターゲットの段と同じ基準（①〜④）で、物件を出す余地がある人。
 *   物件の中身（どの物件か）は物件検索ブレインの領分。ここは「誰に物件を出すか」の LINE 側の判断だけ
 *   ※ 昇格だけ（new_inquiry・property_search → hot）。下げるのは今まで通り物件ツールの側（送付回数）
 */
export function brainHotDecision(i: TargetInput): { hot: boolean; reason: string | null } {
  const t = classifyTarget(i);
  if (!t) return { hot: false, reason: null };
  // 新規は条件が届いて物件の番になっている時だけ（挨拶だけの番は物件を出さない）
  if (t.tier === "new") {
    const m = isLive(i.meta) ? i.meta : null;
    const e = engagedSignal(m, i.pendingAixAction ?? null);
    return e ? { hot: true, reason: `新規・${e}` } : { hot: false, reason: null };
  }
  return { hot: true, reason: t.reason };
}

/** 一言の要約（希望の条件・状況）。グループのターゲットの「名前（〜）」の中身 */
export type SummaryInput = {
  tier?: TargetTier | null;
  desiredArea?: string | null;
  commuteStation?: string | null;
  commuteMinutes?: number | null;
  rentMax?: number | null;
  floorPlan?: string | null;
  otherRequests?: string | null;
  nextAix?: string | null;
  nextCheckPattern?: string | null;
};
export function targetSummary(s: SummaryInput, maxLen = 48): string {
  const parts: string[] = [];
  if (s.tier === "screening_failed") parts.push("審査落ち・切り替え");
  if (s.tier === "viewed") parts.push("内覧済み");
  if (s.commuteStation) parts.push(`${s.commuteStation}${s.commuteMinutes ? `まで${s.commuteMinutes}分` : ""}`);
  else if (s.desiredArea) parts.push(s.desiredArea.replace(/\s+/g, ""));
  const cond: string[] = [];
  if (s.rentMax && s.rentMax > 0) cond.push(`${Math.round(s.rentMax / 1000) / 10}万円ほど`);
  if (s.floorPlan) cond.push(s.floorPlan.replace(/\s+/g, ""));
  if (cond.length) parts.push(cond.join(""));
  const other = (s.otherRequests ?? "").split(/[、,・\n]/).map((x) => x.trim()).filter(Boolean).slice(0, 2).join("・");
  if (other) parts.push(other);
  let out = parts.join("、");
  if (out.length > maxLen) out = out.slice(0, maxLen - 1) + "…";
  const next = s.nextAix && BRAIN_AIX_LABELS[s.nextAix] ? `→${aixButtonText(s.nextAix, s.nextCheckPattern ?? null)}` : "";
  return [out, next].filter(Boolean).join(" ");
}

/** ターゲットの並び（段 → 最後のお客様の発言が新しい順） */
export function compareTargets(a: { tier: TargetTier; lastCustomerAt?: string | null }, b: { tier: TargetTier; lastCustomerAt?: string | null }): number {
  const r = TARGET_TIER_RANK[a.tier] - TARGET_TIER_RANK[b.tier];
  if (r !== 0) return r;
  const ta = tms(a.lastCustomerAt), tb = tms(b.lastCustomerAt);
  return (Number.isFinite(tb) ? tb : 0) - (Number.isFinite(ta) ? ta : 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. 画面の帯（ブレイン以外が決める帯）— ブレインと食い違う時は出さない
// ─────────────────────────────────────────────────────────────────────────────
/**
 * ブレイン以外の決め方の帯（P0 テンプレ連番・P0.6 連続送信・P1/P2〜P2.6 申込・審査・契約・P4.5 物件オススメ続き・P7.5 AIX 後のテンプレ・テンプレの点滅）を出してよいか。
 *   ブレインの今の判断（最新のお客様の発言を見た判断）が AIX を言っている時: その帯の AIX が同じ時だけ出す（違う AIX＝食い違い→出さない）。
 *     AIX を持たないテンプレの帯（bannerAix=null）はブレインの AIX を先に出すため出さない
 *   ブレインの今の判断が無い・AIX なし: 今まで通り出す（ブレインは何も言っていない＝食い違いではない）
 */
export function nonBrainBannerAllowed(i: { bannerAix: string | null; brainFresh: boolean; brainAix: string | null }): boolean {
  if (!i.brainFresh || !i.brainAix) return true;
  if (!i.bannerAix) return false;
  return sameAixAction(i.bannerAix, i.brainAix);
}

/** 環境変数の on/off（既定 on。"off" の時だけ旧に戻す） */
export function flagOn(v: string | null | undefined): boolean {
  return (v ?? "").trim().toLowerCase() !== "off";
}
