// app/lib/promise-read.ts — 約束の読みを1つに（純関数・LLM なし・作業員4・2026-11-12）
//
// 統括役（作業員24 の統括の洗い出し #3）: 開いている約束の読みが5か所で別々（conductor-focus.openPromiseAt・conductor-our-side.ourSideBlock/promiseKindOf・
//   writing-blueprint の PROMISE_RE・compose-blueprint の promise の札・promise-timing/due/calendar）で、同じ番で「開いている／いない」が場所で変わりうる。
//   → 約束の読み（種類・文・いつ・果たしたか・誰が）をここに寄せ、各所はここを呼ぶ（PROMISE_READ_UNIFIED=on・既定 off＝今のまま）。
// 土台: promise-tracker.ts（約束の文 promiseSentences・種類 promiseKind・果たした isPromiseKept は全件監査で測った物＝ここで作り直さない）。
//   その上に AIX の記録で果たした事（物件の AIX・確認の結果・見積書）を足す（tracker は文しか見ないので、AIX だけで果たした約束を開いていると読む穴があった）。
// 種類の名前: 作業員19 の promise-deadline-words.ts の PromiseWhenKind（pickup・new_arrival・check_vacancy・check_mgmt・negotiate・estimate）と同じ文字列。
//   期日の言葉を持たない種類（viewing・apply_hold・send_doc・contact・conditional・other）を足した。
// 境界: 作業員7 の番をまたぐ計画とは「読む口（readPromises）を共有する」だけ。並べ方・次の番の割り振りはここでは決めない。
// 期日の読み（「明日一番」「本日中」）は promise-due.ts、言う期日の言葉は promise-deadline-words.ts の役目（ここは種類と開閉だけ）。

import { PROMISE_RE as TRACKER_PROMISE_RE, promiseKind, isPromiseKept, CONDITIONAL_ON_CUSTOMER_RE, THIRD_PARTY_RELAY_RE, WAITING_ON_OTHERS_RE, PROMISE_DEADLINE_RE, type PromiseKind } from "./promise-tracker";

type Env = Record<string, string | undefined>;
export const promiseReadUnifiedOn = (env: Env = typeof process !== "undefined" ? process.env : {}) => (env.PROMISE_READ_UNIFIED ?? "").trim().toLowerCase() === "on";

/** promise-deadline-words.ts の PromiseWhenKind と同じ文字列 */
export type PromiseWhenKind = "pickup" | "new_arrival" | "check_vacancy" | "check_mgmt" | "negotiate" | "estimate";
export type PromiseReadKind = PromiseWhenKind | "viewing" | "apply_hold" | "send_doc" | "contact" | "conditional" | "other";
export const PROMISE_READ_KIND_JA: Record<PromiseReadKind, string> = {
  pickup: "探す（ピックアップ）", new_arrival: "新着が出次第", check_vacancy: "募集状況の確認", check_mgmt: "管理会社への確認", negotiate: "交渉", estimate: "見積書",
  viewing: "内覧のご案内", apply_hold: "申込・押さえる", send_doc: "資料の送付", contact: "ご連絡", conditional: "お客様次第の提案", other: "その他",
};
/** 誰の番か: staff＝こちらが果たす／customer_turn＝お客様が先に動く条件つき／third_party＝管理会社等への連絡だけ */
export type PromiseBy = "staff" | "customer_turn" | "third_party";

export type PromiseRead = {
  kind: PromiseReadKind; trackerKind: PromiseKind; sentence: string; at: string; by: PromiseBy;
  fulfilled: boolean; fulfilledBy: "text" | "aix" | null; fulfilledAt: string | null;
  /** 新着・審査など相手次第の待ち */
  waiting: boolean; hasDeadline: boolean; elapsedH: number;
};

