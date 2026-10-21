// app/lib/brain-postsend-cheap.ts — スタッフが約束を送った直後のブレイン再分析（send-line-message）を、決まった計算で足りる時は飛ばす（純関数）
//
// 2026-10-22 測った事（scripts/audit-brain-postsend-value.ts・30日・本番 319回・月 約$18）:
//   再分析の後にスタッフがお客様の次の発言より前にその AIX を押した（＝次の分析を待つと遅れた）番は 53回（17%）だけ。
//   残りは 何も出なかった 166回（多くは同じ要対応が前から立っていた・返信を選んだ）／出たが押さなかった 67回／次の発言の後に押した 33回。
//   役に立った番の要対応 35件のうち、送った通の約束（promise-queue.promisesInStaffText → nextPromiseAix）が同じ AIX を出したのは 28件（緩くて 34件）。
//   → 送った通の約束で次の AIX がはっきり決まる時（募集状況の確認・見積書の約束だけ）は、その要対応とやることをブレインと同じ書き口
//     （aix-action-items.syncAixActionItem・brain-attention-server.syncBrainFollowups）で立てるだけにして Sonnet を呼ばない。
//     分からない時（ピックアップ・条件・写真・内覧の約束が混じる／探し続ける約束だけ／前から違う要対応が立っている／見積る物件・確認の依頼が見えない）は今まで通りブレインを呼ぶ。
//   安い道に乗る番の試算（30日）: 90/319回（$4.8/月 の節約）・ブレインの判断と同じ AIX 73・ブレインは返信だったが安い道は AIX 17（その多くはスタッフが後でその AIX を押した）・
//     違う AIX 0・ブレインだけ AIX 0・役に立った番 21/21 同じ。
//   失う物: 画面の判断（suggested_aix_meta）と brain_decision_logs はその番だけ更新されない（次のお客様の発言でブレインが回る）。
// 既定 OFF: BRAIN_POSTSEND_CHEAP=on で使う。
import { nextPromiseAix, type PickupNeed, type PromiseStep } from "./promise-queue";

export function brainPostSendCheapEnabled(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.BRAIN_POSTSEND_CHEAP ?? "").trim().toLowerCase() === "on";
}

const PROP_FAMILY = new Set(["property_send", "property_recommendation"]);
const norm = (a: string | null | undefined) => (a === "property_check" ? "property_check_result" : String(a ?? ""));
export function sameAixFamily(a: string | null | undefined, b: string | null | undefined): boolean {
  return norm(a) === norm(b) || (PROP_FAMILY.has(norm(a)) && PROP_FAMILY.has(norm(b)));
}

/** 見積る物件があるか（こちらの物件・見積の AIX の送付／お客様の画像・URL／こちらの手打ちの物件画像） */
export function propertyInPlayFrom(msgs: ReadonlyArray<{ sender: string; text: string | null | undefined }>, propertyAixSent: boolean): boolean {
  return propertyAixSent
    || msgs.some((m) => m.sender === "customer" && /\[画像\]|https?:\/\//.test(String(m.text ?? "")))
    || msgs.some((m) => m.sender !== "customer" && /^\s*\[画像\]/.test(String(m.text ?? "")));
}
/** 約束の前のお客様の連投が物件（画像・URL）を指すか確認を頼んでいるか */
export function customerPointedPropertyText(customerTurn: string): boolean {
  return /\[画像\]|https?:\/\/|確認|空いて|空き|募集|まだあり|ここ|こちら/.test(customerTurn);
}
/** 送った通の直前のお客様の連投（古い順の会話・送った通の時刻まで） */
export function customerTurnBefore(msgsOldestFirst: ReadonlyArray<{ sender: string; text: string | null | undefined; createdAt: string }>, beforeMs: number): string {
  const before = msgsOldestFirst.filter((m) => Date.parse(m.createdAt) <= beforeMs);
  const out: string[] = [];
  for (let k = before.length - 1; k >= 0; k--) { if (before[k].sender === "customer") out.unshift(String(before[k].text ?? "")); else if (out.length) break; }
  return out.join("\n");
}

/** 安い道で決めてよい約束の種類（ブレインの約束の規則 resolveStaffPromiseAix とほぼ同じに決まる物） */
//   ピックアップの約束は外す（実測: 安い道の候補 66回のうちブレインが AIX要対応を立てたのは 21回だけ・残りは返信／やることだけ＝2段の約束の扱いが LLM 次第）
const CHEAP_KINDS = new Set<PromiseStep["kind"]>(["check", "estimate"]);

export type PostSendCheapInput = {
  /** 今送った通（手打ち・3分以内の続き）の約束（promisesInStaffText） */
  sentSteps: ReadonlyArray<PromiseStep>;
  nowMs: number;
  need?: PickupNeed | null;
  /** 今立っている AIX要対応（朝の挨拶を除く main の行）の action。無ければ null */
  openItemAction: string | null;
  /** 申込以降（is_post_apply） */
  isPostApply: boolean;
  /** 見積る物件があるか（こちらの物件の送付・お客様の画像/URL） */
  propertyInPlay: boolean;
  /** 約束の前のお客様の連投に物件（画像・URL）か確認の依頼があるか */
  customerPointedProperty: boolean;
};
export type PostSendCheapDecision =
  | { kind: "full"; reason: string }
  | { kind: "skip"; reason: "open_same" }
  | { kind: "insert"; step: PromiseStep; rest: PromiseStep[]; tasks: Array<"property_check" | "estimate_sheet"> };

export function decidePostSendCheap(i: PostSendCheapInput): PostSendCheapDecision {
  if (i.isPostApply) return { kind: "full", reason: "post_apply" };
  const steps = i.sentSteps.filter((s) => s.status === "pending");
  if (!steps.length) return { kind: "full", reason: "no_step" };
  if (steps.some((s) => !CHEAP_KINDS.has(s.kind))) return { kind: "full", reason: "other_kind" };
  const nx = nextPromiseAix(steps, { nowMs: i.nowMs, need: i.need ?? null });
  if (!nx) return { kind: "full", reason: "watch_only" };
  const s = nx.next;
  // ブレインの約束の規則の前提（aix-task-link.resolveStaffPromiseAix）: 見積る物件が無い見積の約束・お客様の依頼が無い確認の約束は AIX にしない＝分からないのでブレインへ
  if (s.kind === "estimate" && !i.propertyInPlay) return { kind: "full", reason: "estimate_no_property" };
  if (s.kind === "check" && !i.customerPointedProperty) return { kind: "full", reason: "check_no_request" };
  if (i.openItemAction) return sameAixFamily(i.openItemAction, s.action) ? { kind: "skip", reason: "open_same" } : { kind: "full", reason: "open_differs" };
  // やること（line_tasks・印 brain）はブレインの brainTaskTypes と同じ向き（物件確認した→物件確認・見積書送る→見積書）
  return { kind: "insert", step: s, rest: nx.rest, tasks: [s.kind === "check" ? "property_check" : "estimate_sheet"] };
}
