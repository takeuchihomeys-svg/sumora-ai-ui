// app/lib/turn-aims-after.ts — 道を決めた後に、この番の目的・中期の狙い・仕込み・先読みの深さを決まった計算で作る（純関数・DB/LLM なし）
//
// 2026-11-12 作業員7（統括役の決め「道を決める所には渡さない」）:
//   ブレインの材料（APPLY_ROUTE_SUBSTATE）・ブレインの出力の欄（BRAIN_TURN_AIMS）は、欄があるだけでブレインが次の一手を進める側へ寄った
//   （q065 off 4/4→on 0/4・q425 返信→AIX:viewing_invite・q406 と同じ型）。どちらも既定 off で止めた。
//   ここはブレインの判断が終わった後に、決まった道が返信の番だけ、状態の表（apply-route-substate.ts の SUBSTATES）から引いて、
//   文の統括への受け渡し（conductor-handoff の decided の turnAim・midAim・plant）にだけ渡す＝道は1つも変わらない。
//   既定 off（TURN_AIMS_AFTER=on）。
import { SUBSTATES, SUBSTATE_SKIP_MOVE_IN_RE, PLANT_JA, type Substate } from "./apply-route-substate";
import { PLANT_NOT_PROMISE_RE, type TurnAims } from "./brain-turn-aims";

type Env = Record<string, string | undefined>;
export const turnAimsAfterOn = (env: Env = typeof process !== "undefined" ? process.env : {}) => (env.TURN_AIMS_AFTER ?? "").trim().toLowerCase() === "on";

/** お客様の今の連投の言葉で状態を選ぶ網（上から順・最初に当たった1つ）。当たらなければ作らない（推測で埋めない） */
const MATCH: Array<[Substate["id"], RegExp]> = [
  ["viewing_no_view_doubt", /内[覧見](?:なく|なし|せず)|見ずに/],
  ["viewing_cannot", /内[覧見](?:は)?(?:でき|出来)(?:ない|ず)|オンライン/],
  ["apply_intent", /申し?込(?:み)?(?:したい|します|をお願い|させて)|抑えて(?:頂|いただ|ほし|欲し)/],
  ["apply_screening_worry", /審査|保証会社|保証人|ブラック|夜職|滞納/],
  ["cost_installment", /分割/],
  ["cost_too_cheap", /安すぎ|追加(?:の)?費用|他に(?:何か)?(?:かかる|費用)/],
  ["cost_over_budget", /初期費用[^。\n]{0,16}(?:高い|安く|抑え|ない|くらい|万)|予算[^。\n]{0,8}(?:超え|オーバー|厳し)|高いので/],
  ["viewing_dates", /内[覧見][^。\n]{0,12}(?:\d+日|日|時|曜|午前|午後|いつ)|(?:\d+日|土曜|日曜)[^。\n]{0,10}内[覧見]/],
  ["proposing_considering", /検討|考えさせ|考えます|相談して|また連絡/],
  ["proposing_liked_one", /気になり|気になる|いいですね|綺麗|良さそう/],
  ["proposing_mismatch", /遠い|他の(?:物件|お部屋|候補)|別の(?:物件|お部屋)/],
  ["brought_vacancy", /https?:\/\/|空いて(?:ます|い)|募集(?:中|して)/],
];

/** 道が決まった後の目的・中期・仕込み・深さ（返信の番だけ・当たらなければ null） */
export function deriveTurnAimsAfter(i: { customerText: string | null | undefined; route: "reply" | "aix"; env?: Env }): TurnAims | null {
  if (!turnAimsAfterOn(i.env) || i.route !== "reply") return null;
  const t = String(i.customerText ?? "").normalize("NFKC");
  if (!t.trim() || SUBSTATE_SKIP_MOVE_IN_RE.test(t)) return null; // 一般の手続きの問い（最短・最速の入居）は作らない（q065）
  const hit = MATCH.find(([, re]) => re.test(t));
  const s = hit ? SUBSTATES.find((x) => x.id === hit[0]) : undefined;
  if (!s) return null;
  const plant = s.plants.map((p) => PLANT_JA[p]).join("・").slice(0, 30);
  return {
    state: s.label, depth: s.depth, depthWhy: s.depthWhy.slice(0, 40), turnAim: s.turnAim.slice(0, 30), midAim: s.midAim === "—" ? "" : s.midAim.slice(0, 40),
    plant: PLANT_NOT_PROMISE_RE.test(plant) ? "" : plant,
  };
}

/** 文の統括への受け渡しに使う meta（ブレインの meta に turn_aims が無い時だけ足す・ブレインの meta は書き換えない） */
export function metaWithTurnAimsAfter(meta: Record<string, unknown>, customerText: string | null | undefined, env?: Env): Record<string, unknown> {
  if (meta.turn_aims) return meta;
  const route: "reply" | "aix" = String(meta.reply_mode ?? "") === "aix" && String(meta.action ?? "").trim() ? "aix" : "reply";
  const ta = deriveTurnAimsAfter({ customerText, route, env });
  // 2026-11-12 統括役: 注記が文の統括に届いた事を示す1行（TURN_AIMS_AFTER=on で作った時だけ・既定 off では出ない）
  if (ta) console.info("[turn-aims-after]", JSON.stringify({ state: ta.state, depth: ta.depth, plant: !!ta.plant, to: "compose" }));
  return ta ? { ...meta, turn_aims: ta } : meta;
}
