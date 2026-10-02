// app/lib/auto-reply-policy.ts
// 「自動」に切り替えたお客様だけ、セットされた下書きをそのまま自動で送る時の決まり（純関数・DB 依存なし）。
//
// 2026-09-18 竹内「自動ボタンをつける。デフォルトは自動ではない。自動ボタンに切り替えたお客さんは
//   AIX以外自動で返信されるようにする（時間は9:00〜21:00の間）。返信時間はランダム（3分〜21分）。
//   長文は10分以上あける。また10分とか分かりやすい時間差はあまり使わない。できれば奇数。
//   AIXで送信する際はスタッフがAIXから送信する。自動ボタンにする際は最終確認をいれる。
//   自動モードにしていないお客さんは絶対に勝手に自動モードにしない」
//   「今セットされる返信を自動返信として送る形」＝ conversations.ai_draft をそのまま送る。
//
// 【安全の考え方】この仕組みは**本物のお客様に自動で送る**ので、迷ったら送らない（fail-closed）。
//   送ってよい条件を全部満たした時だけ true を返し、1つでも欠けたら理由付きで false。
import { jstParts } from "./jst-date";
import { findStaffOnlyFact, findUngroundedAmount } from "./staff-confirm-facts";
import { STAFF_PICKUP_DECL_RE, STAFF_CONFIRM_DECL_RE, STAFF_ESTIMATE_DECL_RE } from "./reply-context";

/** 送ってよい時間帯（JST）。この外では1通も送らない */
export const AUTO_REPLY_WINDOW = { startHour: 9, endHour: 21 } as const;

/**
 * 長文の線。実データ（90日・スタッフ実送信5,923通）で中央値103字・75%が140字・90%が228字。
 * 上位25%にあたる150字以上を「長文」とする（＝読むのに時間がかかる文）。
 */
export const LONG_TEXT_CHARS = 150;

/**
 * 待ち時間の候補（分）。竹内さんの指定:
 *   ・3分〜21分
 *   ・「10分」のような分かりやすい時間差は使わない → 5・10・15・20 を外す
 *   ・できれば奇数 → 全部奇数
 */
export const DELAY_CHOICES: readonly number[] = [3, 7, 9, 11, 13, 17, 19, 21];

/** 長文は10分以上あける（上の候補のうち11分以上） */
export const LONG_DELAY_CHOICES: readonly number[] = [11, 13, 17, 19, 21];

/** 文字数（空白を除く） */
export function visibleLength(text: string | null | undefined): number {
  return (text ?? "").replace(/\s/g, "").length;
}

/** その時刻が送ってよい時間帯か（JST） */
export function isWithinAutoWindow(iso: string): boolean {
  const p = jstParts(iso);
  if (!Number.isFinite(p.y)) return false;
  return p.hour >= AUTO_REPLY_WINDOW.startHour && p.hour < AUTO_REPLY_WINDOW.endHour;
}

/** 文字列から決まった数を作る（同じ会話・同じメッセージなら毎回同じ待ち時間＝cron が何度回っても予約が動かない） */
function seedOf(key: string): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * 待ち時間（分）を選ぶ。長文なら10分以上の候補から。
 * seedKey は「会話ID＋お客様の発言時刻」を渡す（同じ場面なら何度計算しても同じ値）。
 */
export function pickDelayMinutes(text: string | null | undefined, seedKey: string): number {
  const pool = visibleLength(text) >= LONG_TEXT_CHARS ? LONG_DELAY_CHOICES : DELAY_CHOICES;
  return pool[seedOf(seedKey) % pool.length];
}

/** JST の年月日時分から ISO を作る */
function jstIso(y: number, m: number, d: number, hour: number, minute: number): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return new Date(`${y}-${p(m)}-${p(d)}T${p(hour)}:${p(minute)}:00+09:00`).toISOString();
}

/**
 * 実際に送る時刻を決める。
 *   お客様の発言時刻 ＋ 待ち時間。ただしその時刻が 9:00〜21:00 の外なら送らずにずらす:
 *     ・朝9時より前  → その日の 9時台（待ち時間と同じ奇数分）
 *     ・21時以降     → 翌日の 9時台
 *   下書きができるのが遅れて、もう待ち時間を過ぎている時は「今から少しだけ待って」送る。
 */
export function resolveAutoSendAt(o: {
  /** お客様の発言時刻 */
  customerMsgAt: string;
  /** 送る本文（長さで待ち時間が変わる） */
  draft: string;
  /** 今 */
  nowIso: string;
  /** 同じ場面で毎回同じ待ち時間にするための鍵（会話ID など） */
  seedKey: string;
}): { sendAt: string; delayMinutes: number; shifted: "none" | "morning" | "next_morning" } {
  const delay = pickDelayMinutes(o.draft, `${o.seedKey}|${o.customerMsgAt}`);
  const base = Date.parse(o.customerMsgAt);
  const nowMs = Date.parse(o.nowIso);
  // 下書きが遅れた時も「待ち時間より前」には送らない
  let target = Math.max(Number.isFinite(base) ? base + delay * 60_000 : nowMs + delay * 60_000, nowMs);
  let iso = new Date(target).toISOString();
  if (isWithinAutoWindow(iso)) return { sendAt: iso, delayMinutes: delay, shifted: "none" };

  const p = jstParts(iso);
  if (p.hour < AUTO_REPLY_WINDOW.startHour) {
    return { sendAt: jstIso(p.y, p.m, p.d, AUTO_REPLY_WINDOW.startHour, delay), delayMinutes: delay, shifted: "morning" };
  }
  // 21時以降 → 翌日の朝
  const next = new Date(Date.UTC(p.y, p.m - 1, p.d) + 86_400_000);
  return {
    sendAt: jstIso(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), AUTO_REPLY_WINDOW.startHour, delay),
    delayMinutes: delay,
    shifted: "next_morning",
  };
}

