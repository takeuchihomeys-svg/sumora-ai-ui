// app/lib/reapply-customer.ts
// 「申込歴あり（再探し）」のお客様と、申込から戻った理由（3パターン）を決める純関数（DB・LLM なし）。読み手は reapply-customer-server.ts。
//
// 2026-10-21 竹内さんの決定:
//   70193195「一度申込になってから審査否決やキャンセルとなって物件探しなおしたお客さんは…メモ書きのところかなにかに表記した方がよい。
//     一度申し込んだことがあり、申込情報もおくってくれてるのでかなりアツいお客さんなので決定率も高い」
//   c2909936「審査落ちた場合と1番手のお客さんが審査通過した場合や やっぱり別の物件で切り替えるという主に３パターンが申込からこのツールに戻ってくる…その状況ちゃんとメモしておく」
//
// 【申込歴あり（再探し）】申込の記録（AIX【申込へ】押下・本人確認書類／収入証明書・記入済みの申込フォーム・スタッフの印 is_post_apply）があり、
//   最後の申込の記録より後に段階を戻した（status_manual_back_at／deepseek_cutoff_at）・今は申込以降ではない会話。
//   deepseek_cutoff_at はトリガー（stamp_deepseek_cutoff）が「申込以降→申込前」に移した時だけ書く消えない列なので、それだけでも申込歴ありに数える
//   （その後また申込へ進めた会話は申込以降の判定で外れる）。
// 【戻った理由】戻した時刻の前後の会話（決まった言い方）と、申込状況のピッカー（AIX【物件確認した】申込状況について）の記録から:
//   ① 審査否決 ② 番手で1番手が審査通過（お部屋が取れなかった） ③ お客様が別の物件に切り替え ／ 読めなければ「理由不明」（スタッフが画面で選ぶ）。
//   スタッフが選んだ物が最優先（お客様のメモ customer_memos の1行・id=REAPPLY_MEMO_ID）。
// 戻す: REAPPLY_MARK=off（表記・材料・優先度をまとめて止める）

import { DRAFT_SKIP_STATUSES } from "./conversation-status";
import { resolvePostApply, badgeMovedBackCore, type PostApplyFacts } from "./post-apply";

export type ReturnPattern = "screening_denied" | "lost_to_first" | "switched" | "unknown";
export const RETURN_PATTERNS: readonly ReturnPattern[] = ["screening_denied", "lost_to_first", "switched", "unknown"];
export const RETURN_PATTERN_LABEL: Record<ReturnPattern, string> = {
  screening_denied: "①審査否決",
  lost_to_first: "②番手で1番手が審査通過（お部屋が取れなかった）",
  switched: "③別の物件に切り替え",
  unknown: "理由不明",
};
/** 画面の小さな札に出す短い形 */
export const RETURN_PATTERN_SHORT: Record<ReturnPattern, string> = {
  screening_denied: "①審査否決", lost_to_first: "②1番手が通過", switched: "③別の物件に切替", unknown: "理由不明",
};
/** パターンごとの次の一手（ブレインの材料・c2909936） */
export const RETURN_PATTERN_NEXT_MOVE: Record<ReturnPattern, string> = {
  screening_denied: "審査が通りやすい物件（保証会社の審査が柔らかい・初期費用や家賃の幅に余裕がある物）と、保証会社の選び方・連帯保証人の立て方を合わせて出す",
  lost_to_first: "同じ条件で似た物件をすぐ出す（お部屋を取られた直後は気持ちが冷めないうちに・申込までの段取りは一度通っている）",
  switched: "切り替えた先の物件の申込を進める（申込に要る物はフォーマットと本人確認書類の2つ・前回の申込の流れを踏まえて手早く）",
  unknown: "戻った理由を確かめる前提で、前回の申込で分かっている条件に合う物件を早めに出す（理由は推測で書かない）",
};
/** スタッフが選んだ理由を置くメモの行の id（customer_memos.items・手で付けた行＝locked） */
export const REAPPLY_MEMO_ID = "reapply-pattern";
const MEMO_PREFIX = "申込から戻った理由：";

export function reapplyMarkEnabled(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.REAPPLY_MARK ?? "").trim().toLowerCase() !== "off";
}

const ms = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};

