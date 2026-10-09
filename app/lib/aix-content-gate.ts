// app/lib/aix-content-gate.ts — 返信の下書きの文が「どれかの AIX が送るべき中身」を言い切っているか（純関数・LLM なし）
//
// 2026-10-08 竹内さん「これ（作り事・的外れ）、AIX の事が分かっていたら止められるのでは？」
//   物差し = aix-catalog.ts の全ボタン×ピッカーの staffOnly（スタッフだけが知る情報）。
//   今ある関所（staff-confirm-facts.findStaffOnlyFact・STAFF_RESULT_RES・validate-reply の AIX_BOUNDARY_*）は「自動で送らない」だけで、
//   どの AIX の中身か（ボタン×ピッカー）を返さず、下書きにも画面にも出ていなかった。→ ここで1本にし、当たった文に catalogKey を付ける。
// 使い方:
//   入口（turn-contract を作る時）: 依頼の topic×会話の状態から「答えるのに staffOnly が要る」項目は route=aix・aixKey を付ける（aixKeyForAsk）
//   出口（下書きの後）: 文ごとに classifyAixContent → 当たった文は落とし、約束の一文（PROMISE_BY_KEY）に置き換え、AIX の提案（catalogKey）を出す
//     ⚠ 出口の書き換えは「誤削除0の線」が監査で確かめられた型だけ（OUTLET_REWRITE_KINDS）。それ以外の型は記録と自動送信の停止だけ（今の関所と同じ）。
// 根拠の照合（ground）: 文の固有の値（金額・日付・会社名・号室）が、会話（お客様・こちらの送信・AIX の送信）・資料・会社の事実に既にあれば「引用」＝当てない
//   （AIX で送った結果を後の返信で引くのは正しい＝竹内さんの手打ちに多い）。
// 戻す: AIX_CONTENT_GATE=off（全部）／AIX_CONTENT_GATE_REWRITE=off（出口の書き換えだけ止めて記録のみ）

import { findStaffOnlyFact, type StaffOnlyFactHit } from "./staff-confirm-facts";

export type AixContentKind =
  | StaffOnlyFactHit["kind"]           // vacancy / estimate_amount / meeting_address / viewing_fixed / phone_call_promise / mgmt_answer / negotiation_result / photo_done / movein_date
  | "discount_amount" | "free_rent_claim" | "screening_result" | "guarantor_named" | "refund_amount" | "search_result_none";

/** 型 → aix-catalog の鍵（ボタン/ピッカー） */
export const CATALOG_KEY_BY_KIND: Record<AixContentKind, string> = {
  vacancy: "property_check_result/available",         // 募集終了の言い切りは unavailable（下で分ける）
  estimate_amount: "estimate_sheet",
  meeting_address: "meeting_place",
  viewing_fixed: "meeting_place",
  phone_call_promise: "phone_call",
  mgmt_answer: "property_check_result/mgmt_availability",
  negotiation_result: "property_check_result/mgmt_initial_cost",
  photo_done: "property_check_result/interior_photo",
  movein_date: "property_check_result/mgmt_move_in",
  discount_amount: "estimate_sheet",
  free_rent_claim: "property_check_result/mgmt_initial_cost",
  screening_result: "property_check_result/mgmt_guarantor",
  guarantor_named: "guarantor_info",
  refund_amount: "cost_explain",
  search_result_none: "zenryoku_support",
};

/** 書き換えた時に残す約束の一文（実送信の形。対象は文から取らない＝作らない） */
export const PROMISE_BY_KEY: Record<string, string> = {
  "property_check_result/available": "募集状況確認させて頂きます！！確認出来次第ご連絡させて頂きます！！",
  "property_check_result/unavailable": "募集状況確認させて頂きます！！確認出来次第ご連絡させて頂きます！！",
  estimate_sheet: "最大限割引させて頂いた初期費用の御見積書を作成しお送りさせて頂きます！！",
  meeting_place: "",                                   // 日時の確定は AIX【待ち合わせ場所】で送る＝本文は受けだけ
  phone_call: "",
  "property_check_result/mgmt_availability": "確認させて頂きます！！確認出来次第ご連絡させて頂きます！！",
  "property_check_result/mgmt_initial_cost": "管理会社に確認させて頂きます！！確認出来次第ご連絡させて頂きます！！",
  "property_check_result/interior_photo": "室内のお写真確認出来次第お送りさせて頂きます！！",
  "property_check_result/mgmt_move_in": "ご入居可能日確認させて頂きます！！確認出来次第ご連絡させて頂きます！！",
  "property_check_result/mgmt_guarantor": "確認させて頂きます！！確認出来次第ご連絡させて頂きます！！",
  guarantor_info: "保証会社確認させて頂きます！！確認出来次第ご連絡させて頂きます！！",
  cost_explain: "",
  zenryoku_support: "",
};

