// app/lib/next-move-types.ts — 次の一手の語彙を1か所にまとめる表（行き先×強さ×時機・純関数・定数だけ・作業員16・2026-11-12）
//
// 竹内さん 11/12 了承「次の一手の細分化」・KB P1 d030d496（親 P0 575a7cd5）・f64e0f5d（目的・中期・先読み）。台帳 brain:next-move-vocab-split（作業員18 の洗い出し）。
// なぜ1か所に: 次の一手の語彙が4か所に別々にある（意味の境目も少しずつ違う）:
//   ① compose-blueprint.ts COMPOSE_NEXT 7種（reply/viewing/apply/send_property/wait_check/answer_only/none）＝文の統括の意図
//   ② compose-sentence-plan.ts LEAD_TOS 7種 と ③ takeuchi-anatomy-roles.ts LEAD_TO 7種（viewing/apply/estimate/ask_send/keep/answer_only/none）＝竹内さんの7つの欄・設計図
//   ④ turn-read.ts LEAD_KINDS 8種（内覧/申込・抑える/見積/物件を送ってもらう/条件を聞く/新着の約束/確認の約束/関係をつなぐ）＝一通の読み
//   同じ「send_property」が①では「物件を送ってもらう」、②③の「keep」は「こちらが新着を送る約束」で、④では「新着の約束」と「関係をつなぐ」に割れている。
//   → 行き先は NEXT_DEST の1つの表にし、古い語彙は toNextDest で読み替える（古いファイルは今は触らない・移す時は各ファイルが NEXT_DEST から作る）。
// 名前は judge-basis-types.ts（作業員17）と揃える: 優先の next_step / hold_property はこの表の行き先 viewing・apply・estimate の上の名前（PRIORITY_OF_DEST）。
// 置き場所の決まり: 次の一手は道（返信か AIX か）が決まった後だけに使う（道の前に置かない・q406・q057・q065 の教訓）。

import type { Priority } from "./judge-basis-types";

/** 行き先（細分の1つの表） */
export const NEXT_DEST = [
  "viewing",       // 内覧へ（候補日・都合を聞く・日時を出す）
  "apply",         // 申込・抑える
  "estimate",      // 御見積書を作る・送る
  "ask_send",      // お客様に物件・条件・都合を送ってもらう
  "ask_condition", // 条件を聞く（ヒアリング）
  "keep_send",     // こちらがピックアップ・新着を送る約束
  "wait_check",    // こちらの確認の結果を待ってもらう
  "answer_only",   // 答えて終わり
  "door",          // 扉だけ（ご検討を・お気軽に・いつでも）＝関係をつなぐ
  "none",
] as const;
export type NextDest = typeof NEXT_DEST[number];
export const NEXT_DEST_LABEL: Record<NextDest, string> = {
  viewing: "内覧", apply: "申込・抑える", estimate: "見積", ask_send: "物件・条件を送ってもらう", ask_condition: "条件を聞く",
  keep_send: "こちらが物件を送る約束", wait_check: "確認の結果を待ってもらう", answer_only: "答えて終わり", door: "扉だけ（関係をつなぐ）", none: "無し",
};

/** 強さ（竹内さんの言い方の段） */
export const NEXT_STRENGTH = ["strong", "invite", "together", "door", "none"] as const;
export type NextStrength = typeof NEXT_STRENGTH[number];
export const NEXT_STRENGTH_LABEL: Record<NextStrength, string> = {
  strong: "強く押す（抑えましょう・キャンセル料の線まで）", invite: "案内する（ご都合よろしいお日にち・如何でしょうか）",
  together: "併せて案内（こちらのお部屋も併せて〇曜日）", door: "扉を開けるだけ（お気に召されましたら・お気軽に）", none: "押さない",
};
/** 7つの欄の push.strength（strong/mid/weak）からの読み替え */
export function strengthFromSeven(push: { push: boolean; strength: "strong" | "mid" | "weak" | null } | null | undefined, text = ""): NextStrength {
  if (/併せて|あわせて[^。！]*ご案内|一緒にご案内/.test(text)) return "together";
  if (!push || !push.push) return /お気に召されましたら|お気軽に|いつでも/.test(text) ? "door" : "none";
  return push.strength === "strong" ? "strong" : push.strength === "mid" ? "invite" : "door";
}

/** 時機: 今この番で動かす／先の番のための仕込み（今は押さず、先の判断のための事実を置く） */
export const NEXT_TIMING = ["now", "plant"] as const;
export type NextTiming = typeof NEXT_TIMING[number];
/** 竹内さんが申込の前の番に置いた仕込みの事実（198通で数えた語・行き先が申込でない番） */
export const PLANT_FACT_RE = /1部屋のみ|キャンセル料|埋まる前|申込(?:み)?で(?:お部屋)?(?:抑|押)|先にお申込|入居(?:時期|日)|審査通過|独立系|フリーレント|礼金0/;
export function timingOf(dest: NextDest, text: string): NextTiming {
  return dest !== "apply" && PLANT_FACT_RE.test(text) ? "plant" : "now";
}

export type NextMove = { dest: NextDest; strength: NextStrength; timing: NextTiming };

