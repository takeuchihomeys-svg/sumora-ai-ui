// app/lib/shown-draft-restore.ts
// 画面が「表示済み」（ai_draft='__SHOWN__'）にした下書きを、別の端末・読み込み直しの後でも入力欄に戻すかの判定（純関数・依存なし）。
//
// 2026-10-08 竹内（未桜さんのスクショ）「AI返信案がセットされていない事も多い…ちゃんとセットされるように」:
//   調べると下書きは作られていた（line_watch_turns.draft_first 05:15:52Z・最終チェック ok）。消えていたのは表示の所。
//   画面（page.tsx）は会話を「選んでいる」端末が下書きを受けた時点で入力欄に入れ、DB の ai_draft を '__SHOWN__' に上書きする。
//   本文はその端末のメモリ（shownDraftCacheRef）にしか残らないので、
//     ・スマホで一覧に戻っても選択は残る（mobileView だけ list）→ 見ていない会話の下書きが裏で「表示済み」になる
//     ・読み込み時は一番上の会話を自動で選ぶ（新着の会話＝下書きが来る会話）
//     ・iPhone の Safari はアプリを切り替えると読み込み直す（メモリの控えが消える）
//     ・別の端末・別のスタッフが開く
//   のどれでも、次に開いた時は ai_draft='__SHOWN__' → 入力欄は空・bg-async も already_has_draft で作り直さない＝行き止まりだった。
//   → 表示済みにする時に本文と時刻を conversations.ai_draft_shown / ai_draft_shown_at に控え、開いた時にこの判定で戻す。
//
// 戻す条件（すべて満たす時だけ）:
//   - 今がお客様の番（last_sender = customer）。スタッフが送った後は戻さない
//   - ai_draft が '__SHOWN__'（＝表示で消えただけ。お客様の新着は webhook が null に戻し、新しい下書きが来れば ai_draft に本文が入る）
//   - 控えが本文（印でない・空でない）
//   - 控えた時刻が最新のお客様の発言より後（＝今の番の下書き）。generate-reply の「前と同じ文」の __SHOWN__（控えを書かない）で
//     前の番の控えが残っていても、時刻で弾く
// 戻す: NEXT_PUBLIC_SHOWN_DRAFT_RESTORE=off（画面は控えを書かず、戻しもしない＝旧の動き）

export const SHOWN_SENTINEL = "__SHOWN__";

const SENTINEL_RE = /^\s*(?:__[A-Z_]{2,30}__|\[[^\]]{1,30}\])\s*$/;

export type ShownDraftRestoreInput = {
  aiDraft: string | null | undefined;
  shownDraft: string | null | undefined;
  shownAt: string | null | undefined;
  latestCustomerAt: string | null | undefined;
  lastSender: string | null | undefined;
};

export type ShownDraftRestoreReason =
  | "not_customer_turn" | "not_shown" | "no_copy" | "copy_is_sentinel" | "no_time" | "older_turn" | "restore";

export function decideShownDraftRestore(i: ShownDraftRestoreInput): { text: string | null; reason: ShownDraftRestoreReason } {
  if (i.lastSender !== "customer") return { text: null, reason: "not_customer_turn" };
  if ((i.aiDraft ?? "").trim() !== SHOWN_SENTINEL) return { text: null, reason: "not_shown" };
  const copy = (i.shownDraft ?? "").trim();
  if (!copy) return { text: null, reason: "no_copy" };
  if (SENTINEL_RE.test(copy)) return { text: null, reason: "copy_is_sentinel" };
  const shownMs = i.shownAt ? Date.parse(i.shownAt) : NaN;
  const custMs = i.latestCustomerAt ? Date.parse(i.latestCustomerAt) : NaN;
  if (!Number.isFinite(shownMs) || !Number.isFinite(custMs)) return { text: null, reason: "no_time" };
  if (shownMs < custMs) return { text: null, reason: "older_turn" };
  return { text: copy, reason: "restore" };
}

/** 画面の旗（既定 on）。NEXT_PUBLIC_ は build 時に埋まる */
export function shownDraftRestoreEnabled(flag: string | undefined): boolean {
  return (flag ?? "on").trim().toLowerCase() !== "off";
}

/** 表示済みにする時の更新の中身（控えつき）。旗が off なら旧の中身のまま */
export function shownDraftUpdate(text: string | null | undefined, enabled: boolean, now: Date = new Date()): Record<string, unknown> {
  const base: Record<string, unknown> = { ai_draft: SHOWN_SENTINEL, suggested_aix_meta: null };
  const t = (text ?? "").trim();
  if (!enabled || !t || SENTINEL_RE.test(t)) return base;
  return { ...base, ai_draft_shown: t, ai_draft_shown_at: now.toISOString() };
}