const SENT_SPLIT = /(?<=[。！!？?])|\n/;
const COND_RE = /(?:れ|け)ば|場合|かどうか|でしょうか|ですか|ますか|ご希望|確認(?:させて|して|致し|いたし|出来次第|でき次第)|次第/;
const COND_RE_NO_WISH = /(?:れ|け)ば|場合|かどうか|でしょうか|ですか|ますか|確認(?:させて|して|致し|いたし|出来次第|でき次第)|次第/;
/** 誤検知の線（10/08 監査: 竹内さんの手打ち 120日 1,785通の当たりを全部読んだ）
 *  ①ポータル・一般の説明（「SUUMOやHOMESに載っているお部屋は既に募集終了しているものが…」「オトリ物件や募集終了しているお部屋が…可能性」）
 *  ②内覧の枠の空き（「12日13:00〜15:00現在空いております」＝カレンダー＝内覧日調整の中身）
 *  ③資料の募集条件の列挙（「・家賃85,000円・管理費8,000円（合計93,000円）」）
 *  ④会社の事実（スモ割最大適用【2,980円＋前家賃】・会社の所在地 〒541-0048 瓦町3-4-10） */
const FP_RE = /SUUMO|HOME'?S|ポータル|オトリ|掲載|(?:可能性|ケース)が?(?:高い|多い|あります)|ものや/i;
const SLOT_RE = /[0-9]{1,2}[:時][0-9]{0,2}\s*[〜~～\-－]\s*[0-9]{1,2}[:時]/;
// 10/08 2回目の監査で足した: 「- 家賃：100,000円・管理費：10,000円（合計110,000円）」「合計98,500円の2LDK」（資料の募集条件）
const LISTING_RE = /^[・◎🌟\-－]?\s*家賃[:：]?\s*[0-9,]+円|管理費[:：]?\s*[0-9,]+円[^。\n]{0,4}[（(]合計|合計[0-9,]+円の[0-9]?(?:LDK|DK|K|R)/u;
// 日付の一般の説明・お客様の希望日（「8月1日入居でしたら日割り家賃も発生せず」「8月1日にご入居頂けるよう全力でサポート」）
const MOVEIN_GENERAL_RE = /でしたら|日割|頂けるよう|いただけるよう|ご希望|に合わせ/;
const COMPANY_RE = /2,?980円|瓦町3-4-10|〒541-0048/;
const EXTRA: Array<{ kind: AixContentKind; re: RegExp }> = [
  { kind: "discount_amount", re: /[0-9０-９][0-9０-９,，]{2,}\s*円(?:の)?(?:割引|お値引き|お安く|還元)/ },
  { kind: "refund_amount", re: /(?:報酬|広告料|AD)[^。\n]{0,20}[0-9０-９][0-9０-９,，]{2,}\s*円/ },
  { kind: "free_rent_claim", re: /(?:[0-9０-９]{1,2}月分|[0-9０-９]ヶ月分?)[^。\n]{0,8}フリーレント|フリーレント(?:が|も)?(?:付き|付いて|ござい|あり)(?:ます|ました|となります)/ },
  { kind: "screening_result", re: /審査(?:が|は|も)?(?:無事)?(?:通過(?:しました|致しました|いたしました|となりました)|承認(?:されました|となりました)|否決|通りませんでした|落ちて)/ },
  { kind: "search_result_none", re: /(?:ご希望|ご条件)[^。\n]{0,20}(?:お部屋|物件)(?:が|は)?(?:現在)?(?:ございません|ありません|見つかりませんでした|出ておりません)/ },
];

/** 文の固有の値（金額・日付・時刻・号室）を抜く */
function keyValues(s: string): string[] {
  const t = s.normalize("NFKC");
  return [...t.matchAll(/[0-9][0-9,]{2,}\s*円|[0-9]{1,2}\s*[\/月]\s*[0-9]{1,2}日?|[0-9]{1,2}[:時][0-9]{0,2}|[0-9]{2,4}号室/g)].map((m) => m[0].replace(/\s/g, ""));
}

export type AixContentHit = { kind: AixContentKind; catalogKey: string; sentence: string; grounded: boolean };

export function aixContentGateEnabled(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.AIX_CONTENT_GATE ?? "").trim().toLowerCase() !== "off";
}