const MGMT_RE = /管理会社|設備|駐車場|駐輪|バイク|鍵|入居(?:日|可能日)|ペット|代理契約|保証会社|楽器|二人入居|同棲|法人|クリーニング/;
export function promiseReadKindOf(s: string, tk: PromiseKind = promiseKind(s)): PromiseReadKind {
  switch (tk) {
    case "物件探し": return /新着|出次第|で次第|随時|日々/.test(s) ? "new_arrival" : "pickup";
    case "確認": return MGMT_RE.test(s) && !/募集状況|空き状況|空室/.test(s) ? "check_mgmt" : "check_vacancy";
    case "交渉": return "negotiate";
    case "見積書": return "estimate";
    case "内覧・ご案内": return "viewing";
    case "申込・押さえる": return "apply_hold";
    case "資料の送付": return "send_doc";
    case "ご連絡": return "contact";
    case "条件つきの提案": return "conditional";
    default: return "other";
  }
}

/** 果たす AIX（種類ごと） */
const FULFIL_AIX: Record<PromiseReadKind, ReadonlySet<string>> = {
  pickup: new Set(["property_send", "property_recommendation"]), new_arrival: new Set(["property_send", "property_recommendation"]), send_doc: new Set(["property_send", "property_recommendation", "property_check_result"]),
  check_vacancy: new Set(["property_check_result", "acknowledge_check", "estimate_sheet"]), check_mgmt: new Set(["property_check_result", "acknowledge_check"]), negotiate: new Set(["property_check_result", "estimate_sheet"]),
  estimate: new Set(["estimate_sheet"]), viewing: new Set(["viewing_invite", "meeting_place"]), apply_hold: new Set(["application_push"]), contact: new Set([]), conditional: new Set([]), other: new Set([]),
};

/** 読む口の入力（conductor-our-side の OurSideMsg・conductor-focus の HistMsg のどちらも入る） */
export type PromiseMsg = { sender: string; text: string | null; created_at: string; is_aix_generated?: boolean | null; aixType?: string | null };
export type PromiseAix = { aix_type: string; created_at: string; sent_at?: string | null };

/** 会話（順不同）から約束を全部読む（古い順）。days 日より前の約束は読まない */
export function readPromises(o: { msgs: ReadonlyArray<PromiseMsg>; aix?: ReadonlyArray<PromiseAix>; nowMs: number; days?: number }): PromiseRead[] {
  const since = o.nowMs - (o.days ?? 14) * 864e5;
  const msgs = [...o.msgs].filter((m) => Date.parse(m.created_at) <= o.nowMs).sort((a, b) => a.created_at.localeCompare(b.created_at));
  const aixEv = [
    ...(o.aix ?? []).map((a) => ({ type: a.aix_type, at: a.sent_at ?? a.created_at })),
    ...msgs.filter((m) => m.aixType).map((m) => ({ type: m.aixType as string, at: m.created_at })),
  ].filter((a) => Date.parse(a.at) <= o.nowMs);
  const out: PromiseRead[] = [];
  msgs.forEach((m, i) => {
    if (m.sender === "customer" || m.is_aix_generated || m.aixType || Date.parse(m.created_at) < since) return;
    for (const s of promiseSentencesUnified(m.text)) {
      const tk = promiseKind(s);
      const kind = promiseReadKindOf(s, tk);
      const by: PromiseBy = CONDITIONAL_ON_CUSTOMER_RE.test(s) ? "customer_turn" : (tk === "ご連絡" || tk === "確認") && THIRD_PARTY_RELAY_RE.test(s) && !/次第|結果/.test(s) ? "third_party" : "staff";
      const laterStaff = msgs.slice(i + 1).filter((x) => x.sender !== "customer");
      const textDone = isPromiseKept(tk, s, laterStaff.map((x) => x.text ?? ""));
      const aixDone = aixEv.filter((a) => a.at > m.created_at && FULFIL_AIX[kind].has(a.type)).sort((a, b) => a.at.localeCompare(b.at))[0] ?? null;
      const contactDone = kind === "contact" && laterStaff.length > 0 ? laterStaff[0].created_at : null;
      const textAt = textDone ? (laterStaff.find((x) => isPromiseKept(tk, s, [x.text ?? ""]))?.created_at ?? laterStaff[laterStaff.length - 1]?.created_at ?? null) : null;
      const fulfilledAt = [textAt, aixDone?.at ?? null, contactDone].filter((x): x is string => !!x).sort()[0] ?? null;
      out.push({
        kind, trackerKind: tk, sentence: s.replace(/\s+/g, " ").trim().slice(0, 80), at: m.created_at, by,
        fulfilled: !!fulfilledAt, fulfilledBy: fulfilledAt ? (aixDone && aixDone.at === fulfilledAt ? "aix" : "text") : null, fulfilledAt,
        waiting: WAITING_ON_OTHERS_RE.test(s), hasDeadline: PROMISE_DEADLINE_RE.test(s), elapsedH: (o.nowMs - Date.parse(m.created_at)) / 36e5,
      });
    }
  });
  return out;
}

