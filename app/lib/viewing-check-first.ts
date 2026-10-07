// app/lib/viewing-check-first.ts
// 「内覧したい」の番の最初の一手（純関数・依存なし）。
//
// 2026-10-07 5巡目（竹内さん「内覧できるか確認」）: 内覧の依頼には、まず「内覧できるか確認」を挟む
//   （内覧可能かの確認の約束の返信 → 確認後に AIX【内覧調整】）。今日の決め「お客様が日時を指定・変更した時は AIX【内覧調整】を直接」
//   （3巡目 VIEWING_FLOW_GATE）とは両立させる＝線は scripts/audit-viewing-wish-first-step.ts（下の注記）。

/** スタッフの「内覧可能か確認します」の約束（手打ち） */
export const VIEWING_CHECK_PROMISE_RE = /(?:ご)?内[覧見](?:可能か|可否|出来るか|できるか|が可能か)[^\n。！!]{0,20}(?:確認|お調べ)|(?:ご)?内[覧見][^\n。！!]{0,12}(?:可能|出来る|できる)か(?:どうか)?[^\n。！!]{0,12}(?:確認|お調べ)|(?:ご)?案内(?:可能か|可否|出来るか|できるか)[^\n。！!]{0,16}確認|(?:ご)?内[覧見](?:開始日|可能日|可能な?日|開始)[^\n。！!]{0,16}確認/;
/** スタッフの候補日・ご都合の打診（手打ち） */
const STAFF_INVITE_RE = /(?:[0-9]{1,2}\s*[\/月]\s*[0-9]{1,2}|[0-9]{1,2}日|明日|明後日|本日)[^\n]{0,30}(?:いかが|如何|ご都合|ご予定|ご案内(?:可能|出来|でき))|直近ですと|ご都合(?:の)?(?:よろしい|良い|いい)(?:お)?(?:日|時間)|ご都合(?:いかが|如何)|何日|いつ頃|ご希望(?:の)?(?:お)?日(?:にち|時)|ご案内させて頂きます|ご案内させていただきます/;

export type ViewingFirstStep = "confirm" | "invite" | "meeting" | "other";

/** スタッフの最初の返し（30分のまとまりの文＋押した AIX）を分ける */
export function classifyViewingFirstStep(texts: ReadonlyArray<string>, aixTypes: ReadonlyArray<string>): ViewingFirstStep {
  if (aixTypes.includes("meeting_place")) return "meeting";
  if (aixTypes.includes("viewing_invite")) return "invite";
  const t = texts.join("\n");
  if (VIEWING_CHECK_PROMISE_RE.test(t)) return "confirm";
  if (STAFF_INVITE_RE.test(t)) return "invite";
  return "other";
}

/** こちらが「内覧できる」と伝えた形（「可能か確認」の約束は除く） */
const VIEWABLE_RE = /(?:ご案内|ご内覧|内[覧見])(?:可能|出来|でき)(?:です|となります|ます|な(?:お部屋|状態))|即日(?:ご案内|ご内覧|内[覧見])|退去済|内[覧見]開始(?:して|しており)/;
const DATE_REPLIES = new Set(["date_time", "day_pick", "day_only", "ask_back"]);

export type ViewingCheckFirstInput = {
  /** 内覧の流れの段階（viewing-flow） */
  stage: string;
  /** 今回のお客様の日時の返事（viewing-flow の currentReply） */
  currentReply: string | null;
  /** 今回の連投が内覧の希望か（viewing-flow の currentWish） */
  currentWish: boolean;
  /** 今回のお客様の連投の最初の時刻 */
  turnAt: string;
  /** 今回の連投より前のこちらの発言（古い順・時刻つき） */
  staffBefore: ReadonlyArray<{ text: string; createdAt: string }>;
};

/**
 * 「内覧したい」に、まず内覧できるかの確認の約束を挟むか（true＝挟む）。
 *   ・日時の指定・変更（日・日時・聞き返し）は挟まない（3巡目の決め「AIX【内覧調整】を直接」）
 *   ・候補日を出した後（proposing 以降）は挟まない（もう内覧できる前提で調整中）
 *   ・24時間以内にこちらが「ご案内可能です／即日ご案内／退去済」と伝えている時は挟まない（確認済み）
 *   戻す: VIEWING_CHECK_FIRST=off
 */
export function viewingCheckFirst(i: ViewingCheckFirstInput, env: Record<string, string | undefined> = (typeof process !== "undefined" ? process.env : {})): boolean {
  if ((env.VIEWING_CHECK_FIRST ?? "").toLowerCase() === "off") return false;
  if (i.stage !== "none" && i.stage !== "wished") return false;
  // お客様が今回 内覧を希望した時だけ（こちらからの内覧の誘い・前の希望の続きの別の話は触らない）
  if (!i.currentWish) return false;
  if (i.currentReply && DATE_REPLIES.has(i.currentReply)) return false;
  const t0 = Date.parse(i.turnAt);
  const confirmed = i.staffBefore.some((m) => {
    const t = m.text ?? "";
    if (!VIEWABLE_RE.test(t) || VIEWING_CHECK_PROMISE_RE.test(t)) return false;
    return !Number.isFinite(t0) || t0 - Date.parse(m.createdAt) <= 24 * 3600_000;
  });
  return !confirmed;
}
