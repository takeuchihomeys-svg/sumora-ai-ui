// app/lib/viewing-check-first.ts
// 「内覧したい」の番の最初の一手（純関数・依存なし）。
//
// 2026-10-07 5巡目（竹内さん「内覧できるか確認」）: 内覧の依頼には、まず「内覧できるか確認」を挟む
//   （内覧可能かの確認の約束の返信 → 確認後に AIX【内覧調整】）。今日の決め「お客様が日時を指定・変更した時は AIX【内覧調整】を直接」
//   （3巡目 VIEWING_FLOW_GATE）とは両立させる＝線は scripts/audit-viewing-wish-first-step.ts（下の注記）。
//
// 2026-10-07 6巡目（竹内さん「１退去予定ではない場合は内覧誘導する」）: 確認を挟むのは**退去予定（入居中）のお部屋だけ**。
//   今見られるお部屋（退去予定の話が無い・こちらが内覧を案内済み・別のお部屋に話が移った）はそのまま AIX【内覧調整】で候補日を出す＝内覧誘導。
//   退去予定かは決定論で（viewingRoomVacating）: 物件ごとの台帳（property-thread の確認の結果）→ 資料の退去予定日（property-send-state の notViewable）
//   → 会話の退去予定の話（move-out-context の moveOutViewingVerdict）の順。線は scripts/audit-viewing-wish-vacating.ts。
//   戻す: VIEWING_CHECK_VACATING_ONLY=off（5巡目の「いつも確認を挟む」に戻る）

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
  /** 内覧を希望されたお部屋が退去予定（入居中）でまだ内覧できない（viewingRoomVacating）。undefined は 5巡目の扱い（判断材料なし） */
  vacating?: boolean;
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
  // 6巡目: 退去予定のお部屋の時だけ確認を挟む（今見られるお部屋は内覧誘導＝AIX【内覧調整】を直接）
  if ((env.VIEWING_CHECK_VACATING_ONLY ?? "").toLowerCase() !== "off" && i.vacating === false) return false;
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

// ─── 6巡目（10/07）: 内覧を希望されたお部屋が退去予定か（決定論・純関数）───

/** 物件ごとの台帳（property-thread）から読んだ、今の番のお部屋の最後の確認の結果 */
export type ThreadRoomCheck = "vacating" | "available" | "ended" | null;

/** moveOutViewingVerdict の理由（move-out-context と同じ値。ここでは型の依存を持たない） */
export type MoveOutReason = "no_move_out" | "viewing_offered" | "hold_advised" | "hold_for_other_property" | "switched_to_other_property" | "customer_names_other_property" | "no_hold_advice";

export type VacatingInput = {
  /** 台帳の今の番のお部屋の最後の確認の結果（引用・名指しで今の番のお部屋が1つに決まる時だけ） */
  threadCheck?: ThreadRoomCheck;
  /** 資料・こちらの送付に書かれた退去予定日から、まだ内覧できない（property-send-state の notViewable・こちらが案内済みなら false） */
  notViewable?: boolean | null;
  /** 会話の退去予定の話（move-out-context の moveOutViewingVerdict の reason） */
  moveOutReason?: MoveOutReason | null;
  /** 退去予定の話の後に、こちらが別のお部屋を送った（台帳の送付の記録・画像だけの送付も分かる）。otherRoomSentAfterMoveOut */
  otherRoomSentAfter?: boolean;
};
export type VacatingVerdict = { vacating: boolean; why: string };

/**
 * 内覧を希望されたお部屋が「退去予定（入居中）でまだ内覧できない」か。
 *   ①台帳で今の番のお部屋の確認の結果が分かればそれ（退去予定→true・募集中→false）
 *   ②資料の退去予定日がまだ先（notViewable）→ true
 *   ③会話の退去予定の話: こちらが内覧を案内済み・別のお部屋に話が移った・退去予定の話が無い → false／退去予定の話のお部屋のまま → true
 *   どれも無ければ false（今見られるお部屋として内覧誘導）
 */
