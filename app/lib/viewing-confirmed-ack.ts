// app/lib/viewing-confirmed-ack.ts — 内覧が決まった後の締め＋お客様のスタンプ・了承だけの番（純関数・材料の1行）
//
// 2026-10-28 竹内さんの指摘（今週の LINE #2 咲・#16 かずき）:
//   #2 スタッフ「それでは10/24日12:00より何卒よろしくお願い致します」（内覧が決まった締め）→ お客様［スタンプ］→ 下書きが審査の話を足した。
//     竹内さん「お客さんからスタンプきたら締まっている。会話入れない。そのまま当日の内覧の挨拶まで、向こうから連絡こない場合入れない」
//   #16 待ち合わせ場所を送った後の「よろしくお願いします🙇」→ 下書き「11/2日は何卒よろしくお願い致します」（表記の直しは別）
//   既にある「締めの後のお礼」（closed-ack・BRAIN_DEMOTE_CLOSED_ACK）は「何時でもお気軽に」の締めと物件の提案中だけで、内覧が決まった締めは対象外だった。
// 形: 材料の1行（決めるのはブレイン＝P0）。返さない時は aix null・reply_mode=aix（下書きを作らない）
// 切替: VIEWING_CONFIRMED_ACK_WAIT=on の時だけ（既定 off）。テスト: app/lib/__tests__/viewing-confirmed-ack.test.ts
export function viewingConfirmedAckWaitEnabled(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.VIEWING_CONFIRMED_ACK_WAIT ?? "").trim().toLowerCase() === "on";
}

const STAMP_ONLY_RE = /^(?:\s*\[スタンプ\]\s*)+$/;
/** こちらの締めの形（内覧の確定の後の「何卒よろしくお願い致します」「お待ちしております」「お気をつけて」） */
const STAFF_VIEWING_CLOSE_RE = /(?:何卒|宜しく|よろしく)[^\n]{0,6}お願い(?:致|いた)?します|お待ちして(?:おります|います)|お気をつけて/;

export type ViewingConfirmedAckInput = {
  /** 内覧が決まっている（viewing-flow の stage=confirmed か、今日より後の決まった内覧がある） */
  viewingConfirmed: boolean;
  /** 今のお客様の連投（つないだ文） */
  customerTurnText: string;
  /** 今の連投がお礼・了承だけ（analyzeSubstance.isAckOnly 等） */
  customerAckOnly: boolean;
  /** お客様の連投の前のこちらの最後の文字の発言 */
  lastStaffText: string | null;
};

/** この番か（材料を出すか） */
export function isViewingConfirmedAck(i: ViewingConfirmedAckInput): boolean {
  if (!i.viewingConfirmed) return false;
  const turn = String(i.customerTurnText ?? "").trim();
  const stampOnly = !!turn && STAMP_ONLY_RE.test(turn);
  if (!stampOnly && !i.customerAckOnly) return false;
  if (/[?？]/.test(turn)) return false;
  const staff = String(i.lastStaffText ?? "");
  const tail = staff.split("\n").map((l) => l.trim()).filter(Boolean).slice(-2).join("\n");
  return STAFF_VIEWING_CLOSE_RE.test(tail) && !/[?？]\s*[😊😌✨！!]*$/.test(tail);
}

export function viewingConfirmedAckMaterialLine(lastStaffText: string | null): string {
  const q = Array.from(String(lastStaffText ?? "").split("\n").map((l) => l.trim()).filter(Boolean).slice(-1)[0] ?? "").slice(0, 40).join("");
  return `【内覧が決まった後の締め＋お客様のスタンプ・了承だけ（材料）】こちらの最後の送信は内覧が決まった締め（「${q}」）で、お客様の今の発言はスタンプかお礼・了承だけ。` +
    "竹内さんの決め（10/28）: 会話は締まっている。返信を入れず、当日の内覧の挨拶（AIX）まで待つ（お客様から新しい連絡が来た時だけ返す）。返さない時は aix null・reply_mode=aix（下書きを作らない）。" +
    "審査・費用など、聞かれていない話を足さない。";
}