/** 古い語彙からの読み替え（どの語彙かを source で渡す） */
export function toNextDest(v: string | null | undefined, source: "compose_next" | "lead_to" | "lead_kind"): NextDest | null {
  const s = String(v ?? "").trim();
  if (!s) return null;
  if (source === "compose_next") {
    const m: Record<string, NextDest> = { reply: "door", viewing: "viewing", apply: "apply", send_property: "ask_send", wait_check: "wait_check", answer_only: "answer_only", none: "none" };
    return m[s] ?? null;
  }
  if (source === "lead_to") {
    const m: Record<string, NextDest> = { viewing: "viewing", apply: "apply", estimate: "estimate", ask_send: "ask_send", keep: "keep_send", answer_only: "answer_only", none: "none" };
    return m[s] ?? null;
  }
  const m: Record<string, NextDest> = { 内覧: "viewing", "申込・抑える": "apply", 見積: "estimate", 物件を送ってもらう: "ask_send", 条件を聞く: "ask_condition", 新着の約束: "keep_send", 確認の約束: "wait_check", 関係をつなぐ: "door" };
  return m[s] ?? null;
}

/** 行き先 → judge-basis-types の優先の名前（重点の物差しと同じ数え方にする） */
export const PRIORITY_OF_DEST: Record<NextDest, Priority> = {
  viewing: "next_step", apply: "hold_property", estimate: "next_step", ask_send: "next_step", ask_condition: "next_step",
  keep_send: "keep_promise", wait_check: "keep_promise", answer_only: "answer_question", door: "keep_relation", none: "keep_relation",
};

/** 押す強さの手がかり（198通: 強く押した 17 のうち、決める合図 16・物件の残り 8。残りも合図も無い 174通で strong は 8＝内覧・申込の流れの中だけ） */
export type PushCues = { remaining: boolean; decideSignal: boolean; considering: boolean; firstContact: boolean; notHooked: boolean; /** お客様が「埋まるかも」「取られたくない」と言った */ takenWorry?: boolean; /** お客様が内見できないか・日時の制約を自分から出した */ viewingConstraint?: boolean };
export function strengthCeiling(c: PushCues): { max: NextStrength; why: string } {
  if (c.notHooked) return { max: "door", why: "刺さっていない時は内覧に誘わない（竹内さんの決まり・AIX の2通目の読み）" };
  if (c.takenWorry) return { max: "strong", why: "お客様が埋まる・取られる不安を口にした＝申込で抑える線まで言う（検討の番でも）" };
  if (c.considering && !c.decideSignal) return { max: "door", why: "検討の番は急かさず扉だけ（considering 22通で強く押した 1）" };
  if (c.firstContact) return { max: "invite", why: "初回は信頼を先に（強く押さない）" };
  if (c.remaining || c.decideSignal || c.viewingConstraint) return { max: "strong", why: "物件の残り・決める合図・お客様からの内見の制約の時だけ強く押す（強く押した 17 のうち合図 16・残り 8）" };
  return { max: "invite", why: "合図も残りも無い時は案内まで" };
}
const RANK: Record<NextStrength, number> = { none: 0, door: 1, together: 2, invite: 2, strong: 3 };
export function strengthOverCeiling(s: NextStrength, c: PushCues): boolean {
  return RANK[s] > RANK[strengthCeiling(c).max];
}

/** 竹内さん・スタッフの返信の文から次の一手（行き先×強さ×時機）を読む網（台帳を作る時だけ・LLM なし）。
 *  判断には使わない（P0 9eb6aa9c: 決まった計算は候補の網）。当たりは scripts/test-next-move-types.ts で 198通の7つの欄の lead と比べる */
export function nextMoveFromText(reply: string): NextMove {
  const t = String(reply ?? "");
  const dest: NextDest =
    /お申込(?:み)?(?:し|で)[^。！]{0,12}(?:抑|押さ)え|お部屋(?:を)?(?:抑|押さ)え|お申込(?:み)?(?:手続き|させて)/.test(t) ? "apply"
    : /御?見積書?[^。！]{0,10}(?:作成|お送り)|最大限割引[^。！]{0,10}御?見積/.test(t) ? "estimate"
    : /ご案内させて|ご内覧(?:頂|いただ|如何)|内見(?:頂|いただ|させて)|お日にちに[^。！]{0,10}ご案内/.test(t) ? "viewing"
    : /(?:お送り|教えて)(?:ください|頂けますと|いただけますと)|ご入力(?:ください|頂けますと)/.test(t) ? "ask_send"
    : /ピックアップ[^。！]{0,10}お送り|ピックアップ(?:させて|して|致し|いたし)|新着[^。！]{0,20}お送り|募集に出次第|探させて|お探し(?:させて|致し|いたし)/.test(t) ? "keep_send"
    : /確認(?:させて|致し|いたし)[^。！]{0,6}(?:頂き|いただき)?ます[^。]{0,20}ご連絡|確認出来次第/.test(t) ? "wait_check"
    : /ご内覧|内覧|ご案内|お待ち合わせ/.test(t) ? "viewing"
    : /お申込|申込/.test(t) ? "apply"
    : /お気軽に|いつでも|ごゆっくりご検討/.test(t) ? "door"
    : t.trim() ? "answer_only" : "none";
  const strength: NextStrength =
    /併せて|あわせて[^。！]{0,10}ご案内|一緒にご案内/.test(t) ? "together"
    : dest === "apply" && /キャンセル料|推奨|1部屋のみ|埋まる前|オススメです|抑えさせて頂きます/.test(t) ? "strong"
    : /ご都合よろしいお日にち|如何でしょうか|いかがでしょうか|ご案内させて頂きます/.test(t) ? "invite"
    : /お気に召されましたら|お気軽に|いつでも/.test(t) ? "door" : "none";
  return { dest, strength, timing: timingOf(dest, t) };
}