/** 自動送信を止める状態（申込以降は人が対応する） */
export const AUTO_REPLY_SKIP_STATUSES: ReadonlySet<string> = new Set([
  "applying", "application", "screening", "approved", "contract", "closed_won", "closed_lost", "lost",
]);

/** 下書きが本文として使えない印（社内用の合図・作りかけ） */
// 2026-09-21 竹内「完全にしまってたら返信しなくて大丈夫」: [返信不要] も本文ではない印
const SENTINEL_RE = /\[AIX誘導中\]|\[返信不要\]|__SHOWN__|<<<|>>>/;

export type AutoReplyInput = {
  /** 会話が「自動」に切り替えられているか（NULL/false は自動ではない） */
  autoSendEnabled: boolean | null | undefined;
  /** 最後の発言者 */
  lastSender: string | null | undefined;
  /** ブレインの返信モード。'aix' なら AIX なのでスタッフが送る */
  replyMode: string | null | undefined;
  /** ブレインが AIX を指しているか（action があれば AIX 待ち） */
  suggestedAixAction: string | null | undefined;
  /** 送る本文（セットされている下書き） */
  draft: string | null | undefined;
  /** 最終チェックで止められているか */
  draftHasBlock: boolean;
  /** 会話のステータス */
  status: string | null | undefined;
  /** 同じ会話に未送信の予約が既にあるか */
  hasPendingScheduled: boolean;
  /** 2026-10-02 ⑫: この会話の直近の通・登録の家賃（金額の根拠）。下書きに会話に無い金額があれば送らない（無ければ判定しない） */
  groundText?: string | null;
  /** 2026-10-02 ⑫ 17巡: ブレインが「2段の場面（約束の返信）」にした時の種類（suggested_aix_meta.two_stage）。無ければ判定しない */
  twoStageKind?: string | null;
};

/** 2段の場面の下書きに約束（ピックアップ・確認・御見積書の宣言）が入っているか。行動台帳が promised と読むのと同じ式（reply-context） */
export function hasTwoStagePromise(draft: string): boolean {
  return STAFF_PICKUP_DECL_RE.test(draft) || STAFF_CONFIRM_DECL_RE.test(draft) || STAFF_ESTIMATE_DECL_RE.test(draft);
}

export type AutoReplyVerdict = { ok: boolean; reason: string };

/**
 * この会話の下書きを自動で送ってよいか。
 * **1つでも欠けたら送らない**（迷ったら人に残す）。理由はログに出して後から追えるようにする。
 */
export function canAutoReply(i: AutoReplyInput): AutoReplyVerdict {
  // ① 切り替えていない会話は絶対に送らない（NULL も false 扱い＝勝手に自動にしない）
  if (i.autoSendEnabled !== true) return { ok: false, reason: "auto_off" };
  // ② お客様の番でなければ送らない
  if (i.lastSender !== "customer") return { ok: false, reason: "not_customer_turn" };
  // ③ AIX が要る場面はスタッフが AIX から送る（竹内さん指定）
  if (i.replyMode === "aix") return { ok: false, reason: "aix_mode" };
  if (i.suggestedAixAction) return { ok: false, reason: "aix_suggested" };
  // ④ 申込以降は人が対応する
  const st = (i.status ?? "").trim();
  if (st && AUTO_REPLY_SKIP_STATUSES.has(st)) return { ok: false, reason: `status:${st}` };
  // ⑤ 送れる本文があるか
  const draft = (i.draft ?? "").trim();
  if (!draft) return { ok: false, reason: "no_draft" };
  if (SENTINEL_RE.test(draft)) return { ok: false, reason: "sentinel_draft" };
  if (visibleLength(draft) < 10) return { ok: false, reason: "draft_too_short" };
  // ⑥ 最終チェックで止められている文は送らない
  if (i.draftHasBlock) return { ok: false, reason: "final_check_block" };
  // ⑥-2 2026-10-02 竹内さんの決定「スタッフの確認が要る物は AIX で止める」: 空き状況・初期費用の金額・待ち合わせの住所・内覧の確定日時を
  //   言い切っている下書きは自動で送らない（スタッフが確かめてから送る）。本文は変えない＝人に残すだけ（staff-confirm-facts.ts）
  const staffFact = findStaffOnlyFact(draft);
  if (staffFact) return { ok: false, reason: `staff_only_fact:${staffFact.kind}` };
  // ⑥-3 2026-10-02 ⑫ 11巡目: 会話に無い金額（相場・家賃帯・物件の金額）の言い切りは自動で送らない（本文は変えない）。
  //   AI の下書き 120日 920件で当たり 26・うちスタッフが金額を変えた/消した 23（scripts/audit-ungrounded-amount.ts）
  const ungrounded = findUngroundedAmount(draft, i.groundText);
  if (ungrounded) return { ok: false, reason: "staff_only_fact:ungrounded_amount" };
  // ⑥-4 2026-10-02 ⑫ 17巡: 2段の場面（今は送れる物が無い→約束の返信）なのに約束が無い下書きは自動で送らない（本文は変えない）。
  //   17巡 flow1_t03: お客様の3つの話（フリーレント・別エリア・URL）に「かしこまりました！！全力でサポート」だけで約束も答えも無いまま送られた。
  //   約束が無いと行動台帳に promised が立たず、後の AIX も立たない（仕事が消える）＝人に残す
  if (i.twoStageKind && !hasTwoStagePromise(draft)) return { ok: false, reason: "two_stage_no_promise" };
  // ⑦ 二重送信を防ぐ
  if (i.hasPendingScheduled) return { ok: false, reason: "already_scheduled" };
  return { ok: true, reason: "ok" };
}