export function viewingRoomVacating(i: VacatingInput): VacatingVerdict {
  if (i.threadCheck === "vacating") return { vacating: true, why: "台帳: 確認の結果 退去予定" };
  if (i.threadCheck === "available") return { vacating: false, why: "台帳: 確認の結果 募集中" };
  if (i.threadCheck === "ended") return { vacating: false, why: "台帳: 募集終了（内覧の確認ではない）" };
  // 別のお部屋に話が移った時は、資料の退去予定日（会話の中の別のお部屋の日付のことがある）より先に見る
  //   （監査 5045ccd6 6/05: 資料の退去予定日だけで「退去予定」と読んだ番にスタッフは直近の候補日を出していた）
  switch (i.moveOutReason ?? "no_move_out") {
    case "switched_to_other_property": case "customer_names_other_property": case "hold_for_other_property": return { vacating: false, why: `会話: 別のお部屋の話（${i.moveOutReason}）` };
    default: break;
  }
  // 退去予定の話の後に別のお部屋を送った（名前の無い画像の送付は会話の文では分からない＝台帳の送付の記録で見る・YUMA の再生 5045ccd6 6/05）
  if (i.otherRoomSentAfter && i.moveOutReason !== "hold_advised") return { vacating: false, why: "台帳: 退去予定の話の後に別のお部屋を送った" };
  if (i.notViewable === true) return { vacating: true, why: "資料: 退去予定日がまだ先" };
  switch (i.moveOutReason ?? "no_move_out") {
    case "hold_advised": case "no_hold_advice": return { vacating: true, why: `会話: 退去予定の話のお部屋（${i.moveOutReason}）` };
    case "viewing_offered": return { vacating: false, why: "会話: 退去予定の後にこちらが内覧を案内済み" };
    default: return { vacating: false, why: "退去予定の話なし" };
  }
}

/** 台帳（property-thread の状態）から、今の番のお部屋の最後の確認の結果を読む（今の番のお部屋が1つに決まる時だけ） */
export function threadRoomCheckForTurn(s: { rooms: ReadonlyArray<{ key: string; events: ReadonlyArray<{ kind: string }> }>; turnTargets: ReadonlyArray<{ roomKey: string }> } | null | undefined): ThreadRoomCheck {
  if (!s) return null;
  const keys = [...new Set(s.turnTargets.map((t) => t.roomKey))];
  if (keys.length !== 1) return null;
  const r = s.rooms.find((x) => x.key === keys[0]);
  const last = r ? [...r.events].reverse().find((e) => e.kind === "check_vacating" || e.kind === "check_available" || e.kind === "check_ended") : undefined;
  return last ? (last.kind === "check_vacating" ? "vacating" : last.kind === "check_available" ? "available" : "ended") : null;
}

/**
 * 退去予定の話（最後の通の時刻 moveOutAt・その通の本文 moveOutText）の後に、こちらが別のお部屋を送ったか（台帳の rooms の送付の記録）。
 *   moveOutTextKey は本文を customer-state.buildingKeyOf で鍵と同じ形にした物（呼ぶ側で）。同じお部屋か＝台帳のお部屋の建物の鍵（頭4文字）がその中にあるか（「エステイトE森ノ宮ですが、6月末退去予定」のように号室の無い書き方も拾う）
 */
export function otherRoomSentAfterMoveOut(
  rooms: ReadonlyArray<{ ref: { buildingKey: string }; events: ReadonlyArray<{ kind: string; at: string }> }> | null | undefined,
  moveOutAt: string | null | undefined, moveOutTextKey: string | null | undefined,
): boolean {
  if (!rooms || !moveOutAt || !moveOutTextKey) return false;
  const t = Date.parse(moveOutAt);
  const same = (bk: string) => bk.length >= 3 && moveOutTextKey.includes(bk.slice(0, Math.min(4, bk.length)));
  return rooms.some((r) => !same(r.ref.buildingKey) && r.events.some((e) => e.kind === "sent" && Date.parse(e.at) > t));
}