export type ReapplyState = {
  reapply: boolean;
  /** 戻した時刻（ISO・申込歴ありの時だけ） */
  returnedAt: string | null;
  /** 最後の申込の記録（押下・書類・フォーム。無ければ null＝印か審査管理の同期の status だけ） */
  lastApplyAt: string | null;
};
const NOT: ReapplyState = { reapply: false, returnedAt: null, lastApplyAt: null };

/** 申込歴あり（再探し）か（純関数） */
export function resolveReapply(f: PostApplyFacts): ReapplyState {
  if (DRAFT_SKIP_STATUSES.has((f.status ?? "").trim())) return NOT;
  const pa = resolvePostApply(f);
  // 今も申込以降（印だけ残って戻した会話は戻した側）
  if (pa.postApply && !badgeMovedBackCore(f)) return NOT;
  const recs = [ms(f.applicationPushAt), ms(f.idDocumentAt), ms(f.applicationFormAt)].filter((x): x is number => x !== null);
  const latest = recs.length ? Math.max(...recs) : null;
  const back = ms(f.statusManualBackAt), cut = ms(f.deepseekCutoffAt);
  const backs = [back, cut].filter((x): x is number => x !== null);
  if (!backs.length) return NOT;
  const backAt = Math.max(...backs);
  const iso = (n: number | null) => (n === null ? null : new Date(n).toISOString());
  if (latest !== null) return backAt > latest ? { reapply: true, returnedAt: iso(backAt), lastApplyAt: iso(latest) } : NOT;
  // 押下・書類・フォームの記録が無い: 消えない列（申込以降→申込前の切り替え）か、印が残ったまま戻した時だけ
  if (cut !== null) return { reapply: true, returnedAt: iso(cut), lastApplyAt: null };
  if (f.isPostApply === true && back !== null) return { reapply: true, returnedAt: iso(back), lastApplyAt: null };
  return NOT;
}

// ─── 戻った理由（決まった言い方） ─────────────────────────────────────────
export type PatternMsg = { sender: string; text: string | null | undefined; createdAt: string };
export type PatternPicker = { checkPattern: string | null; choices?: unknown; createdAt: string };

/** 仮定・心配・質問の文（「否決になった場合」「落ちたらどうしよう」）は理由の根拠にしない */
// 2026-10-21 確かめ役: 文の終わりの「〜落ちたら」（実データ 749c5559「こっちの審査落ちたら」）も仮定
const CONDITIONAL_RE = /場合|もし|なら(?:ば)?[、,\s]|たら(?:[、,\s？?]|$)|かもしれ|可能性|心配|不安|大丈夫|でしょうか|ですか[？?]?$|ますか/;
const DENIED_RE = /否決|審査(?:が|に|は|の結果)?.{0,4}(?:通らな|通りませ|通過できませ|落ち|ダメ|だめ|NG|不可|お断り|難しい結果|見送)|保証会社.{0,10}(?:通らな|通りませ|落ち|否決|お断り|NG|ダメ)|審査(?:結果)?.{0,6}残念な(?:結果|ご報告)/;
const LOST_RE = /[1１一]番手.{0,25}(?:審査(?:が|に)?.{0,4}(?:通|通過|承認|OK|ok)|決ま|契約|成約)|先(?:に|行)(?:の)?(?:お)?申込.{0,25}(?:通|決ま|審査通過|成約)|他の(?:方|お客様|申込).{0,15}(?:決ま|審査(?:が)?通|契約|成約)|(?:お部屋|物件|そちら|こちら)(?:が|は).{0,8}(?:埋まって|決まって|成約|他(?:の方)?で決ま)|繰り上が(?:りませ|らな|りが無|り無|りなし|れませ)/;
/** 否決の後の言い方（問いの形「なんで落ちたか分かりますか」でも否決の事実）＝仮定の網を当てない */
const DENIED_STRONG_RE = /(?:なんで|なぜ|どうして)(?:審査|保証会社)?(?:に|が|は)?落ち|落ちた(?:理由|原因)|(?:審査|保証会社)(?:に|が|は)?落ちてしま|(?:審査|保証会社)(?:に|は)?落ちました|否決(?:となり|になり|でした|となってしまい|になってしまい|の(?:ご)?連絡|との(?:ご)?連絡)/;
/** 番手で申込んだ（2番手で申込・抑えた／1番手の申込が入っている）＝戻す前の文だけ。保証会社の並び（「1番手:〇〇保証」）は当てない */
// 2026-10-21 確かめ役: 「2番手でのお申込みが可能」（案内しただけ・実データ fecda03f）は申込んだ事にしない
const BANTE_APPLIED_RE = /[2２二]番手(?:で|での|として)?(?:の)?(?:お)?(?:申(?:し)?込|抑え)(?![^。！!？?\n]{0,8}可能)|[1１一]番手(?:で|の)(?:お)?申(?:し)?込(?:み)?(?:が)?(?:入|はい)/;
const SWITCH_RE =/(?:やっぱり|やはり).{0,20}(?:別|他|違う|キャンセル|辞退|やめ|止め|取り下げ|取り消)|別の(?:お部屋|物件|部屋|ところ|所).{0,15}(?:に|で)?(?:したい|決め|申込|切り替|進め|お願い)|(?:申込|お申込|申し込み)?(?:の)?(?:キャンセル|辞退|取り下げ|取り消し)(?:したい|させて|でお願い|します|お願い|で)|切り替え(?:たい|ます|させて|でお願い)|見送(?:らせ|りたい|ります)/;

