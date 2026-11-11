// app/lib/apply-route-substate.ts — 申込までの地図の2段目「駅の中の細かい状態」と、状態ごとの目的・中期・長期・仕込み・先読みの深さ（純関数・DB/LLM なし）
//
// 2026-11-12 作業員7（竹内さん 11/12「目的・中期的・長期的思考」「地図は大まかな部分も細かい部分も必要」「状況に応じて何手先まで想定するか」・統括役の決め (a)）。
//   apply-route-map.ts は駅12・分かれ道15で駅ごとに次の一手が1つ（大まか）。ここはその下の段＝竹内さんの実物から数えた細かい状態。
//   数え（竹内さん本人の198通＝exam-cache/anatomy-seven/seven-all198.json と、同じ会話のその後45日・作業員7 11/12）:
//     先読みの深さ: 1＝この番だけ 33通（45日内に申込のフォーマット 18%）／2＝1〜2番先 77通（45%・押した 55）／3＝長い道 88通（28%）
//     仕込み: 申込で抑えてから内覧 7通→6通が2番後に使われ 5通が申込のフォーマットへ・1部屋のみ 6→4・費用 32・全力サポート 23・審査 10
//   ⚠ 深さ2の申込の割合は駅（申込準備・内覧）に寄る（深さが申込を生んだとは言えない）。n<4 の状態は few（例が少ない）で残す（捨てない）。
//
// ── 線（P0 9eb6aa9c「判断はすべてブレイン基準」）──
//   状態は「候補の網」。どの状態か・何番先まで見るかはブレインが会話を読んで選ぶ（材料の文にもそう書く）。道（返信か AIX か）はこの表で決めない。
//   既定 off（APPLY_ROUTE_SUBSTATE=on）。off の時は空文字＝プロンプトは1バイトも変わらない。
import type { RouteNodeId, RouteBranchId, ApplyRouteLocation } from "./apply-route-map";

type Env = Record<string, string | undefined>;
export const applyRouteSubstateOn = (env: Env = typeof process !== "undefined" ? process.env : {}) => (env.APPLY_ROUTE_SUBSTATE ?? "").trim().toLowerCase() === "on";

/** 仕込み（先の番のための一言）の型 */
export type Plant = "scarcity" | "hold_before_viewing" | "support" | "cost" | "screening" | "timing" | "ask_send";
export const PLANT_JA: Record<Plant, string> = {
  scarcity: "1部屋のみ・問い合わせが多い（先に取られる線）", hold_before_viewing: "申込で抑えてから内覧（申込の線を内覧の前に）",
  support: "全力サポート・ご満足頂けるまで（関係を固める）", cost: "最大限割引・初期費用を抑える（障壁を下げる）",
  screening: "審査のサポート・通りやすい保証会社", timing: "入居日・申込の時期（申込から30日 等）を先に", ask_send: "気になる物件を送ってもらう（見積の入口）",
};

export type Depth = 1 | 2 | 3;
export const DEPTH_JA: Record<Depth, string> = { 1: "この番だけ（答えて閉じる）", 2: "1〜2番先（内覧・申込・見積へ）", 3: "長い道（信用と仕込みで申込まで）" };

export type Substate = {
  id: string;
  /** 駅か分かれ道 */
  at: RouteNodeId | RouteBranchId;
  label: string;
  /** 竹内さんの番の数（198通の中） */
  n: number;
  few?: boolean;
  /** 竹内さんがこの番で目指した事（今の1手） */
  turnAim: string;
  /** 次の2〜3番の狙い */
  midAim: string;
  /** 申込までの道で今どこを固めているか */
  longAim: string;
  plants: Plant[];
  /** 竹内さんが多く取った先読みの深さと、その数（深さ1/2/3） */
  depth: Depth;
  depthCount: [number, number, number];
  /** 深さを決めた合図 */
  depthWhy: string;
  /** 竹内さんの誘導先の多い順（説明用） */
  lead: string;
};

