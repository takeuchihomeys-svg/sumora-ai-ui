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
// 2026-11-15 作業員J: 11/15 試験で悪化0・既定 on（=off で戻す）。試験 j1115b-dec1〜3（TURN_AIMS_AFTER+COMPOSE_DECIDED・下書きまで・6問×2回）確かな悪化0
export const turnAimsAfterOn = (env: Env = typeof process !== "undefined" ? process.env : {}) => (env.TURN_AIMS_AFTER ?? "on").trim().toLowerCase() !== "off";

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

/** お客様の今の連投の言葉で当たる細かい状態（道に関係なく・当たらなければ null）。2026-11-21 作業員M（#467）: 統括の指示書（route-record.routeBriefSection）と同じ網を使うため外に出した */
/**
 * 2026-11-21 作業員M（台帳 #467 の (2)・統括役の了承の DeepSeek の割り当て l1・竹内さんの番 514・2回以上そろった 500）: 網の2版（ROUTE_SUBSTATE_NET_V2=on・既定 off）。
 *   作る半分（id の偶奇・230番）の取りこぼしと言い過ぎだけを読んで作り、測る半分（270番）で当たりを出す（scripts/audit-route-substate-takeuchi.ts --labels --gists）。
 *   1版の弱い所: 条件のフォーム（お部屋お探し中・ご希望の家賃…）を拾えず費用・好意と言い過ぎ（hearing の取りこぼし 47/47）／持ち込みの画像・〈URL〉・物件情報（6%）／
 *   探し直しの頼み（0%）／内覧の日時の言い方（11%）／審査の語だけで審査の不安と言い過ぎ（42%）。
 *   TURN_AIMS_AFTER（既定 on・書き手への受け渡し）もこの網を読むので、2版は既定 off で試験の後に on。
 */
const MATCH_V2: Array<[Substate["id"], RegExp]> = [
  ["viewing_no_view_doubt", /内[覧見](?:なく|なし|せず)|見ずに/],
  ["viewing_cannot", /内[覧見](?:は)?(?:でき|出来)(?:ない|ず)|オンライン/],
  ["hearing_many_conditions", /お部屋お?探し中|お部屋探しご条件|ご希望の家賃|【ご入居の時期】|ご入居時期|希望条件|(?:家賃|予算|管理費込)[^\n]{0,40}(?:駅|間取り|1LDK|1K|2LDK|1DK|2DK|徒歩)[^\n]{0,60}(?:探して|探しています|ありますでしょうか|ありますか)/i],
  ["apply_intent", /申し?込(?:み)?(?:したい|します|をお願い|させて)|抑えて(?:頂|いただ|ほし|欲し)|審査(?:を)?(?:一旦)?(?:通して|かけて|出して)/],
  ["apply_screening_worry", /審査[^。\n]{0,10}(?:通(?:る|り|ら)|不安|心配|厳し|大丈夫|落ち)|保証人|ブラック|夜職|滞納|無職|自営業|フリーター/],
  ["cost_installment", /分割|クレジット|カード払い|支払い方法/],
  ["cost_too_cheap", /安すぎ|追加(?:の)?費用|他に(?:何か)?(?:かかる|費用)|仲介手数料(?:無|な)し/],
  ["viewing_dates", /内[覧見](?:したい|させて|をお願い|可能)|内[覧見][^。\n]{0,12}(?:\d+日|日|時|曜|午前|午後|いつ)|(?:\d+日|日曜|土曜|今日|明日|平日)[^。\n]{0,15}(?:\d+時|午前|午後|空いて|行け)|\d+時(?:\d+分)?から|のあと行け/],
  ["cost_over_budget", /初期費用[^。\n]{0,16}(?:高い|安く|抑え|ない|くらい|万)|予算[^。\n]{0,8}(?:超え|オーバー|厳し)|高いので/],
  ["proposing_considering", /検討|考えさせ|考えます|相談して|また連絡/],
  ["proposing_mismatch", /遠い|他の(?:物件|お部屋|候補)|別の(?:物件|お部屋)|(?:でも|も)探して|もう少し(?:広|探|安|大き)|違う物件|再度[^。\n]{0,10}探|厳しいです|小さそう|付近[^。\n]{0,12}望ましい|新着(?:出|が出)ましたら/],
  ["proposing_liked_one", /気になり|気になる|いいですね|綺麗|良さそう/],
  ["brought_vacancy", /https?:\/\/|〈URL〉|空いて(?:ます|い)|募集(?:中|して|無し|なし)|物件情報|物件名|号室|by SUUMO|LIFULL|HOME'?S/],
  ["proposing_detail_question", /(?:ペット|内装|壁紙|アプリ|入居|階|騒音|虫|2人|二人|設備|洗濯機)[^。\n]{0,25}(?:でしょうか|ですか|ますか|可能)/],
];
export function substateNetV2On(env: Env = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.ROUTE_SUBSTATE_NET_V2 ?? "").trim().toLowerCase() === "on";
}
export function matchSubstateOf(customerText: string | null | undefined, env?: Env): Substate | null {
  const t = String(customerText ?? "").normalize("NFKC");
  if (!t.trim() || SUBSTATE_SKIP_MOVE_IN_RE.test(t)) return null; // 一般の手続きの問い（最短・最速の入居）は作らない（q065）
  const hit = (substateNetV2On(env) ? MATCH_V2 : MATCH).find(([, re]) => re.test(t));
  return (hit ? SUBSTATES.find((x) => x.id === hit[0]) : undefined) ?? null;
}

/** 道が決まった後の目的・中期・仕込み・深さ（返信の番だけ・当たらなければ null） */
export function deriveTurnAimsAfter(i: { customerText: string | null | undefined; route: "reply" | "aix"; env?: Env }): TurnAims | null {
  if (!turnAimsAfterOn(i.env) || i.route !== "reply") return null;
  const s = matchSubstateOf(i.customerText, i.env);
  if (!s) return null;
  const plant = s.plants.map((p) => PLANT_JA[p]).join("・").slice(0, 30);
  return {
    state: s.label, depth: s.depth, depthWhy: s.depthWhy.slice(0, 40), turnAim: s.turnAim.slice(0, 30), midAim: s.midAim === "—" ? "" : s.midAim.slice(0, 40),
    plant: PLANT_NOT_PROMISE_RE.test(plant) ? "" : plant,
  };
}

/** 2026-11-28 作業員A（#827・統括役「番の目的と仕込みは TURN_AIMS_AFTER の側から」）: AIX ボタンの札に入れる目的・狙い・仕込み。道が AIX の番でも作る（判断の後・記録と札だけ＝道は変えない）。当たらなければ null */
export function turnAimsForAixCard(customerText: string | null | undefined, env?: Env): Pick<TurnAims, "turnAim" | "midAim" | "plant"> | null {
  if (!turnAimsAfterOn(env)) return null;
  const s = matchSubstateOf(customerText, env);
  if (!s) return null;
  const plant = s.plants.map((p) => PLANT_JA[p]).join("・").slice(0, 30);
  return { turnAim: s.turnAim.slice(0, 30), midAim: s.midAim === "—" ? "" : s.midAim.slice(0, 40), plant: PLANT_NOT_PROMISE_RE.test(plant) ? "" : plant };
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