function sentencesOf(text: string): string[] {
  return text.split(/[\n。！!？?]+/).map((s) => s.trim()).filter(Boolean);
}
function hit(text: string | null | undefined, re: RegExp): boolean {
  return sentencesOf(String(text ?? "")).some((s) => re.test(s) && !CONDITIONAL_RE.test(s));
}

/** 申込状況のピッカーで「ほかの方の申込あり」を選んだ記録か（選択の形が分からない時は「なし」だけの記録を外す） */
export function pickerSaysOtherApplication(p: PatternPicker): boolean {
  if (p.checkPattern !== "mgmt_application_status") return false;
  const s = JSON.stringify(p.choices ?? null);
  if (/なし/.test(s) && !/あり/.test(s)) return false;
  return true;
}

export type PatternDetect = { pattern: ReturnPattern; evidence: "message" | "picker" | null; at: string | null };

/** 戻った理由を決める窓（戻した時刻の前30日・後3日）。③（お客様の切り替え）は戻す前（＋1時間）だけ＝戻した後の物件探しの言葉で誤らない */
export const PATTERN_WINDOW_BEFORE_MS = 30 * 86_400_000;
export const PATTERN_WINDOW_AFTER_MS = 3 * 86_400_000;
const SWITCH_AFTER_MS = 3600_000;

/**
 * 戻った理由（純関数）。並びは ①否決 ＞ ②1番手が通過 ＞ ③切り替え（否決や番手の話がある時、お客様の「別の物件で」はその結果の言葉）。
 *   ②はピッカーの記録（申込状況について・ほかの方の申込あり）だけでも数える（文の根拠が無い時）。
 */
export function detectReturnPattern(msgs: ReadonlyArray<PatternMsg>, returnedAt: string | null, pickers: ReadonlyArray<PatternPicker> = [], lastApplyAt: string | null = null): PatternDetect {
  const back = ms(returnedAt);
  if (back === null) return { pattern: "unknown", evidence: null, at: null };
  const from = Math.min(back - PATTERN_WINDOW_BEFORE_MS, ms(lastApplyAt) ?? Infinity), to = back + PATTERN_WINDOW_AFTER_MS;
  const inWin = msgs.filter((m) => { const t = ms(m.createdAt); return t !== null && t >= from && t <= to; });
  const latestHit = (re: RegExp, pred: (m: PatternMsg) => boolean = () => true): string | null => {
    let at: string | null = null;
    for (const m of inWin) if (pred(m) && hit(m.text, re) && (at === null || Date.parse(m.createdAt) > Date.parse(at))) at = m.createdAt;
    return at;
  };
  const strong = (re: RegExp, pred: (m: PatternMsg) => boolean = () => true): string | null => {
    let at: string | null = null;
    for (const m of inWin) if (pred(m) && sentencesOf(String(m.text ?? "")).some((s) => re.test(s)) && (at === null || Date.parse(m.createdAt) > Date.parse(at))) at = m.createdAt;
    return at;
  };
  const denied = latestHit(DENIED_RE) ?? strong(DENIED_STRONG_RE);
  if (denied) return { pattern: "screening_denied", evidence: "message", at: denied };
  const beforeBack = (m: PatternMsg) => Date.parse(m.createdAt) <= back + SWITCH_AFTER_MS;
  const lost = latestHit(LOST_RE) ?? latestHit(BANTE_APPLIED_RE, beforeBack);
  if (lost) return { pattern: "lost_to_first", evidence: "message", at: lost };
  const sw = latestHit(SWITCH_RE, (m) => m.sender === "customer" && Date.parse(m.createdAt) <= back + SWITCH_AFTER_MS);
  if (sw) return { pattern: "switched", evidence: "message", at: sw };
  const pk = pickers.filter((p) => { const t = ms(p.createdAt); return t !== null && t >= from && t <= back && pickerSaysOtherApplication(p); })
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
  if (pk) return { pattern: "lost_to_first", evidence: "picker", at: pk.createdAt };
  return { pattern: "unknown", evidence: null, at: null };
}

