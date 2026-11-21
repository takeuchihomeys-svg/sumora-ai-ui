// app/lib/owner-pointers.ts — 竹内さんの指摘の帳面（表 owner_pointers）の決まり（純関数・DB/LLM なし）
//
// 2026-11-21 竹内さん「この俺の指摘のようなのをちゃんと理解して自己改善していく仕組みを作って。改善が必要なら改善していけるように」
//   「この指摘の部分もちゃんとデータベースを作って強化していく。設計知見と協力して自己改善していける仕組みを作る。それと試験の部分とも連携する仕組みを作る」
//   （統括役の頼み・作業員N・台帳 #472・memory/owner_feedback_types_1121.md）
// 指摘1つを型（kinds）と分野（areas）に分け、その型の点検（scripts/owner-feedback-check.ts）を全分野で回し、見つけた穴を台帳（found_gap）へ・
// 決まりを設計知見へ・外れる番を試験の問題の候補へつなぐ。ここは分け方と状態の進め方だけ（決まった語・LLM なし）。

export const POINTER_KINDS = ["not_delivered", "unread", "link_broken", "not_subdivided", "no_measure", "no_rule", "left_off", "no_grasp", "exam", "process", "outage", "other"] as const;
export type PointerKind = typeof POINTER_KINDS[number];
export const POINTER_KIND_JA: Record<PointerKind, string> = {
  not_delivered: "材料が届いていない", unread: "読めていない（画像・物件）", link_broken: "連携が切れている", not_subdivided: "細分化が足りない",
  no_measure: "物差しが無い", no_rule: "決まりが無い", left_off: "作ったが off のまま", no_grasp: "把握が無い（状況の土台）",
  exam: "試験（効率・質・費用）", process: "回し方（拾い上げ・割り当て）", outage: "本番の故障（重い・取りこぼし）", other: "その他",
};
export const POINTER_AREAS = ["reply", "aix1", "aix2", "property_pick", "image", "route_map", "foundation", "exam", "promise", "conductor", "other"] as const;
export type PointerArea = typeof POINTER_AREAS[number];
export const POINTER_STATES = ["received", "checked", "fixing", "exam_passed", "on", "ready", "closed"] as const;
export type PointerState = typeof POINTER_STATES[number];

/** 型の語（先に当たった型を主にする＝並びが優先の順）。2026-11-21 の 90行の分けで決めた（memory/owner_feedback_types_1121.md） */
const KIND_RES: Array<[PointerKind, RegExp]> = [
  ["unread", /画像|物件名|物件把握|読み取|読めて|よみとれ|把握できる|物件確認した/],
  ["not_delivered", /材料|届いていない|届ける|事実の欄|足りない情報|INFO_FILL|自己申告|資料|会社の事実|こちら側の状態|帳面/],
  ["link_broken", /連携|つなが|つなぎ|受け渡し|届き方|→|渡した欄|LINK|統括と1組|NEXT_SEND|ASK_PROGRESS|2通目の書き手/],
  ["not_subdivided", /細分化|細かく|具体的|土台|地図|段|型に分け|徹底/],
  ["no_measure", /物差し|数え|測|当たり|見張り|点検/],
  ["no_rule", /決まり|竹内さんへの問い|確認事項|分からない事|正解付け/],
  ["left_off", /既定 off|off のまま|付け忘れ/],
  ["no_grasp", /把握|時系列|カレンダー|全体の統括|約束の|状況|いつ言った/],
  ["exam", /試験/],
  ["process", /拾い上げ|割り当て|引き継ぎ|割り振り|進め方|空いた作業員/],
  ["outage", /重い|つながりにく|反映されてい|取りこぼし|停止/],
];
/** 指摘の文（題＋竹内さんの言葉）の型。当たる物を全部・主（先頭）は優先の順。何も当たらなければ other */
export function pointerKindsOf(text: string, o: { builtOff?: boolean } = {}): PointerKind[] {
  const s = String(text ?? "");
  const out = KIND_RES.filter(([, re]) => re.test(s)).map(([k]) => k);
  if (o.builtOff && !out.includes("left_off")) out.push("left_off");
  return out.length ? out : ["other"];
}

const AREA_RES: Array<[PointerArea, RegExp]> = [
  ["aix2", /2通目|二通目/], ["aix1", /AIX/], ["image", /画像|写真/], ["property_pick", /物件選び|物件出し|ピックアップ|オススメ|訴求/],
  ["route_map", /地図|駅/], ["exam", /試験/], ["promise", /約束/], ["conductor", /統括/], ["foundation", /土台/], ["reply", /返信|文の|書き手|下書き/],
];
export function pointerAreasOf(text: string): PointerArea[] {
  const s = String(text ?? "");
  const out = AREA_RES.filter(([, re]) => re.test(s)).map(([a]) => a);
  return out.length ? out : ["other"];
}

/** 状態は前にだけ進む（戻すのは理由つきで人が行う）。closed は最後 */
export function canAdvance(from: PointerState, to: PointerState): boolean {
  return POINTER_STATES.indexOf(to) > POINTER_STATES.indexOf(from);
}

/** 台帳の owner_request の行から指摘の行を作る（過去分の埋め・LLM なし）。引用が無い行は題を言葉の代わりにし、source=work_item で台帳の id を持つ */
export type WorkItemLite = { id: number; title: string; requested_quote: string | null; requested_at: string | null; created_at: string; stage: string; kb_ids?: string[] | null; switch_name?: string | null };
export function pointerFromWorkItem(w: WorkItemLite) {
  const text = `${w.title} ${w.requested_quote ?? ""} ${w.switch_name ?? ""}`;
  const state: PointerState = w.stage === "done" ? "ready" : w.stage === "dropped" ? "closed" : w.stage === "on" ? "on" : w.stage === "passed" ? "exam_passed"
    : ["building", "testing", "built_off"].includes(w.stage) ? "fixing" : "received";
  return {
    said_at: w.requested_at ?? w.created_at,
    quote: (w.requested_quote ?? "").trim() || w.title,
    kinds: pointerKindsOf(text, { builtOff: w.stage === "built_off" }),
    areas: pointerAreasOf(text),
    state,
    work_item_ids: [w.id],
    kb_ids: (w.kb_ids ?? []).map((x) => String(x).slice(0, 8)),
    source: "work_item" as const,
    source_ref: String(w.id),
  };
}
