// app/lib/next-move-detail.ts — 次の一手の具体的な中身（何を差し出すか・仕込みの表・いつ次を送るか・形）（純関数・DB/LLM なし・作業員7・2026-11-12）
//
// 竹内さん 11/12「次の一手の部分も具体的に細かくできているか」。作業員16 の next-move-types（行き先10×強さ5×時機2）の名前に揃える
//   （next-move-types.ts が main に入ったら型をそこから import して重ねを消す）。道が決まった後だけに使う（TURN_AIMS_AFTER の中身・道を決め直さない）。
//   既定 off（NEXT_MOVE_DETAIL=on・かつ TURN_AIMS_AFTER=on の時だけ受け渡しに出る）。
//   数は竹内さん本人の 198通（exam-cache/anatomy-seven/seven-all198.json）と同じ会話のその後45日（作業員7 11/12 の仕込みの数え）。
import type { SendCombo } from "./send-combo-table";

/** next-move-types の NEXT_DEST と同じ名前 */
export type NextDest = "viewing" | "apply" | "estimate" | "ask_send" | "ask_condition" | "keep_send" | "wait_check" | "answer_only" | "door" | "none";

/** 先回りの事実の id（作業員21 の先回りの事実と同じ名前にそろえる予定・今は竹内さんの仕込みの語） */
export type PlantFact = "one_room_only" | "hold_by_apply" | "cancel_fee_free" | "screening_stage" | "max_discount" | "key_money_zero" | "free_rent" | "move_in_date" | "independent_guarantor" | "full_support";
export const PLANT_FACT_JA: Record<PlantFact, string> = {
  one_room_only: "1部屋のみの募集", hold_by_apply: "先にお申込でお部屋を抑えられる", cancel_fee_free: "審査の途中まではキャンセル料がかからない",
  screening_stage: "審査の段階・期間", max_discount: "最大限割引の御見積書", key_money_zero: "敷金礼金0円", free_rent: "フリーレント",
  move_in_date: "入居可能日・申込から30日", independent_guarantor: "審査の通りやすい独立系の保証会社", full_support: "ご満足頂けるまで全力でサポート",
};

/** 何を差し出すか */
export type Offer = {
  property: "hooked" | "one_of_sent" | "new_arrival" | "alternative" | null;
  date: "three_nearest" | "ask_convenience" | "customer_proposed" | null;
  facts: PlantFact[];
};
/** いつ次を送るか（作業員19 の time-facts の約束の期限につなぐ・期限の文は渡された時だけ） */
export type When = { at: "now" | "next_turn" | "hours" | "next_day"; dueLabel?: string | null };
export type NextMoveDetail = { dest: NextDest; offer: Offer; plants: Array<{ fact: PlantFact; why: string }>; when: When; form: "reply" | "aix" | "combo"; combo: SendCombo | null };

/** 仕込みの表: 状況 → 置く仕込みと『なぜ』（竹内さんの数・198通と45日のその後） */
export type PlantRow = { when: string; match: (s: PlantSituation) => boolean; facts: PlantFact[]; why: string; count: string };
export type PlantSituation = { checkType?: string | null; worry?: "screening" | "taken" | "cost" | "timing" | null; property?: "one_left" | "vacating" | "available" | "unknown" | null; dest: NextDest };
export const PLANT_ROWS: readonly PlantRow[] = [
  { when: "内覧の前・物件が1部屋だけ", match: (s) => s.property === "one_left" && (s.dest === "viewing" || s.dest === "apply"), facts: ["one_room_only", "hold_by_apply", "cancel_fee_free"],
    why: "内覧の前に申込の線を置く＝取られる前に抑える判断を先にできる（申込で抑えてから内覧 7通→6通が2番後に使われ5通が45日内に申込のフォーマット）", count: "7通・申込へ5" },
  { when: "取られる不安", match: (s) => s.worry === "taken", facts: ["one_room_only", "hold_by_apply"],
    why: "不安の本質（先に申込が入る）に事実で答え、抑える手を示す（1部屋のみ 6通→4通が2番後に使われた）", count: "6通・使われた4" },
  { when: "審査の不安", match: (s) => s.worry === "screening", facts: ["independent_guarantor", "screening_stage"],
    why: "通るまでサポートと通りやすい保証会社を先に置くと、申込の壁が下がる（審査の仕込み 10通→6通が45日内に申込へ）", count: "10通・申込へ6" },
  { when: "費用の不安・見積の前", match: (s) => s.worry === "cost" || s.dest === "estimate", facts: ["max_discount", "key_money_zero"],
    why: "費用の壁を先に下げる（費用の仕込み 32通→12通が45日内に申込へ・見積書 13）", count: "32通・申込へ12" },
  { when: "退去予定の部屋・入居時期", match: (s) => s.property === "vacating" || s.worry === "timing", facts: ["move_in_date", "hold_by_apply"],
    why: "入居できる日と申込の時期を先に伝える＝内見できない間も抑える判断ができる（入居時期の仕込み 3通→3通が使われた・例が少ない）", count: "3通（例が少ない）" },
  { when: "条件のやり取り・初回", match: (s) => s.checkType === "T1_conditions_first" || s.checkType === "T11_first_contact_hearing", facts: ["full_support"],
    why: "長い道の最初に関係を固める（全力サポート 23通・申込へは中央13番後＝長い道）", count: "23通" },
];