// ─── スタッフが選んだ理由（メモの1行） ───────────────────────────────────────
export function reapplyMemoText(p: ReturnPattern): string {
  return `${MEMO_PREFIX}${RETURN_PATTERN_LABEL[p]}`;
}
/** メモの行からスタッフが選んだ理由を読む（外した行・読めない行は null） */
export function staffPatternOf(items: ReadonlyArray<{ id?: string; text?: string; retiredAt?: string | null }> | null | undefined): ReturnPattern | null {
  const it = (items ?? []).find((x) => x.id === REAPPLY_MEMO_ID && !x.retiredAt);
  if (!it?.text) return null;
  const label = it.text.startsWith(MEMO_PREFIX) ? it.text.slice(MEMO_PREFIX.length) : it.text;
  return RETURN_PATTERNS.find((p) => RETURN_PATTERN_LABEL[p] === label) ?? null;
}

export type ReapplyInfo = {
  reapply: true;
  returnedAt: string | null;
  pattern: ReturnPattern;
  /** staff＝スタッフが選んだ／auto＝会話・ピッカーから読んだ／none＝読めない（理由不明） */
  source: "staff" | "auto" | "none";
};

/**
 * 申込歴ありの印の文字（2026-10-21 竹内さんの決定 414dc9d4「【申込歴あり】とつける形とする」）。
 *   札・やることリストの見出し・ターゲット・ブレインの材料で同じ文字を使う（旧「🔥申込歴あり（再探し）」「申込歴あり（再探し）・」）
 */
export const REAPPLY_MARK_TEXT = "【申込歴あり】";
/** 画面の札の文（「【申込歴あり】①審査否決」） */
export function reapplyBadgeText(i: Pick<ReapplyInfo, "pattern">): string {
  return `${REAPPLY_MARK_TEXT}${RETURN_PATTERN_SHORT[i.pattern]}`;
}

/**
 * ブレインの材料（毎回変わる並びに足す1ブロック）。申込中の個人情報・審査の事情の中身は書かない（パターンの名前と次の一手だけ）。
 */
export function buildReapplyBrainNote(i: ReapplyInfo, nowMs: number = Date.now()): string {
  const back = ms(i.returnedAt);
  const days = back === null ? null : Math.max(0, Math.floor((nowMs - back) / 86_400_000));
  return [
    `${REAPPLY_MARK_TEXT}このお客様は一度申込まで進み、申込から物件探しに戻っている（再探し・申込情報も送ってくれた＝決定率が高いアツいお客様・優先して動く）`,
    `・戻った理由: ${RETURN_PATTERN_LABEL[i.pattern]}${i.source === "staff" ? "（スタッフが選んだ）" : i.source === "auto" ? "（会話の記録から）" : "（会話から読めない・推測で書かない）"}${days !== null ? `・戻って${days}日` : ""}`,
    `・次の一手: ${RETURN_PATTERN_NEXT_MOVE[i.pattern]}`,
    "・前回の申込の中身（氏名・生年月日・勤務先・年収・書類・審査の事情）には触れない。申込の手順は一度通っているので短く案内してよい",
  ].join("\n");
}