export const SUBSTATES: Substate[] = [
  { id: "hearing_many_conditions", at: "hearing", label: "条件が多い・見つかるか不安", n: 30, turnAim: "条件を受け止め、ピックアップの約束", midAim: "条件に合う物件を送り反応を取る（1〜2番先）", longAim: "信用を頂く＝申込まで任せてもらう土台",
    plants: ["support", "cost"], depth: 3, depthCount: [1, 3, 26], depthWhy: "初回・条件のやり取り＝内覧・申込までの道が長い。全力サポート（16）と費用（6）を先に仕込む", lead: "関係をつなぐ（ピックアップの約束）24・申込3" },
  { id: "brought_vacancy", at: "brought_property", label: "持ち込み物件の空き・募集状況", n: 19, turnAim: "募集状況の確認の約束", midAim: "確認の結果→最大限割引の御見積書（2〜3番先）", longAim: "見積で決めてもらい内覧・申込へ",
    plants: ["cost"], depth: 3, depthCount: [0, 5, 14], depthWhy: "物件は決まっていないことが多い＝まず確認と見積の線。お客様の温度が高い（押した 6）時は 1〜2番先", lead: "関係をつなぐ14・見積3" },
  { id: "proposing_considering", at: "considering", label: "検討します（保留）", n: 16, turnAim: "受け止めて扉を残す", midAim: "内覧の扉（6）か新着の約束（4）を1文", longAim: "関係をつなぐ（急がない）",
    plants: [], depth: 2, depthCount: [4, 8, 4], depthWhy: "物件の残りが少ない・取られる不安がある時は申込の線（2）、そうでなければ先を急がず扉だけ", lead: "内覧6・関係をつなぐ4・答えだけ4・申込2" },
  { id: "proposing_detail_question", at: "proposing", label: "送った物件の中身の質問", n: 8, turnAim: "答える（資料・会社の事実）", midAim: "条件に足して探す／内覧へ", longAim: "比べて選んでもらう",
    plants: [], depth: 3, depthCount: [3, 1, 4], depthWhy: "答えだけで閉じる番（3）と、条件に足して探し直す番（4）に分かれる", lead: "関係をつなぐ4・答えだけ3" },
  { id: "proposing_mismatch", at: "condition_change", label: "条件と違う・他の候補を", n: 5, turnAim: "受け止めて新しくピックアップの約束", midAim: "新しい条件で物件を送る（1〜2番先）", longAim: "関係をつなぐ",
    plants: ["support"], depth: 3, depthCount: [0, 1, 4], depthWhy: "合わなかった＝道を戻して信用を固める", lead: "関係をつなぐ4・内覧1" },
  { id: "proposing_liked_one", at: "interested", label: "1件に好意・気になる", n: 4, turnAim: "好意を受けて次へ", midAim: "内覧・見積へ（1〜2番先）", longAim: "申込へ誘う",
    plants: ["ask_send", "cost"], depth: 2, depthCount: [0, 2, 2], depthWhy: "温度が上がった合図＝近い先（内覧）を見る", lead: "内覧2" },
  { id: "cost_over_budget", at: "estimate", label: "総額が予算を超える・高い", n: 10, turnAim: "費用を受け止め、抑える線を示す", midAim: "抑えられる物件・割引の御見積書（2〜3番先）", longAim: "障壁を下げて申込へ",
    plants: ["cost", "support"], depth: 3, depthCount: [2, 1, 7], depthWhy: "費用が壁＝急がず割引と物件の入れ替えで道を作る", lead: "関係をつなぐ7・答えだけ2" },
  { id: "cost_too_cheap", at: "estimate", label: "安すぎる・追加費用の不安", n: 4, turnAim: "仕組み・項目で答える", midAim: "安心してもらい見積で決めてもらう", longAim: "信用を頂く",
    plants: ["cost"], depth: 1, depthCount: [2, 1, 1], depthWhy: "不安に答える番＝この番で閉じる", lead: "答えだけ2" },
  { id: "cost_installment", at: "estimate", label: "分割・支払い方法", n: 3, few: true, turnAim: "支払い方法に答える（カード・3.24%）", midAim: "—", longAim: "障壁を下げる",
    plants: [], depth: 1, depthCount: [3, 0, 0], depthWhy: "答えだけの番", lead: "答えだけ3" },
  { id: "viewing_dates", at: "viewing_arrange", label: "内覧の日時の希望・都合", n: 15, turnAim: "日時を決める", midAim: "待ち合わせ→内覧→その場で申込（1〜2番先）", longAim: "申込へ誘う",
    plants: ["scarcity", "hold_before_viewing"], depth: 2, depthCount: [1, 13, 1], depthWhy: "日時が決まれば次は申込＝1部屋のみ・抑えてから内覧を内覧の前に仕込む（押した 6）", lead: "内覧11・申込2" },
  { id: "viewing_cannot", at: "viewing_arrange", label: "内見できない・オンライン", n: 5, turnAim: "オンライン・撮影・申込で抑える道を出す", midAim: "抑えてから内覧（2番先）", longAim: "申込へ誘う",
    plants: ["hold_before_viewing"], depth: 3, depthCount: [1, 1, 3], depthWhy: "すぐ見られない＝抑える線か関係をつなぐ", lead: "関係をつなぐ2" },
  { id: "viewing_no_view_doubt", at: "viewing_arrange", label: "内覧なしで決める迷い", n: 1, few: true, turnAim: "1部屋のみと抑えてから内覧を伝える", midAim: "申込（1番先）", longAim: "申込へ誘う",
    plants: ["scarcity", "hold_before_viewing"], depth: 2, depthCount: [0, 1, 0], depthWhy: "決める合図＋残り1部屋＝1〜2番先の申込だけを見る", lead: "申込1" },
  { id: "apply_screening_worry", at: "screening_concern", label: "審査の不安（属性）", n: 13, turnAim: "通るまでサポートと保証会社の説明", midAim: "審査をかけてみる（申込・1〜2番先）", longAim: "申込・審査通過",
    plants: ["screening"], depth: 2, depthCount: [2, 7, 4], depthWhy: "気に入った物件がある時は申込（2）、まだ無い時は通りやすい物件を探す長い道（3）", lead: "申込4・関係をつなぐ3・内覧3" },
  { id: "apply_timing", at: "apply_prep", label: "入居時期・支払い時期", n: 10, turnAim: "時期の線（申込から30日・抑えの期間）を答える", midAim: "時期に合わせて申込・抑える", longAim: "申込へ",
    plants: ["timing", "screening", "cost"], depth: 2, depthCount: [2, 4, 4], depthWhy: "入居時期が近い＝申込（2）、先＝連絡の日を約束（3）", lead: "関係をつなぐ4・申込3" },
  { id: "apply_intent", at: "apply_prep", label: "申込の意思・抑えたい", n: 5, turnAim: "受けて申込のフォーマット", midAim: "書類→申込（1番先）", longAim: "申込",
    plants: [], depth: 2, depthCount: [1, 3, 1], depthWhy: "決める合図＝すぐ先だけを見る", lead: "申込3" },
];

