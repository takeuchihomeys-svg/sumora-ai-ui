// app/lib/route-path.ts — 申込までの地図の「道筋」（純関数・DB/LLM なし）
//
// 2026-11-23 作業員A（竹内さんの決定 11/23・KB 2d1c4c74「ブレインがちゃんと考えるように 地図は道筋となる ちゃんと道がどうなっても申込までつながっていけるように長期的な思考のため」・台帳 #650）:
//   番の一手を決めるのはブレイン。地図は一手を上書きせず、道筋（今どの駅・申込までの残りの駅・分かれ道からの戻り方・中期と長期）を渡す。
//   統括はそれを読んで、ブレインの一手が申込へ向かう道の上にあるか（遠回り・行き止まり・分かれ道から戻れない）を確かめる＝印だけ・道は決め直さない。
//   f64e0f5d（目的・中期・長期）・55bf37b6（本線と分かれ道・戻り方）と合わせて読む。
// スイッチ（どれも既定 off）:
//   ROUTE_PATH_TO_BRIEF … 統括の指示書（ROUTE_TO_BRIEF の route の欄）に道筋と確かめの印を入れ、次の一手（next）は欄に入れない（記録は meta.apply_route に残る）
//   APPLY_ROUTE_PATH_LINE … ブレインの材料の「申込へ向けた次の一手の候補（合う AIX）」の1行を、道筋の言い方（本線の次の駅・そこへ向かう一手の例）に替える
type Env = Record<string, string | undefined>;
const on = (env: Env | undefined, k: string) => (((env ?? (typeof process !== "undefined" ? process.env : {}))[k] ?? "").trim().toLowerCase() === "on");
export const routePathToBriefOn = (env?: Env) => on(env, "ROUTE_PATH_TO_BRIEF");
export const applyRoutePathLineOn = (env?: Env) => on(env, "APPLY_ROUTE_PATH_LINE");

/** 本線の駅の順（apply-route-map の MAIN_ROUTE と同じ・輪にならないよう写す。同じかはテストで確かめる） */
export const PATH_MAIN: readonly string[] = ["inquiry", "hearing", "pickup", "proposing", "interested", "estimate", "viewing_arrange", "viewing_scheduled", "viewed", "apply_prep", "applying"];
export const PATH_NAME: Readonly<Record<string, string>> = {
  inquiry: "問い合わせ", hearing: "条件ヒアリング", pickup: "物件ピックアップ", proposing: "物件の提案", interested: "気に入った物件あり", estimate: "見積",
  viewing_arrange: "内覧調整", viewing_scheduled: "内覧予定", viewed: "内覧後", apply_prep: "申込準備", applying: "申込",
};
const nm = (id: string | null | undefined) => (id ? PATH_NAME[id] ?? id : "?");

export type RoutePath = {
  station: string | null; branch: string | null;
  /** 申込までの残りの駅（今の駅の次から申込まで・分かれ道の時は戻り先から） */
  remaining: string[];
  wayBackTo: string | null; wayBackHow: string | null;
  /** 中期（次の1〜2駅）・長期（申込） */
  mid: string; long: string;
};
export function routePathOf(loc: { node?: string | null; branch?: string | null; wayBack?: { to: string | null; how: string } | null } | null | undefined): RoutePath | null {
  if (!loc || (!loc.node && !loc.branch)) return null;
  const from = loc.branch && loc.wayBack?.to ? loc.wayBack.to : loc.node ?? null;
  const i = from ? PATH_MAIN.indexOf(from) : -1;
  // 分かれ道の時は戻り先も残りに入れる（戻り先の駅から申込まで）
  const remaining = i < 0 ? [] : PATH_MAIN.slice(loc.branch && loc.wayBack?.to ? i : i + 1);
  const next2 = remaining.filter((x) => x !== "applying").slice(0, 2);
  return {
    station: loc.node ?? null, branch: loc.branch ?? null, remaining,
    wayBackTo: loc.branch ? loc.wayBack?.to ?? null : null, wayBackHow: loc.branch ? (loc.wayBack?.how ?? null) : null,
    mid: loc.branch && loc.wayBack?.to ? `本線の${nm(loc.wayBack.to)}へ戻る` : next2.length ? `${next2.map(nm).join("→")}へ` : "申込へ",
    long: "申込（申込に届く事＝成功・1aab97f3）",
  };
}