export function nextMoveDetailOn(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.NEXT_MOVE_DETAIL ?? "").trim().toLowerCase() === "on";
}

/** 状況に合う仕込み（上から順・重ならないように最大3つ）。仕込みは事実・線だけ（確認・約束は入れない） */
export function plantsFor(s: PlantSituation): Array<{ fact: PlantFact; why: string }> {
  const out: Array<{ fact: PlantFact; why: string }> = [];
  for (const r of PLANT_ROWS) if (r.match(s)) for (const f of r.facts) if (!out.some((o) => o.fact === f) && out.length < 3) out.push({ fact: f, why: r.why });
  return out;
}

/** 行き先から差し出す物といつ次を送るかの初期値（竹内さんの形） */
export function offerFor(dest: NextDest, s: PlantSituation): Offer {
  const facts = plantsFor(s).map((p) => p.fact);
  switch (dest) {
    case "viewing": return { property: "hooked", date: "three_nearest", facts };
    case "apply": return { property: "hooked", date: null, facts };
    case "estimate": return { property: "hooked", date: null, facts };
    case "keep_send": return { property: s.property === "one_left" ? "alternative" : "new_arrival", date: null, facts };
    default: return { property: null, date: null, facts };
  }
}
export function whenFor(dest: NextDest, dueLabel?: string | null): When {
  if (dest === "wait_check") return { at: "next_day", dueLabel: dueLabel ?? null };  // 管理会社の確認は営業時間・翌営業日（time-facts の期限）
  if (dest === "keep_send") return { at: "hours", dueLabel: dueLabel ?? null };      // ピックアップ・新着は数時間〜当日
  if (dest === "door" || dest === "answer_only" || dest === "none") return { at: "next_turn" };
  return { at: "now" };
}
export function buildNextMoveDetail(i: { dest: NextDest; situation: Omit<PlantSituation, "dest">; combo: SendCombo | null; dueLabel?: string | null }): NextMoveDetail {
  const s = { ...i.situation, dest: i.dest };
  const form: NextMoveDetail["form"] = i.combo && /then|reply_reply/.test(i.combo) ? "combo" : i.combo === "aix_only" ? "aix" : "reply";
  return { dest: i.dest, offer: offerFor(i.dest, s), plants: plantsFor(s), when: whenFor(i.dest, i.dueLabel), form, combo: i.combo };
}

/** 文の統括への受け渡しの1行（短く） */
export function nextMoveDetailLine(d: NextMoveDetail): string {
  const p = d.offer.property ? { hooked: "刺さった物件", one_of_sent: "送った中の1件", new_arrival: "新着", alternative: "代わりの物件" }[d.offer.property] : null;
  const dt = d.offer.date ? { three_nearest: "直近の空いている日を3つ", ask_convenience: "ご都合を伺う", customer_proposed: "お客様の候補日で" }[d.offer.date] : null;
  const at = { now: "今", next_turn: "次の番", hours: "数時間後", next_day: "翌営業日" }[d.when.at] + (d.when.dueLabel ? `（${d.when.dueLabel}）` : "");
  return `次の一手の中身: ${[p, dt].filter(Boolean).join("・") || "—"}／仕込み: ${d.plants.map((x) => PLANT_FACT_JA[x.fact]).join("・") || "なし"}／次を送るのは ${at}`;
}