/** その位置（駅・分かれ道）の状態の候補 */
export function substatesFor(loc: Pick<ApplyRouteLocation, "node" | "branch"> | null | undefined): Substate[] {
  if (!loc) return [];
  return SUBSTATES.filter((s) => s.at === loc.branch || s.at === loc.node);
}

export const SUBSTATE_TEXT_MAX = 900;
/** 材料の文（候補が無ければ空）。道を決めるのはブレイン */
export function buildSubstateBrainText(loc: Pick<ApplyRouteLocation, "node" | "branch"> | null | undefined): string {
  const cands = substatesFor(loc);
  if (!cands.length) return "";
  const lines = cands.map((s, i) => `${i + 1}) ${s.label}（竹内さんの番 ${s.n}${s.few ? "・例が少ない" : ""}）: 目的=${s.turnAim}／中期=${s.midAim}／長期=${s.longAim}`
    + `／先読み=${DEPTH_JA[s.depth]}（${s.depthWhy}）${s.plants.length ? `／仕込み=${s.plants.map((p) => PLANT_JA[p]).join("・")}` : ""}`);
  let text = `\n【この駅の細かい状態の候補（竹内さんの実物の数・材料）】\n${lines.join("\n")}\n※状態と何番先まで見るかはあなたが会話（お客様の温度・入居時期・物件の残り・段階）を読んで選ぶ。道（返信か AIX か）はこの表で決めない。`;
  if (text.length > SUBSTATE_TEXT_MAX) text = text.slice(0, SUBSTATE_TEXT_MAX - 1) + "…";
  return text;
}

/** brain-core から呼ぶ入口。off の時は必ず空文字 */
export function substateBrainTextIfEnabled(loc: Pick<ApplyRouteLocation, "node" | "branch"> | null | undefined, env?: Env): string {
  return applyRouteSubstateOn(env) ? buildSubstateBrainText(loc) : "";
}