/** ブレインの一手（AIX の種類）が向かう駅。返信は今の駅に留まる（null） */
export const AIX_TARGET_STATION: Readonly<Record<string, string>> = {
  condition_hearing: "hearing", zenryoku_support: "pickup", property_send: "proposing", property_recommendation: "proposing",
  estimate_sheet: "estimate", cost_explain: "estimate", cost_breakdown: "estimate", viewing_invite: "viewing_arrange", meeting_place: "viewing_scheduled",
  greeting_viewing: "viewing_scheduled", application_push: "applying", guarantor_info: "apply_prep",
};
/** 物件の在庫が切れた・新着待ちの分かれ道（物件を送る一手は行き止まり） */
const NO_STOCK_BRANCH = new Set(["new_arrival_wait"]);
export type PathVerdict = "on_path" | "stay" | "detour" | "dead_end" | "no_way_back" | "unknown";
export const PATH_VERDICT_JA: Record<PathVerdict, string> = { on_path: "道の上", stay: "今の駅に留まる（返信・確認）", detour: "遠回り（本線を戻る）", dead_end: "行き止まり", no_way_back: "分かれ道から戻れない", unknown: "分からない" };

/**
 * ブレインの一手が申込への道の上にあるか（印だけ）。move＝ブレインの最終の AIX の種類（返信なら null）
 *   返信・確認（物件確認した 等）＝留まる ／ 向かう駅が今の駅以降＝道の上 ／ 分かれ道で向かう駅が戻り先＝道の上 ／
 *   今の駅より前へ戻る＝遠回り ／ 分かれ道が開いていて戻り先へ向かわず先へ飛ぶ＝戻れない ／ 在庫切れの分かれ道で物件を送る＝行き止まり
 */
export function routePathCheck(move: string | null | undefined, path: RoutePath | null): { verdict: PathVerdict; why: string } {
  if (!path) return { verdict: "unknown", why: "地図の位置が無い" };
  const k = String(move ?? "").split("/")[0];
  if (!k) return { verdict: "stay", why: "返信（駅は動かさない）" };
  const target = AIX_TARGET_STATION[k];
  if (!target) return { verdict: "stay", why: `${k}（駅を動かさない AIX）` };
  if (path.branch && NO_STOCK_BRANCH.has(path.branch) && target === "proposing") return { verdict: "dead_end", why: "新着待ちの分かれ道で物件を送る一手（送れる物が無い）" };
  const cur = path.branch && path.wayBackTo ? path.wayBackTo : path.station;
  const ci = cur ? PATH_MAIN.indexOf(cur) : -1, ti = PATH_MAIN.indexOf(target);
  if (ci < 0 || ti < 0) return { verdict: "unknown", why: "駅の順が分からない" };
  if (path.branch && path.wayBackTo) {
    if (ti === ci) return { verdict: "on_path", why: `分かれ道から本線の${nm(target)}へ戻る一手` };
    if (ti > ci + 1) return { verdict: "no_way_back", why: `分かれ道の戻り先（${nm(path.wayBackTo)}）を飛ばして${nm(target)}へ` };
  }
  if (ti >= ci) return { verdict: "on_path", why: `${nm(cur)}から${nm(target)}へ` };
  return { verdict: "detour", why: `${nm(cur)}から本線を戻って${nm(target)}へ` };
}

/** ブレインの材料の1行（APPLY_ROUTE_PATH_LINE=on の時・道筋の言い方）。次の一手の候補は「例」として添えるだけ */
export function routePathBrainLine(path: RoutePath | null, nextLabel: string | null | undefined, nextAix: readonly string[] = []): string {
  if (!path) return "";
  const head = path.branch && path.wayBackTo
    ? `道筋: 分かれ道から本線の${nm(path.wayBackTo)}へ戻り、その先 ${path.remaining.filter((x) => x !== path.wayBackTo).slice(0, 2).map(nm).join("→") || "申込"}→申込`
    : `道筋: 本線の次の駅は${nm(path.remaining[0])}${path.remaining.length > 1 ? `（その先 ${path.remaining.slice(1, 3).map(nm).join("→")}）` : ""}→申込`;
  const ex = nextLabel ? `／そこへ向かう一手の例: ${nextLabel}${nextAix.length ? `（AIX なら ${nextAix.join("・")}）` : ""}` : "";
  return `${head}${ex}。この番の一手はあなたが会話から決める（道筋は申込へつながっているかを見るため）`;
}