/** 追いかける種類（promise-tracker の TRACKED_KINDS と同じ範囲）。内覧のご案内・申込・お客様次第の提案は「お客様の返事待ち」なので開いている約束にしない */
const TRACKED: ReadonlySet<PromiseReadKind> = new Set(["pickup", "new_arrival", "check_vacancy", "check_mgmt", "negotiate", "estimate", "send_doc", "contact"]);
/** 開いている約束（こちらが果たす番・まだ果たしていない）。同じ種類は新しい方だけ */
export function openPromises(o: Parameters<typeof readPromises>[0]): PromiseRead[] {
  const latest = new Map<PromiseReadKind, PromiseRead>();
  for (const p of readPromises(o)) if (p.by === "staff" && !p.fulfilled && TRACKED.has(p.kind)) latest.set(p.kind, p);
  return [...latest.values()].sort((a, b) => a.at.localeCompare(b.at));
}
/** 一番新しい開いている約束（無ければ null） */
export function lastOpenPromise(o: Parameters<typeof readPromises>[0]): PromiseRead | null {
  const xs = openPromises(o);
  return xs[xs.length - 1] ?? null;
}
/**
 * 約束の文（promise-tracker の PROMISE_RE を土台に、竹内さんの198通で旧の5つの網と食い違った所を直した）:
 *   ・「確認出来次第ご連絡させて頂きますので、何卒よろしくお願い致します」＝約束（tracker は「お願い」を含む文を全部外していた）→ 締めのお願いは外さない・「の程」だけ外す
 *   ・「ピックアップさせて頂き、明日中にピックアップしましたお部屋お送りさせて頂きます」＝約束（tracker は文の中の「しました」で外していた）→ 文の終わりが過去の時だけ外す
 *   ・「募集に出次第おおくりさせていただきます」（打ち間違い）・「次第ご連絡／お送り」＝約束
 *   ・「費用を出来る限り抑えさせて頂きます」は会社のやり方（追う約束ではない）→ 外す
 */
const EXTRA_PROMISE_RE = /次第(?:ご連絡|お送り|おおくり|お伝え|ご報告)|(?:お送り|おおくり)させて(?:頂|いただ)きます/;
const PAST_END_RE = /(?:致しました|いたしました|させて(?:頂|いただ)きました|しました)[^一-龠ぁ-んァ-ヶA-Za-z0-9]*$/;
export function promiseSentencesUnified(text: string | null | undefined): string[] {
  return (text ?? "").split(/\n|(?<=[！!。])/).map((x) => x.trim()).filter((x) => x.length > 0
    && (TRACKER_PROMISE_RE.test(x) || EXTRA_PROMISE_RE.test(x))
    && !PAST_END_RE.test(x)
    && !/の程/.test(x)
    && !(/お願い(?:致|いた)?します|お願いします/.test(x) && !/(?:ので|ため)、?\s*(?:何卒)?(?:よろしく|宜しく)お願い/.test(x))
    && !/費用[^。！!]{0,20}抑えさせて/.test(x));
}
/** 1文が約束か（書き手の設計図・文の札・約束の読みが使う同じ判定） */
export function isPromiseSentence(s: string): boolean {
  return promiseSentencesUnified(s).length > 0;
}