/** 下書きの文ごとに、AIX の中身の言い切りを探す。groundText＝会話（全員の送信）＋資料＋会社の事実 */
export function classifyAixContent(draft: string, groundText: string): AixContentHit[] {
  const out: AixContentHit[] = [];
  const g = (groundText ?? "").normalize("NFKC").replace(/\s/g, "");
  for (const s of String(draft ?? "").split(SENT_SPLIT).map((x) => x.trim()).filter(Boolean)) {
    let kind: AixContentKind | null = null;
    const base = findStaffOnlyFact(s);
    if (base) kind = base.kind;
    // 「ご希望のご条件のお部屋は…ございません」は「ご希望」を含むので、探した結果の型だけ条件・質問の形の除外を「ご希望」抜きで見る
    else for (const e of EXTRA) if (e.re.test(s) && !(e.kind === "search_result_none" ? COND_RE_NO_WISH : COND_RE).test(s)) { kind = e.kind; break; }
    if (!kind) continue;
    const n = s.normalize("NFKC").trim();
    if (FP_RE.test(n) || LISTING_RE.test(n) || COMPANY_RE.test(n)) continue;
    if (kind === "movein_date" && MOVEIN_GENERAL_RE.test(n)) continue;
    if (kind === "vacancy" && SLOT_RE.test(n)) { out.push({ kind: "viewing_fixed", catalogKey: "viewing_invite", sentence: s, grounded: false }); continue; }
    let key = CATALOG_KEY_BY_KIND[kind];
    if (kind === "vacancy" && /終了|埋ま|申込(?:が|み)?入っ|満室/.test(s)) key = "property_check_result/unavailable";
    const vals = keyValues(s);
    const grounded = vals.length > 0 && vals.every((v) => g.includes(v));
    out.push({ kind, catalogKey: key, sentence: s, grounded });
  }
  return out;
}

/** 出口で書き換えてよい型（監査で誤削除0を確かめた物だけ足す。最初は空＝記録と自動送信の停止だけ） */
export const OUTLET_REWRITE_KINDS: ReadonlySet<AixContentKind> = new Set<AixContentKind>([]);
// 監査（2026-10-08・LLM なし・scripts/audit-aix-content-gate.ts）:
//   竹内さんの手打ち（AIX でない 120日 1,785通）で当たり 124通＝ほぼ全部が本当にスタッフだけが知る事を手で打った物（人は知っているので手で書く・AI は AIX の番）。
//   AI の返信の下書き（120日・aix_action/template なし）で引用でない当たり 121文: スタッフも同じ型を送った 85／消した 36
//   → AI の言い切りの 7割はスタッフも同じ事を送っていた（会話・資料・前の AIX から引ける）＝出口で本文を消すと誤削除が多い。
//   なので出口は「自動送信を止める＋記録＋AIX の提案（catalogKey）」だけ。書き換え（OUTLET_REWRITE_KINDS）は資料を ground に入れて数え直し、誤削除0の型だけ足す。
/** 引用でない最初の当たり（自動送信の関所・記録用）。無ければ null */
export function firstUngroundedAixContent(draft: string, groundText: string, env?: Record<string, string | undefined>): AixContentHit | null {
  if (!aixContentGateEnabled(env)) return null;
  return classifyAixContent(draft, groundText).find((h) => !h.grounded) ?? null;
}
