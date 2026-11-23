// app/lib/metric-map.ts — 数ごとの地図（木）と見込みの突き合わせ（純関数だけ・LLM なし・作業員P・2026-11-23・台帳 #610）
//
// 竹内さん 11/23「この予測と今の部分と次の部分を把握するように連携するように。ちゃんと細部までこだわって土台を作って、細部まで改善していく」
//   「このようにちゃんと地図は細分化して強化して導いていけるように」「テストの部分のブレインも理解した方が良いのではないか」。
//   1つの数（例: AIX の番の一致）を、外れの元が分かる所まで子に割った木にする（数 → AIX の種類 → 場面 → 外れの型 → 原因）。
//   葉ごとに 今の値・n・見込み・動かす作業（段・スイッチ）・次の一手・止まっている理由 を持たせ、伸びしろ（外れの番 × 直せる見込み）で順位を付けて「次の一手」を導く。
//   木の形は表（MAP_ROOTS）で持つ＝組の一致・返信の一致・申込までの道筋も同じ型で足せる（builder を足すだけ）。
//   書き手の選び方（writer_select）: style＝文の癖（verdict_detail.staff_writer）／device＝端末の記録（作業員N2 の core:conductor_aix_device）。
//     11/23 統括役: 文の癖で選ぶと AIX の番の約半分（60日 193中93）は端末では従業員の番＝数え方が変わり得る。見込みの突き合わせは同じ選び方どうしで比べる。
// 置き場: 木の1日分は metric_map_nodes（scripts/lib/metric-map-server.ts が書く）・見込みは work_items.forecast_*・要点は quality_daily の map:* / forecast:*。
// 葉の鍵: <根の数の名前>/<段>=<値>/… 例 core:conductor_aix_60d/kind=estimate_sheet/scene=cost/miss=reply_not_aix/cause=material

import { isAckOnlyTurn } from "./ack-topic-scope";

export type WriterSelect = "style" | "device" | "all";
export type MapDim = "kind" | "scene" | "miss" | "cause" | "station";
/** 原因の4つ（CLAUDE.md 絶対的な考え方の3つ＋数え方の誤り） */
export type MapCause = "material" | "misread" | "aix_turn_as_reply" | "counting" | "judgment";
export const MAP_CAUSE_JA: Record<MapCause, string> = {
  material: "材料が届いていない", misread: "場面や決まりの読み違い", aix_turn_as_reply: "返信か AIX かの判断の誤り（AIX の番を返信に）", counting: "数え方の誤り",
  judgment: "判断の誤り（材料は届いていたのに果たされない・約束の分野＝作業員L）",
};
export const MAP_CAUSES = Object.keys(MAP_CAUSE_JA) as MapCause[];
// 2026-11-23 統括役（2回目）: 端末の版（作業員A の audit-aix-turn-judgment）の「先後」と、申込までの地図（作業員R の routeAgreement）の外れの型を足した
export type MapMiss = "ok" | "reply_not_aix" | "aix_kind" | "order" | "push_missed" | "other_aix" | "pushed_off_map" | "decided" | "minority" | "timed" | "fixed_since" | "split"
  | "stuck" | "left" | "back" | "engaged" | "branch_stay" | "viewing_wait" | "close_missed" | "close_early" | "late" | "overdue";
export const MAP_MISS_JA: Record<MapMiss, string> = {
  ok: "一致", reply_not_aix: "AIX を返信にした", aix_kind: "AIX の種類違い", order: "先後（竹内さんは2段・ブレインは今 AIX）",
  push_missed: "地図は AIX で進める・竹内さんは返信", other_aix: "地図と違う AIX", pushed_off_map: "地図は返信・竹内さんは AIX で動かした",
  decided: "竹内さんの決定で正解を改めた番（実送信と今の正解が割れる・外れの順位に入れない）",
  minority: "竹内さんの少数側（同じ形の番で竹内さん本人の別の一手が過半数・ブレインは多い方を選んだ・外れの順位に入れない）",
  timed: "時刻で送る物（番の判断の外・例 当日のご挨拶は了承への返しでなく日にちで送る・外れの順位に入れない）",
  fixed_since: "直しが入った日より前の番（今のコードでは直っている・どの直しかは FIXED_SINCE・外れの順位に入れない）",
  split: "割れ（同じ形の番で竹内さん本人の一手が半分前後に割れる・どちらにも決めない・外れの順位に入れない）",
  stuck: "止まった（次のお客様の発言で駅が進まない）", left: "離れた（返事が来ない）", back: "戻った（申込から遠い駅へ）", engaged: "やり取りは続くが駅は同じ", branch_stay: "分かれ道から本線に戻れない",
  viewing_wait: "内覧の日待ち（続く・内覧の日がまだ来ていない・直す所ではない）",
  close_missed: "見逃し（竹内さんは決めに行った・ブレインは待った）", close_early: "早すぎ（ブレインは決めに行った・竹内さんは待った）",
  late: "遅れて果たした（約束）", overdue: "期限を過ぎて果たしていない（約束）",
};
/** 外れの順位・穴に入れない外れの型（別の数として並べる） */
export const SET_ASIDE_MISS = new Set<MapMiss>(["decided", "minority", "timed", "fixed_since", "split", "viewing_wait"]);
/** 決めに行く番の監査の行を木の番に（純関数）。種類＝竹内さんの決め方（または早すぎの時のブレインの一手）・場面＝申込予測の度合い（hot/warm/cold）・原因＝統括の材料の欠けがあれば材料・無ければ読み違い */
export function closingTurnsOf(rows: ReadonlyArray<{ id: number; takeuchiClose: boolean; brainClose: boolean; closeHow: string | null; brainAct: string | null; level: string | null; gaps: string[] }>, side: "closing" | "closing_early"): MapTurn[] {
  const mine = rows.filter((r) => (side === "closing" ? r.takeuchiClose : r.brainClose));
  return mine.map((r) => {
    const ok = side === "closing" ? r.brainClose : r.takeuchiClose;
    const kind = side === "closing" ? String(r.closeHow ?? "other").replace(/^aix:/, "") : String(r.brainAct ?? "other");
    return { id: r.id, kind, scene: r.level ?? "none", miss: ok ? "ok" : side === "closing" ? "close_missed" : "close_early", cause: ok ? null : r.gaps.length ? "material" : "misread" };
  });
}
/** 本線の駅（app/lib/apply-route-map.ts の MAIN_ROUTE と同じ・作業員A の route-station-trust と同じ） */
export const MAIN_STATIONS = new Set(["inquiry", "hearing", "pickup", "proposing", "interested", "estimate", "viewing_arrange", "viewing_scheduled", "viewed", "apply_prep", "applying"]);
/** 内覧の日がまだ来ていない番か（純関数・作業員A の route-station-trust の viewingNotYet と同じ: 番の detail の「M/D」が番の日（JST）以後） */
export function viewingNotYetOf(at: string | null | undefined, detail: string | null | undefined): boolean {
  const m = String(detail ?? "").match(/(\d{1,2})\/(\d{1,2})/);
  const t = Date.parse(String(at ?? ""));
  if (!m || !Number.isFinite(t)) return false;
  const j = new Date(t + 9 * 3600e3);
  const y = j.getUTCFullYear(), mo = Number(m[1]), d = Number(m[2]);
  const yy = mo < j.getUTCMonth() + 1 - 6 ? y + 1 : y;
  return Date.UTC(yy, mo - 1, d) >= Date.UTC(y, j.getUTCMonth(), j.getUTCDate());
}
/**
 * 直しが入った日の表（11/23 統括役・作業員L の案）: 作業員が分かる物（スイッチの既定 on の日・コミットの日）だけ。分からない物は載せない。
 *   ids は「その直しで今は直っている」と作業員が実物で確かめた番だけ（直しの名前だけで番を推し量らない）。since より前の番だけ印を付ける
 */
export type FixedSince = { name: string; since: string; ids: number[]; by: string; how: string };
export const FIXED_SINCE: FixedSince[] = [
  { name: "pickup_unless_ack（学習ルールの重ね・返信の質 9〜10巡目）", since: "2026-10-08T04:44:36Z", ids: [3733], by: "作業員L", how: "コミット f137f7a44（10/08 13:44 JST）に pickup_unless_ack が初めて入った・3733（09/27）は今のコードでは直っている（L の確かめ）" },
];
/** 直しが入った日より前で、作業員が直っていると確かめた番（純関数） */
export function fixedSinceOf(rows: ReadonlyArray<{ id: number; at: string }>, table: readonly FixedSince[] = FIXED_SINCE): Map<number, string> {
  const out = new Map<number, string>();
  for (const r of rows) {
    const t = Date.parse(r.at.length <= 16 ? `${r.at}:00Z` : r.at);
    const f = table.find((x) => x.ids.includes(r.id) && Number.isFinite(t) && t < Date.parse(x.since));
    if (f) out.set(r.id, f.name);
  }
  return out;
}
/** 時刻で送る AIX の種類（11/23 統括役の決め・作業員A の 7444: 内覧の当日のご挨拶は約24時間後の当日の朝に手打ち＝了承への返しではない） */
export const TIMED_AIX_KINDS = new Set(["greeting_viewing"]);
/** お客様が物件を送ってきた印（K2 の COMBINED_PROMISE_CHECK_FIRST・作業員A の数え方と同じ網: URL・物件名・画像） */
export const BROUGHT_SHAPE_RE = /https?:\/\/|物件名|^\[画像\]/;
/**
 * 名前の付いた形「確認の約束が開いている×お客様が了承に少し足した」（純関数・11/23 統括役の決め・作業員A の scratchpad/a1/shapes.ts と同じ5つ）:
 *   こちらの直前24時間に確認の約束（prevPromise に property_check_result）・連投の文が了承だけではない（isAckOnlyTurn=false）・問いなし・合わせて80字以内・お礼か了承の語がある
 */
export function ackPlusCheckPromiseOf(burstText: string, prevPromise: readonly string[]): boolean {
  const t = String(burstText ?? "");
  return prevPromise.includes("property_check_result") && !isAckOnlyTurn(t) && !/[?？]|ですか|ますか|でしょうか/.test(t) && t.length <= 80
    && /ありがと|よろしく|宜しく|わかりました|分かりました|了解|承知|かしこまり|お願い/.test(t);
}
export const DIM_JA: Record<MapDim, string> = { kind: "AIX の種類", scene: "場面", miss: "外れの型", cause: "原因", station: "駅" };

export type MapRootDef = {
  metric: string; label: string; writerSelect: WriterSelect; windowDays: number;
  dims: MapDim[];
  /** 子の割り方を作る道具（無い根は数だけ並べる＝割り方はまだ） */
  builder: "conductor_aix" | "aix_turn_device" | "route_next" | "route_progress" | "closing" | "closing_early" | "promise_map" | null;
  /** 一致（ok）の言い方（毎朝の1枚）: 既定は「竹内さんと同じ一手」 */
  okLabel?: string;
  /** 外れの言い方（okLabel と組・既定は「進まなかった」） */
  missLabel?: string;
  /** 主の根（同じ数の版が2つある時に先に出す・順位の元）。compare は並べて見る相手の根 */
  primary?: boolean; compare?: string;
  /** 作業の葉・試験の問題の葉が別の根の名前で書かれている時の、その根（端末の版は文の癖の版の葉の鍵で作業と試験の問題を受ける） */
  rebaseFrom?: string[];
  /** 数の出所（数え方を勝手に作らない） */
  source: string; owner: string;
  /** quality_daily の範囲（scope） */
  qdScope: "takeuchi" | "all" | "draft";
  /** metric を前方一致の名前の束として読む（欄ごとの数がまとめて増える根） */
  prefix?: boolean;
};
/** 根の表（数の名前と割り方）。数え方は出所のスクリプトと同じ物だけを置く */
export const MAP_ROOTS: MapRootDef[] = [
  // 2026-11-23 統括役（2回目）: 主は端末の版（下の aix_turn:match_60d_device）。文の癖の版は「並べて見る」用
  { metric: "core:conductor_aix_60d", label: "AIX の番の一致（文の癖で選んだ竹内さんの番・60日・送る直前の判断・並べて見る用）", writerSelect: "style", windowDays: 60, dims: ["kind", "scene", "miss", "cause"], builder: "conductor_aix", compare: "aix_turn:match_60d_device",
    source: "scripts/check-conductor.ts --days=60 の aixScore（core:conductor_aix の 60日版・11/23 の 44.8%＝43/96）", owner: "作業員A", qdScope: "all" },
  // 11/23（2回目・統括役）: 作業員A の端末の欄（check-conductor の devOf・*Device）で毎晩作れる端末の版。2段・手打ちは数えない（A の audit-aix-turn-judgment の 56/102 とは数え方が違う＝混ぜない）
  { metric: "core:conductor_aix_device", label: "AIX の番の一致（端末の記録で選んだ竹内さんの番・check-conductor の *Device・60日・毎晩）", writerSelect: "device", windowDays: 60, dims: ["kind", "scene", "miss", "cause"], builder: "conductor_aix",
    compare: "aix_turn:match_60d_device", rebaseFrom: ["aix_turn:match_60d_device", "core:conductor_aix_60d"],
    source: "scripts/check-conductor.ts --days=60 の aixScoreDevice（作業員A の devOf・turnsDevice）", owner: "作業員A", qdScope: "all" },
  { metric: "core:conductor_aix", label: "AIX の番の一致（7日・毎朝の芯）", writerSelect: "style", windowDays: 7, dims: [], builder: null,
    source: "scripts/check-conductor.ts（self-improve の芯 ④）", owner: "作業員N", qdScope: "all" },
  { metric: "growth:combo:組の一致", label: "返信と AIX の組の一致（竹内さん本人の番・14日）", writerSelect: "style", windowDays: 14, dims: [], builder: null,
    source: "scripts/lib/combo-daily.ts（self-improve の伸びしろ）", owner: "作業員A", qdScope: "takeuchi" },
  { metric: "reply_match", label: "返信の一致（竹内さんの番・1日）", writerSelect: "style", windowDays: 1, dims: [], builder: null,
    source: "self-improve measureDay（line_watch_turns の verdict）", owner: "作業員N", qdScope: "takeuchi" },
  // 2026-11-23 作業員R（台帳 #608）: 申込までの地図の候補と竹内さんの一手の一致（60日・申込以降を外した 84会話 262番で 151＝58%）。quality_daily にはまだ書かれていない（R が書く名前をここに合わせる）
  // 11/23 竹内さんの決定（KB 2d1c4c74・地図は道筋・一手はブレイン）: 申込までの地図の主の見方は「一手の後に駅が申込に近づいたか・分かれ道から本線に戻れたか」の進み。一致の数は並べて見る側へ
  //   今の数は送った一手（竹内さん本人）の後の進み（R の json の outcome・after）。ブレインの一手と竹内さんの一手が同じ番の進みは作業員A の route:station:<駅>:progress_brain_same が揃ってから
  { metric: "route:progress_60d", label: "申込までの地図 › 一手の後に駅が申込に近づいた・分かれ道から本線に戻れた割合（60日）", writerSelect: "all", windowDays: 60, dims: ["station", "miss"], builder: "route_progress",
    primary: true, compare: "route:next_match_60d", okLabel: "申込に近づいた（分かれ道は本線に戻れた）", source: "scripts/audit-route-progress-takeuchi.ts の outcome・after（作業員A が持ち主・11/23 統括役）", owner: "作業員A", qdScope: "takeuchi" },
  //   11/23（2回目）: 駅 → 外れの型 → 原因 に割った（R の json の agree・route_next）。11/23 竹内さんの決定で並べて見る側
  { metric: "route:next_match_60d", label: "申込までの地図 › 候補と竹内さんの一手の一致（60日・並べて見る用）", writerSelect: "all", windowDays: 60, dims: ["station", "miss", "cause"], builder: "route_next", compare: "route:progress_60d",
    source: "scripts/audit-route-progress-takeuchi.ts（作業員R・0c4f04c5d・messages.staff_writer=takeuchi）", owner: "作業員R", qdScope: "takeuchi" },
  // 2026-11-23 作業員A（a-aix-1123・9b02a11eb）: 端末の記録で選んだ竹内さん本人の AIX の番（60日・2段・手打ちも数える別の数え方）102番中 56＝54.9%。style の 44.8% と混ぜない
  //   11/23（2回目）: 主の根。種類 → 場面 → 外れの型 → 原因 に割った（aix_turn_device・A の json の行＋見張りの scene_key）
  { metric: "aix_turn:match_60d_device", label: "AIX の番の一致（端末の記録で選んだ竹内さんの番・2段と手打ちも数える・60日・主）", writerSelect: "device", windowDays: 60, dims: ["kind", "scene", "miss", "cause"], builder: "aix_turn_device",
    primary: true, compare: "core:conductor_aix_60d", rebaseFrom: ["core:conductor_aix_60d"],
    source: "scripts/audit-aix-turn-judgment.ts（作業員A・枝 a-aix-1123）", owner: "作業員A", qdScope: "takeuchi" },
  // 2026-11-23 作業員N2: 作業員L の統括→書き手の欄ごとの届き方（#466・#7）。欄の名前は前方一致でまとめて並べる（scope=draft）
  { metric: "writer_link:", label: "統括 → 書き手の届き方（欄ごと・72時間）", writerSelect: "all", windowDays: 3, dims: [], builder: null, prefix: true,
    source: "self-improve（作業員N2・writer_link:field:<欄>:delivered／in_draft・writer_link:brief:<欄>:in_draft・writer_link:timeline:<欄>:to_brain／to_writer）", owner: "作業員L", qdScope: "draft" },
  // 2026-11-23 作業員M（#619・#620）: 申込までの地図の駅 › 駅の中の状態の食い違い（2版の網 34/102）・判断の記録の段（digest.sg）との一致（105/193＝54%）。毎日の数はまだ
  { metric: "route:substate_mismatch_v2", label: "申込までの地図 › 駅の中の状態と地図の駅の食い違い（2版の網・60日・0 に向かう）", writerSelect: "all", windowDays: 60, dims: [], builder: null,
    source: "scripts/audit-route-progress-takeuchi.ts の json に route-record.ts の表を当てた数（作業員M・#619）", owner: "作業員M", qdScope: "takeuchi" },
  { metric: "route:sg_match", label: "申込までの地図 › 地図の駅と判断の記録の段（digest.sg）の一致（sg の時代＝11/03 05:41Z 以降だけ）", writerSelect: "all", windowDays: 60, dims: [], builder: null,
    source: "作業員R・M の突き合わせ（sameStation で駅の id に寄せて比べる・#620）", owner: "作業員M", qdScope: "takeuchi" },
  // 2026-11-23 作業員K2（台帳 #442）: 返信の文 › 約束 › 言い直し › AI だけ（30日 338番中 12番・0〜2 に向かう・PROMISE_RESTATE_MARK）。毎日の数はまだ（K2 が夜に作る候補の名前）
  { metric: "growth:restate:AIだけ", label: "返信の文 › 約束 › 言い直し › AI だけがした番（30日・0 に向かう）", writerSelect: "all", windowDays: 30, dims: [], builder: null,
    source: "scripts/audit-promise-restate.ts の「AI だけ restate」（作業員K2）", owner: "作業員K2", qdScope: "all" },
  // 2026-11-23 作業員G の頼み（物件検索 › 統括Pro の質・台帳 #474）: quality_daily の metric 名そのまま・scope all・毎晩 supervisor-think が書く
  { metric: "search_found_ok:realpro", label: "物件検索 › 統括Pro の質 › 土台 F の ✓の割合（realpro・1.0 に近づく）", writerSelect: "all", windowDays: 1, dims: [], builder: null, source: "cron/supervisor-think", owner: "作業員G", qdScope: "all" },
  { metric: "search_found_critical:realpro", label: "物件検索 › 統括Pro の質 › 重要欠の数（realpro・0 に向かう）", writerSelect: "all", windowDays: 1, dims: [], builder: null, source: "cron/supervisor-think", owner: "作業員G", qdScope: "all" },
  { metric: "search_pro_completion:realpro", label: "物件検索 › 統括Pro の質 › 自動モード完成度（realpro・/100）", writerSelect: "all", windowDays: 1, dims: [], builder: null, source: "cron/supervisor-think", owner: "作業員G", qdScope: "all" },
  { metric: "search_pro_misjudge", label: "物件検索 › 統括Pro の質 › 判定の外れ（段A 凍結10件・0 が良い）", writerSelect: "all", windowDays: 1, dims: [], builder: null, source: "search-pro-exam", owner: "作業員G", qdScope: "all" },
  // 2026-11-23 竹内さん（P0・台帳 #658）「クロージングする際はちゃんと決めに行く、チャンス見極める能力…人間を超えるように徹底的に強化」:
  //   主は「決めに行くべき番（竹内さん本人が決めに行った番）でブレインも決めに行ったか」。早すぎ（ブレインだけ決めに行った）は並べて見る根。出所は scripts/audit-closing-takeuchi.ts
  { metric: "route:closing", label: "決めに行く › 竹内さんが決めに行った番でブレインも決めに行った割合（60日・端末の記録）", writerSelect: "device", windowDays: 60, dims: ["kind", "scene", "miss", "cause"], builder: "closing",
    primary: true, compare: "route:closing_early", okLabel: "ブレインも決めに行った", missLabel: "見逃し（竹内さんは決めに行った・ブレインは待った）", source: "scripts/audit-closing-takeuchi.ts（作業員P・#658・app/lib/closing-chance.ts）", owner: "作業員P", qdScope: "takeuchi" },
  { metric: "route:closing_early", label: "決めに行く › ブレインが決めに行った番で竹内さんも決めに行った割合（早すぎの裏・60日）", writerSelect: "device", windowDays: 60, dims: ["kind", "scene", "miss", "cause"], builder: "closing_early",
    compare: "route:closing", source: "scripts/audit-closing-takeuchi.ts", owner: "作業員P", qdScope: "takeuchi" },
  // 2026-11-23 作業員L（約束の分野・KB 0f38f47f「申込までの地図の型をほかの分野にも」）: 竹内さん本人の約束のうち期限の内に果たした割合（pickup/check/estimate・期限前は外す）。
  //   木は L の scripts/audit-promise-map.ts --out の turns をそのまま受ける（枝 l1123-promise-map・main に入るまでは台本が無い＝前の木を読む）
  { metric: "promise:kept_true", label: "約束 › 竹内さん本人の約束を期限の内に果たした割合（60日）", writerSelect: "device", windowDays: 60, dims: ["kind", "scene", "miss", "cause"], builder: "promise_map",
    primary: true, okLabel: "期限の内に果たした", missLabel: "遅れた・果たしていない", source: "scripts/audit-promise-map.ts（作業員L・scripts/lib/promise-map.ts）", owner: "作業員L", qdScope: "takeuchi" },
  // 2026-11-23 作業員A（#479）: 物件ピックアップで選んだ理由が付いた割合（7日 14/30＝46.7%・前 40.6%）。欠け16の葉: 画像送りで判定の札にする所が無い 10（SIP_JUDGE 既定 off の側）・手で選んで資料も画像の読みも無い 4・条件の欄が空 1・売上サポの「送った」の印が無い（連携の切れ目）1
  { metric: "growth:pickup_select:", label: "物件ピックアップ › 選んだ理由が付いた割合（7日・欄ごと）", writerSelect: "all", windowDays: 7, dims: [], builder: null, prefix: true, source: "scripts/audit-pickup-select-link.ts（作業員A・growth:pickup_select:理由あり）", owner: "作業員A", qdScope: "all" },
  // 2026-11-23 作業員A（#662 統括の受け持ち表・scripts/lib/conductor-duty.ts）: 土台ごとに 持つ／使う／反映 が連携の地図でつながっている数（毎朝の芯）
  { metric: "core:conductor_duty:", label: "統括の受け持ち › 土台ごとに持つ・使う・反映がつながっている数（have／use／reflect）", writerSelect: "all", windowDays: 1, dims: [], builder: null, prefix: true, source: "scripts/lib/conductor-duty.ts（作業員A・#662）", owner: "作業員A", qdScope: "all" },
  // 2026-11-23 作業員N2 の名前の候補（統括役経由）: 前方一致の束で並べる（書くのは N2・名前が決まったらここを合わせる。範囲は仮）
  { metric: "route:sg_match:", label: "申込までの地図 › 地図の駅と判断の記録の段の一致（駅ごと）", writerSelect: "all", windowDays: 60, dims: [], builder: null, prefix: true, source: "作業員N2 の候補（route:sg_match:<駅>）", owner: "作業員N2", qdScope: "takeuchi" },
  { metric: "foundation:link:", label: "土台 › 連携（作った部品が本番に届いているか・欄ごと）", writerSelect: "all", windowDays: 3, dims: [], builder: null, prefix: true, source: "作業員N2 の候補（foundation:link:*）", owner: "作業員N2", qdScope: "all" },
  { metric: "foundation:promise:", label: "土台 › 約束（開いている約束の読み・欄ごと）", writerSelect: "all", windowDays: 3, dims: [], builder: null, prefix: true, source: "作業員N2 の候補（foundation:promise:*）", owner: "作業員N2", qdScope: "all" },
];
export const rootOf = (metric: string) => MAP_ROOTS.find((r) => r.metric === metric) ?? null;

/** 1番（純）: 木に入れる単位 */
export type MapTurn = { id: number | string; kind: string; scene: string; miss: MapMiss; cause: MapCause | null; station?: string };

/** 見張りの scene_key（返信:条件提示・AIX:estimate_sheet など）を KB_SCENES の鍵に（純関数）。AIX: で始まる鍵はブレインの一手から来た物＝AIX の種類で場面に寄せる */
export function sceneOfWatchKey(sceneKey: string | null | undefined, aixKind?: string | null): string {
  const s = String(sceneKey ?? "");
  const byKind = (k: string): string => {
    if (/^property_check|^acknowledge_check/.test(k)) return "property_share";
    if (/^property(_send|_recommendation)?$|zenryoku|pickup/.test(k)) return "property_send";
    if (/estimate|cost/.test(k)) return "cost";
    if (/viewing|meeting_place/.test(k)) return "viewing";
    if (/application|guarantor|screening/.test(k)) return "apply";
    if (/condition/.test(k)) return "conditions";
    return "other";
  };
  if (s.startsWith("AIX:")) return byKind(s.slice(4));
  const r = s.replace(/^返信:/, "");
  if (/条件/.test(r)) return "conditions";
  if (/質問|意図:question|意図:consultation/.test(r)) return "question";
  if (/了承|お礼|意図:chat|意図:positive/.test(r)) return "ack";
  if (/検討|保留|意図:negative|断り|キャンセル/.test(r)) return "considering";
  if (/持ち込み|物件への反応|意図:desire/.test(r)) return "property_share";
  if (/内覧/.test(r)) return "viewing";
  if (/費用|見積/.test(r)) return "cost";
  if (/申込|審査/.test(r)) return "apply";
  if (!s && aixKind) return byKind(aixKind);
  return "other";
}

export type MapNode = {
  key: string; parent: string | null; depth: number; dim: MapDim | null; val: string | null; label: string;
  n: number; ok: number; misses: number; value: number | null;
};
const pct1 = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : null);
const valJa = (dim: MapDim, v: string) => (dim === "miss" ? MAP_MISS_JA[v as MapMiss] ?? v : dim === "cause" ? MAP_CAUSE_JA[v as MapCause] ?? v : v);

/** 木を作る（純関数）。miss=ok の番には原因の子を作らない（一致の葉）。子の n・外れを足すと親に戻る形 */
export function buildTree(turns: readonly MapTurn[], def: Pick<MapRootDef, "metric" | "label" | "dims">): MapNode[] {
  const out: MapNode[] = [];
  const walk = (rows: readonly MapTurn[], key: string, parent: string | null, depth: number, dim: MapDim | null, val: string | null, label: string) => {
    const ok = rows.filter((r) => r.miss === "ok").length;
    out.push({ key, parent, depth, dim, val, label, n: rows.length, ok, misses: rows.length - ok, value: pct1(ok, rows.length) });
    const next = def.dims[depth];
    if (!next || !rows.length) return;
    if (next === "cause" && val === "ok") return;
    const groups = new Map<string, MapTurn[]>();
    for (const r of rows) { const v = next === "cause" ? String(r.cause ?? "misread") : String(r[next] ?? "other"); groups.set(v, [...(groups.get(v) ?? []), r]); }
    for (const [v, rs] of [...groups].sort((a, b) => b[1].length - a[1].length)) walk(rs, `${key}/${next}=${v}`, key, depth + 1, next, v, `${DIM_JA[next]}: ${valJa(next, v)}`);
  };
  walk(turns, def.metric, null, 0, null, null, def.label);
  return out;
}

/** 子を足すと親に戻るか（純関数）。合わない親を返す＝数え方の誤り */
export function sumMismatches(nodes: readonly MapNode[]): Array<{ key: string; n: number; childN: number; misses: number; childMisses: number }> {
  const kids = new Map<string, MapNode[]>();
  for (const x of nodes) if (x.parent) kids.set(x.parent, [...(kids.get(x.parent) ?? []), x]);
  const bad: Array<{ key: string; n: number; childN: number; misses: number; childMisses: number }> = [];
  for (const x of nodes) {
    const ks = kids.get(x.key);
    if (!ks?.length) continue;
    const childN = ks.reduce((s, k) => s + k.n, 0), childMisses = ks.reduce((s, k) => s + k.misses, 0);
    if (childN !== x.n || childMisses !== x.misses) bad.push({ key: x.key, n: x.n, childN, misses: x.misses, childMisses });
  }
  return bad;
}
export const leavesOf = (nodes: readonly MapNode[]) => { const ps = new Set(nodes.map((x) => x.parent).filter(Boolean)); return nodes.filter((x) => !ps.has(x.key)); };
/** a は b の祖先か本人か（葉の鍵の前方一致・段の区切りで） */
export const covers = (anc: string, key: string) => key === anc || key.startsWith(`${anc}/`);

/** 見込みの付いた作業（work_items の見込みの欄の抜き） */
export type ForecastItem = {
  id: number; title: string; stage: string; owner: string | null; priority: number | null; switch_name: string | null; switch_default: string | null;
  next_step: string | null; blocker: string | null;
  forecast_metric: string | null; forecast_leaf: string | null; forecast_writer_select: string | null;
  forecast_before: number | null; forecast_low: number | null; forecast_high: number | null;
  /** 部品（forecast_exam.parts）から作った作業: その葉で直る番の数（直る見込み＝fixes ÷ 部品の葉の外れ） */
  fixes?: number | null;
};
/** 作業1つが直せる見込み（外れの番のうち直る割合・純関数）。幅の真ん中で見る。幅が無い・前が無いは null */
export function fixShareOf(it: Pick<ForecastItem, "forecast_before" | "forecast_low" | "forecast_high">): number | null {
  const b = it.forecast_before, lo = it.forecast_low, hi = it.forecast_high;
  if (b == null || lo == null || hi == null || b >= 100) return null;
  return Math.max(0, Math.min(1, ((lo + hi) / 2 - b) / (100 - b)));
}

export const MIN_N = 5; // n がこれ未満の葉は判断保留（順位で過大に扱わない）
export const HOLE_MISSES = 3; // 作業の無い葉で外れがこれ以上なら穴
export type RankedLeaf = MapNode & {
  hold: boolean; hole: boolean; /** 穴を知らせる鍵（葉そのものか、外れを足すと線を越える場面・駅の段）*/ holeKey: string | null; items: number[]; fixShare: number; gain: number; cost: number; score: number; rank: number;
  nextStep: string; blocker: string | null; examProblems: number;
};
const DONE = new Set(["done", "dropped"]);
/** 葉の順位（純関数）: 伸びしろ＝外れ × 直せる見込み（作業の見込み・無ければ 0.5 の仮）・費用＝作る段の遠さ・止まっていれば半分・n が小さいと 0.3倍 */
export function rankLeaves(nodes: readonly MapNode[], items: readonly ForecastItem[], o: { examByLeaf?: Map<string, number>; writerSelect?: WriterSelect } = {}): RankedLeaf[] {
  // 11/23 作業員A の案: 竹内さんの決定で正解を改めた番（miss=decided）は外れの順位・穴に入れない（別に数える）
  const leaves = leavesOf(nodes).filter((l) => l.misses > 0 && ![...SET_ASIDE_MISS].some((m) => l.key.includes(`/miss=${m}`)));
  const live = items.filter((it) => !DONE.has(it.stage) && (!o.writerSelect || !it.forecast_writer_select || it.forecast_writer_select === o.writerSelect || it.forecast_writer_select === "all"));
  const costOf = (stage: string) => (stage === "passed" || stage === "on" ? 0.5 : stage === "testing" || stage === "built_off" ? 1 : stage === "building" ? 1.5 : 2);
  const ranked = leaves.map((l) => {
    const its = live.filter((it) => { const at = it.forecast_leaf ?? it.forecast_metric; return !!at && covers(at, l.key); })
      // 11/23（2回目）: 葉に近い（段の深い）作業を先に＝次の一手はその葉の持ち主の作業。同じ深さは直る見込みの大きい順
      .sort((a, b) => String(b.forecast_leaf ?? "").split("/").length - String(a.forecast_leaf ?? "").split("/").length || (fixShareOf(b) ?? 0) - (fixShareOf(a) ?? 0));
    const partShare = (it: ForecastItem) => { if (it.fixes == null) return null; const at = nodes.find((x) => x.key === it.forecast_leaf); return at && at.misses ? Math.min(1, it.fixes / at.misses) : null; };
    const shares = its.map((it) => partShare(it) ?? fixShareOf(it)).filter((x): x is number => x != null);
    const fixShare = shares.length ? Math.max(...shares) : 0.5;
    // 判断保留: 原因の葉の n は外れの数そのもの＝割合の重みは場面の段（種類×場面）の n で見る。外れが 2 以下か、場面の段の n が MIN_N 未満
    const sceneAnc = nodes.find((x) => (x.dim === "scene" || x.dim === "station") && covers(x.key, l.key)) ?? l;
    const hold = l.misses < HOLE_MISSES || sceneAnc.n < MIN_N;
    // 根だけに付いた見込み（数全体の見込み）は葉の担当にならない＝種類より下に付いた作業が無ければ穴（11/23 統括役「担当も見込みも無い大きな葉は穴」）
    const specific = its.filter((it) => String(it.forecast_leaf ?? "").includes("/"));
    // 11/23（2回目）: 葉が細かく割れて1葉の外れが線に届かない時は、場面（駅）の段の外れの合計で見る（穴は場面の鍵で知らせる＝同じ場面の葉を重ねて数えない）
    const kindAnc = nodes.find((x) => x.depth === 1 && covers(x.key, l.key)) ?? l;
    const holeAt = [l, sceneAnc, kindAnc].find((x) => x.misses >= HOLE_MISSES) ?? null;
    const hole = !specific.length && !!holeAt;
    const holeKey = hole && holeAt ? holeAt.key : null;
    const best = specific[0] ?? its[0] ?? null;
    const cost = best ? costOf(best.stage) : 2;
    const blocker = its.find((it) => it.blocker || it.stage === "blocked" || it.stage === "waiting_owner")?.blocker ?? (its.some((it) => it.stage === "waiting_owner") ? "竹内さん待ち" : its.some((it) => it.stage === "blocked") ? "止まっている" : null);
    const gain = Math.round(l.misses * fixShare * 10) / 10;
    const score = Math.round((gain / cost) * (hold ? 0.3 : 1) * (blocker ? 0.5 : 1) * 100) / 100;
    // 試験の問題: 葉か、葉の上の場面の段に当てた問題（種類までの問題は場面が分からない＝数えない）
    const examProblems = o.examByLeaf ? [...o.examByLeaf].filter(([k]) => k.includes("/scene=") && (covers(k, l.key) || covers(l.key, k))).reduce((s, [, n]) => s + n, 0) : 0;
    const nextStep = hole ? `穴: 作業も見込みも無い（外れ ${l.misses}）→ 統括役が持ち主を決め、外れの番を実物で読む`
      : best ? `#${best.id}${best.switch_name ? ` ${best.switch_name}` : ""}（${best.stage}）: ${String(best.next_step ?? "次の一手が書かれていない").slice(0, 70)}`
      : `外れ ${l.misses}（穴の線 ${HOLE_MISSES} 未満）→ 次の夜に増えるか見る`;
    return { ...l, hold, hole, holeKey, items: its.map((it) => it.id), fixShare: Math.round(fixShare * 100) / 100, gain, cost, score, rank: 0, nextStep, blocker, examProblems };
  });
  ranked.sort((a, b) => b.score - a.score || b.misses - a.misses);
  ranked.forEach((r, i) => { r.rank = i + 1; });
  return ranked;
}

/** 見込みの突き合わせ（純関数）: 幅の中か外か */
export type ForecastVerdict = "in" | "below" | "above" | "pending";
export function forecastVerdictOf(low: number | null, high: number | null, measured: number | null, n: number | null, minN = MIN_N): ForecastVerdict {
  if (measured == null || low == null || high == null || (n ?? 0) < minN) return "pending";
  return measured < low ? "below" : measured > high ? "above" : "in";
}
/** 本番に入った時から 7日・14日の突き合わせの頃か（純関数）。済んだ日数は checkedDays に */
export function dueChecksOf(startAtMs: number | null, nowMs: number, checkedDays: readonly number[]): number[] {
  if (!startAtMs) return [];
  const d = (nowMs - startAtMs) / 86_400_000;
  return [7, 14].filter((k) => d >= k && !checkedDays.includes(k));
}
/** 外れの原因の候補（純関数）: 作業の葉の下で、後の木に残った外れの一番多い原因 */
export function gapCauseHintOf(afterNodes: readonly MapNode[], leafKey: string): MapCause | null {
  const c: Record<string, number> = {};
  for (const l of leavesOf(afterNodes)) if (covers(leafKey, l.key) || covers(l.key, leafKey)) if (l.dim === "cause" && l.val) c[l.val] = (c[l.val] ?? 0) + l.misses;
  const top = Object.entries(c).sort((a, b) => b[1] - a[1])[0];
  return top ? (top[0] as MapCause) : null;
}

// ── 試験の問題と葉（11/23 統括役: 試験の側も同じ地図を読み書きする）──
/** 試験の問題1つ（spec.json の抜き） */
export type ExamProblemLite = { id: string; type?: string; accept?: string[]; mustNot?: string[]; conv?: string; at?: string };
/** 問題の正解の AIX の種類（純関数）。accept の「AIX:<種類>」から。返信・2段・左右だけの問題は null（AIX の番の木では当たらない） */
export function examAixKindOf(p: ExamProblemLite): string | null {
  for (const a of p.accept ?? []) {
    const m = /^AIX:([a-z_]+)/.exec(a);
    if (m && m[1] !== "左右") return m[1] === "property_send" || m[1] === "property_recommendation" ? "property" : m[1];
  }
  return null;
}
/** 問題を AIX の番の木の葉（種類／場面まで）に当てる（純関数）。場面は問題の番の見張りの scene_key から */
export function examLeafOf(p: ExamProblemLite, root: string, watchSceneKey: string | null): { leaf: string | null; how: string } {
  const kind = examAixKindOf(p);
  if (!kind) return { leaf: null, how: "正解に AIX の種類が無い（返信・2段・左右）" };
  if (!watchSceneKey) return { leaf: `${root}/kind=${kind}`, how: "種類まで（見張りの番が見つからない）" };
  return { leaf: `${root}/kind=${kind}/scene=${sceneOfWatchKey(watchSceneKey, kind)}`, how: "種類×場面（見張りの番の scene_key）" };
}
/** 試験の結果を葉に戻す（純関数）: 問題ごとの前後の○を葉ごとに足す */
export function examResultsByLeaf(links: ReadonlyArray<{ problem_id: string; leaf_key: string }>, before: Map<string, boolean>, after: Map<string, boolean>) {
  const by = new Map<string, { n: number; before_ok: number; after_ok: number; worse: string[]; better: string[] }>();
  for (const l of links) {
    if (!after.has(l.problem_id)) continue;
    const o = by.get(l.leaf_key) ?? { n: 0, before_ok: 0, after_ok: 0, worse: [], better: [] };
    const b = before.get(l.problem_id), a = after.get(l.problem_id)!;
    o.n++; if (b) o.before_ok++; if (a) o.after_ok++;
    if (b === true && !a) o.worse.push(l.problem_id); if (b === false && a) o.better.push(l.problem_id);
    by.set(l.leaf_key, o);
  }
  return by;
}
/** 試験の順番の案（純関数・既定 off の EXAM_ORDER_BY_MAP で使う）: 伸びしろの大きい葉の問題を先に */
export function examOrderByMap(problemIds: readonly string[], linkOf: Map<string, string>, ranked: readonly RankedLeaf[]): string[] {
  const scoreOf = (pid: string) => { const k = linkOf.get(pid); if (!k) return 0; return Math.max(0, ...ranked.filter((r) => covers(k, r.key) || covers(r.key, k)).map((r) => r.score)); };
  return [...problemIds].sort((a, b) => scoreOf(b) - scoreOf(a));
}
export const examOrderByMapOn = (env: Record<string, string | undefined> = process.env) => (env.EXAM_ORDER_BY_MAP ?? "off").toLowerCase() === "on";

/** 関わる土台の空き（作業員N の quality_daily found:<土台id>:<場面>:<欄>・value=0 が空き）を、同じ場面の葉に並べる（純関数） */
export function relatedFoundationOf(leafKey: string, rows: ReadonlyArray<{ metric: string; value: number | null; detail?: { cause?: string } | null }>): string[] {
  const scene = /\/scene=([^/]+)/.exec(leafKey)?.[1] ?? null;
  return rows.filter((r) => {
    const m = /^found:([^:]+):([^:]+):([^:]+)$/.exec(r.metric);
    if (!m || r.value !== 0) return false;
    if (r.detail?.cause && !["material", "misread"].includes(r.detail.cause)) return false;
    return m[2] === "all" || (scene != null && m[2] === scene);
  }).map((r) => r.metric);
}

// ── 2026-11-23 統括役（2回目）: 端末の版の木・申込までの地図の木・根の付け替え ──
/** 葉の鍵の根を付け替える（純関数）。from の根で書かれた葉を to の根の葉に */
export const rebaseKey = (key: string, from: string, to: string) => (key === from ? to : key.startsWith(`${from}/`) ? `${to}${key.slice(from.length)}` : key);

/** 根の作業の一覧（純関数）: 付け替え元の根の作業も、葉の鍵を付け替えて受ける。forecast_exam.parts は部品ごとの作業にする（fixes 付き） */
export function itemsForRoot<T extends ForecastItem>(items: readonly T[], def: Pick<MapRootDef, "metric" | "rebaseFrom">): T[] {
  const roots = [def.metric, ...(def.rebaseFrom ?? [])];
  const rootOfKey = (k: string | null | undefined) => roots.find((r) => k === r || String(k ?? "").startsWith(`${r}/`)) ?? null;
  const out: T[] = [];
  for (const it of items) {
    const leaf = it.forecast_leaf ?? it.forecast_metric;
    const r = rootOfKey(leaf) ?? (roots.includes(String(it.forecast_metric)) ? String(it.forecast_metric) : null);
    if (!r) continue;
    const parts = (((it as { forecast_exam?: unknown }).forecast_exam ?? null) as { parts?: Array<{ leaf: string; fixes: number }> } | null)?.parts ?? [];
    if (parts.length) {
      for (const p of parts) { const pr = rootOfKey(p.leaf); if (pr) out.push({ ...it, forecast_leaf: rebaseKey(p.leaf, pr, def.metric), fixes: p.fixes }); }
      continue;
    }
    const lr = rootOfKey(leaf);
    out.push({ ...it, forecast_leaf: lr ? rebaseKey(String(leaf), lr, def.metric) : def.metric });
  }
  return out;
}

/** 作業員A の audit-aix-turn-judgment.ts の json の1行（使う欄だけ） */
export type DeviceTurnRow = {
  id: number; cls: string; tk: string | null; v: string; bk?: string | null; prevFulfil?: boolean;
  mat?: { pend?: number; pp?: boolean; checked?: number; taskResult?: number; mk?: string[] | null; mks?: boolean } | null;
};
/**
 * 端末の版の外れの原因（純関数・仮の決め方＝外れの番を実物で読んで直す）:
 *   先後 → 読み違い（2段の決まり）。種類違い → 足りない材料の印（digest.mk / mks）があれば材料・無ければ読み違い。
 *   AIX の番を返信: 前の番の約束を果たす AIX（prevFulfil）＝この番の判断と数えてよいか揺れる → 数え方／
 *     その種類の手元の材料が判断の時点に無い（物件＝送れる候補 0 かつ pp なし・物件確認＝確認の結果 0・見積書＝mk に見積の額）か mk がある → 材料／ほかは返信か AIX かの判断の誤り
 */
export function deviceCauseOf(r: DeviceTurnRow): MapCause | null {
  if (r.v === "一致" || r.v === "返信一致") return null;
  const m = r.mat ?? {};
  const mk = (m.mk ?? []).length > 0 || m.mks === true;
  if (r.v === "先後") return "misread";
  if (r.v === "種類違い") return mk ? "material" : "misread";
  // 11/23 作業員A の読み直し: 前の約束を果たす AIX（prevFulfil）は竹内さんの決定 C でこの番の判断そのもの＝数え方で外す番ではない（前は counting にしていた）
  const k = r.tk ?? "";
  const noHand = k === "property" ? (m.pend ?? 0) === 0 && !m.pp : k === "property_check_result" ? (m.checked ?? 0) === 0 && (m.taskResult ?? 0) === 0 : k === "estimate_sheet" ? (m.mk ?? []).includes("estimate_amount") : false;
  return noHand || mk ? "material" : "aix_turn_as_reply";
}
const DEVICE_MISS: Record<string, MapMiss> = { 一致: "ok", AIXの番を返信: "reply_not_aix", 種類違い: "aix_kind", 先後: "order" };
/** A の json の行を木の番に（純関数）。AIX の番（cls が reply 以外）だけ・場面は見張りの scene_key（id で引いた物） */
export function deviceTurnsOf(rows: readonly DeviceTurnRow[], sceneKeyById: ReadonlyMap<number, string | null>, decided: ReadonlySet<number> = new Set(), minority: ReadonlySet<number> = new Set(), fixedSince: ReadonlySet<number> = new Set(), split: ReadonlySet<number> = new Set()): MapTurn[] {
  return rows.filter((r) => r.cls !== "reply").map((r) => {
    const kind = r.tk && r.tk !== "?" ? r.tk : "other";
    const miss = DEVICE_MISS[r.v] ?? "aix_kind";
    if (miss !== "ok" && decided.has(r.id)) return { id: r.id, kind, scene: sceneOfWatchKey(sceneKeyById.get(r.id) ?? null, kind), miss: "decided" as const, cause: null };
    if (miss !== "ok" && fixedSince.has(r.id)) return { id: r.id, kind, scene: sceneOfWatchKey(sceneKeyById.get(r.id) ?? null, kind), miss: "fixed_since" as const, cause: null };
    if (miss !== "ok" && TIMED_AIX_KINDS.has(kind)) return { id: r.id, kind, scene: sceneOfWatchKey(sceneKeyById.get(r.id) ?? null, kind), miss: "timed" as const, cause: null };
    if (miss !== "ok" && split.has(r.id)) return { id: r.id, kind, scene: sceneOfWatchKey(sceneKeyById.get(r.id) ?? null, kind), miss: "split" as const, cause: null };
    if (miss !== "ok" && minority.has(r.id)) return { id: r.id, kind, scene: sceneOfWatchKey(sceneKeyById.get(r.id) ?? null, kind), miss: "minority" as const, cause: null };
    return { id: r.id, kind, scene: sceneOfWatchKey(sceneKeyById.get(r.id) ?? null, kind), miss, cause: deviceCauseOf(r) };
  });
}

/** 竹内さんの決定で正解を改めた問題の番（純関数・作業員A の案 11/23）: 試験の問題（why か tags に「竹内さんの決定」）と、番を会話（頭8字）・時刻 ±2分で突き合わせる */
export function decidedTurnIdsOf(rows: ReadonlyArray<{ id: number; conv: string; at: string }>, spec: ReadonlyArray<{ id: string; conv?: string; at?: string; why?: string; tags?: unknown }>): Map<number, string> {
  const dec = spec.filter((p) => p.conv && p.at && /竹内さんの決定/.test(`${p.why ?? ""} ${JSON.stringify(p.tags ?? [])}`));
  const out = new Map<number, string>();
  for (const r of rows) {
    const t = Date.parse(r.at.length <= 16 ? `${r.at}:00Z` : r.at);
    const p = dec.find((q) => String(q.conv).slice(0, 8) === r.conv.slice(0, 8) && Math.abs(Date.parse(String(q.at)) - t) <= 120_000);
    if (p) out.set(r.id, p.id);
  }
  return out;
}

/** 作業員R の audit-route-progress-takeuchi.ts の json の1行（使う欄だけ） */
export type RouteTurnRow = { conv: string; at: string; node: string | null; branch: string | null; agree: string; dir: string | null; subAt1?: boolean | null; nextAix?: string[] };
export const ROUTE_GOOD = new Set(["aix_match", "promise_match", "reply_match", "reply_invite"]);
/**
 * 申込までの地図の外れの原因（純関数・仮の決め方）:
 *   push_missed（地図は AIX・竹内さんは返信）: 竹内さんの一手が約束（dir=promise＝2段の先の返信）なら数え方・ほかは駅の読み違い
 *   other_aix: 駅の中の状態が地図の駅と食い違う（subAt1=false）なら材料・ほかは読み違い
 *   pushed_off_map（地図は返信・竹内さんは AIX）: 地図に AIX の候補が1つも無ければ材料・あれば返信か AIX かの判断の誤り
 */
export function routeCauseOf(r: RouteTurnRow): MapCause | null {
  if (ROUTE_GOOD.has(r.agree)) return null;
  if (r.agree === "push_missed") return r.dir === "promise" ? "counting" : "misread";
  if (r.agree === "other_aix") return r.subAt1 === false ? "material" : "misread";
  if (r.agree === "pushed_off_map") return (r.nextAix ?? []).length ? "aix_turn_as_reply" : "material";
  return "counting";
}
/** R の json の行を木の番に（純関数）。駅は分かれ道があれば「分:<分かれ道>」 */
export function routeTurnsOf(rows: readonly RouteTurnRow[], decided: ReadonlySet<number> = new Set()): MapTurn[] {
  // decided は rows の並びの番号（11/23 作業員A: 竹内さんの決定で正解を改めた番は外れと別に数える＝端末の版と同じ）
  return rows.map((r, i) => ({ r, i })).filter(({ r }) => r.agree !== "no_next").map(({ r, i }) => {
    const good = ROUTE_GOOD.has(r.agree);
    return {
      id: `${r.conv}@${r.at}#${i}`, kind: "", scene: "", station: r.branch ? `分:${r.branch}` : String(r.node ?? "other"),
      miss: good ? "ok" : decided.has(i) ? "decided" : r.agree in MAP_MISS_JA ? (r.agree as MapMiss) : "other_aix", cause: good || decided.has(i) ? null : routeCauseOf(r),
    };
  });
}
/**
 * 申込までの地図の「決定で改めた番」（純関数・11/23 作業員A の当て方）: R の json の at は竹内さんの最初の通の時刻、問題の at はお客様の最後の通の時刻
 *   → 同じ会話で、問題の at より後の一番最初の番に1つだけ当てる（24時間以内）。±2分では当たらない
 */
export function decidedRouteIdxOf(rows: ReadonlyArray<{ conv: string; at: string }>, spec: ReadonlyArray<{ id: string; conv?: string; at?: string; why?: string; tags?: unknown }>): Map<number, string> {
  const out = new Map<number, string>();
  for (const p of spec) {
    if (!p.conv || !p.at || !/竹内さんの決定/.test(`${p.why ?? ""} ${JSON.stringify(p.tags ?? [])}`)) continue;
    const t = Date.parse(p.at);
    const hit = rows.map((r, i) => ({ i, d: Date.parse(r.at) - t, c: r.conv.slice(0, 8) })).filter((x) => x.c === String(p.conv).slice(0, 8) && x.d >= 0 && x.d <= 86_400_000).sort((a, b) => a.d - b.d)[0];
    if (hit && !out.has(hit.i)) out.set(hit.i, p.id);
  }
  return out;
}
/** R の json の行を進みの木の番に（純関数）: 本線の番は advanced が進んだ・分かれ道の番は番の後に本線の駅（after）へ戻れたら進んだ。決定で改めた番は外す側（decided） */
export function routeProgressTurnsOf(rows: ReadonlyArray<RouteTurnRow & { outcome?: string | null; after?: string | null; detail?: string | null }>, decided: ReadonlySet<number> = new Set()): MapTurn[] {
  return rows.map((r, i) => ({ r, i })).filter(({ r }) => r.agree !== "no_next").map(({ r, i }) => {
    const station = r.branch ? `分:${r.branch}` : String(r.node ?? "other");
    // 分かれ道の番: 作業員A の afterBranch（竹内さんの一手の後のお客様の返事で地図を当て直した分かれ道・閉じたら null）があれば null＝本線に戻れた。
    //   欄が無い番（返事が無い・前の json）は駅が進んだか（advanced）だけで見る（前の仮の数え方 after は分かれ道の番でもほぼ入っていて高すぎた）
    const ab = (r as { afterBranch?: string | null }).afterBranch;
    //   11/23 作業員A と揃えた（route-station-trust の stationStatsOf）: 進んだ＝advanced か、分かれ道の番で afterBranch が null かつ番の後の駅が本線の駅
    const ok = r.outcome === "advanced" || (!!r.branch && ab === null && "afterBranch" in r && !!r.after && MAIN_STATIONS.has(String(r.after)));
    // 内覧の予定ありの駅で内覧の日がまだ来ていない止まりは「内覧の日待ち（続く）」（N2 の照らし①・A と同じ）＝直す所ではない
    const wait = r.outcome === "stuck" && r.node === "viewing_scheduled" && !r.branch && viewingNotYetOf(r.at, r.detail);
    const miss: MapMiss = ok ? "ok" : decided.has(i) ? "decided" : wait ? "viewing_wait" : r.outcome === "engaged" ? "engaged" : r.outcome === "left" ? "left" : r.outcome === "back" ? "back" : r.branch ? "branch_stay" : "stuck";
    return { id: `${r.conv}@${r.at}#${i}`, kind: "", scene: "", station, miss, cause: null };
  });
}
/** 駅ごとの本当の一致の表（純関数）: 駅（分かれ道）ごとに n・一致・分けて外した・本当の外れ */
export function stationTableOf(nodes: readonly MapNode[]): Array<{ key: string; n: number; ok: number; aside: number; real: number }> {
  return nodes.filter((x) => x.dim === "station").map((s) => {
    const aside = nodes.filter((x) => x.parent === s.key && x.dim === "miss" && SET_ASIDE_MISS.has(x.val as MapMiss)).reduce((a, x) => a + x.n, 0);
    return { key: s.key, n: s.n, ok: s.ok, aside, real: s.misses - aside };
  }).sort((a, b) => b.real - a.real);
}

/** 穴の一覧（純関数）: 穴の鍵（葉か場面・種類の段）ごとに1つ。外れは作業の無い葉の外れの合計（作業のある葉の外れは入れない）。段の n が MIN_N 未満の穴は判断保留の印 */
export function holesOf(ranked: readonly RankedLeaf[], nodes: readonly MapNode[]): Array<{ key: string; n: number; misses: number; hold: boolean; leaves: number }> {
  const by = new Map<string, { leaves: number; misses: number }>();
  for (const r of ranked) if (r.hole && r.holeKey) { const o = by.get(r.holeKey) ?? { leaves: 0, misses: 0 }; o.leaves++; o.misses += r.misses; by.set(r.holeKey, o); }
  return [...by].map(([key, o]) => { const x = nodes.find((y) => y.key === key); return { key, n: x?.n ?? 0, misses: o.misses, hold: (x?.n ?? 0) < MIN_N, leaves: o.leaves }; }).sort((a, b) => b.misses - a.misses);
}

// ── 2026-11-23 統括役の決め: 竹内さんの少数側（一般の形）──
//   同じ形の番（竹内さんの手に依らない形）で、竹内さん本人の別の一手が過半数（n MINORITY_MIN_N 以上）なのに、この番の竹内さんは少数側の一手で、
//   ブレインは多い方の一手を選んだ外れの番＝「竹内さんの少数側」。順位と穴から外して別に数える（直すとかえって多い方を外す）。
export const MINORITY_MIN_N = 10;
/** shapes は細かい形から粗い形へ（n が minN に届く一番細かい形で数える）。kindOnly は種類違いの外れ（AIX の種類だけを比べる＝同じ形の AIX が先の番の中で過半数を見る） */
export type MoveRow = { id: number; shapes: string[]; move: string; brain: string; isMiss: boolean; kindOnly?: boolean;
  /** 名前の付いた形（統括役が決めた形・作業員A が実物で数えた形）: 細かい形の段とは別に、1つずつ同じ線（n・過半数）で見る */
  namedShapes?: string[] };
/** 少数側の番（純関数）: 形ごとの竹内さんの一手の過半数（> 50%・n ≥ minN）と、ブレインの一手が過半数で竹内さんが違う外れの番 */
export type SideMark = { side: "minority" | "split" | "n_short"; shape: string; majority: string; share: number; n: number };
/**
 * 外れの番の「竹内さんの側」の印（純関数・11/23 統括役と作業員A）:
 *   minority … 同じ形で竹内さん本人の別の一手が過半数（n ≥ minN）・ブレインは多い方 → 順位と穴の外
 *   split ……… 同じ形（n ≥ minN）で過半数が無く、上位2つの一手で 8割以上＝半分前後に割れる・ブレインはその片方 → どちらにも決めない（順位と穴の外）
 *   n_short …… どの形も n が minN に届かない（一番大きい形が 5 以上）→ 外れのまま残し、見張りで数え続ける印だけ（順位には入る）
 */
export function sideOf(rows: readonly MoveRow[], minN = MINORITY_MIN_N): Map<number, SideMark> {
  const out = new Map<number, SideMark>();
  const judge = (r: MoveRow, shape: string, pool: readonly MoveRow[]): SideMark | null | "none" => {
    const c: Record<string, number> = {};
    for (const x of pool) c[x.move] = (c[x.move] ?? 0) + 1;
    const top = Object.entries(c).sort((a, b) => b[1] - a[1]);
    const [maj, k] = top[0];
    const label = r.kindOnly ? `${shape}（AIX が先の番の中）` : shape;
    const share = Math.round((k / pool.length) * 100) / 100;
    if (k * 2 > pool.length) return r.move !== maj && r.brain === maj ? { side: "minority", shape: label, majority: maj, share, n: pool.length } : "none";
    const two = top.slice(0, 2);
    if (two.reduce((s, [, v]) => s + v, 0) >= pool.length * 0.8 && two.some(([m]) => m === r.brain)) return { side: "split", shape: label, majority: two.map(([m, v]) => `${m} ${v}`).join("／"), share, n: pool.length };
    return "none";
  };
  for (const r of rows) {
    if (!r.isMiss) continue;
    let reached = false, biggest = 0;
    const tryShapes = (shapes: readonly string[], inPool: (x: MoveRow, s: string) => boolean, stopAtFirst: boolean) => {
      for (const shape of shapes) {
        const pool = rows.filter((x) => inPool(x, shape) && (!r.kindOnly || x.move.startsWith("aix:")));
        biggest = Math.max(biggest, pool.length);
        if (pool.length < minN) continue;
        reached = true;
        const j = judge(r, shape, pool);
        if (j && j !== "none") { out.set(r.id, j); return; }
        if (stopAtFirst) return; // 届いた一番細かい形で決める（粗い形へは下りない）
      }
    };
    tryShapes(r.shapes, (x, s) => x.shapes.includes(s), true);
    if (!out.has(r.id)) tryShapes(r.namedShapes ?? [], (x, s) => (x.namedShapes ?? []).includes(s), false);
    if (!out.has(r.id) && !reached && biggest >= 5) out.set(r.id, { side: "n_short", shape: r.shapes[0], majority: "", share: 0, n: biggest });
  }
  return out;
}
/** 少数側だけ（前からの入口・sideOf の minority） */
export function minorityOf(rows: readonly MoveRow[], minN = MINORITY_MIN_N): Map<number, { shape: string; majority: string; share: number; n: number }> {
  return new Map([...sideOf(rows, minN)].filter(([, v]) => v.side === "minority").map(([k, v]) => [k, { shape: v.shape, majority: v.majority, share: v.share, n: v.n }]));
}
/** 前の minorityOf（細かい形の段と名前の付いた形）の中身。sideOf に置き換えた・比べる時だけ使う */
export function minorityOfV1(rows: readonly MoveRow[], minN = MINORITY_MIN_N): Map<number, { shape: string; majority: string; share: number; n: number }> {
  const out = new Map<number, { shape: string; majority: string; share: number; n: number }>();
  for (const r of rows) {
    if (!r.isMiss) continue;
    for (const shape of r.shapes) {
      const pool = rows.filter((x) => x.shapes.includes(shape) && (!r.kindOnly || x.move.startsWith("aix:")));
      if (pool.length < minN) continue;
      const c: Record<string, number> = {};
      for (const x of pool) c[x.move] = (c[x.move] ?? 0) + 1;
      const [maj, k] = Object.entries(c).sort((a, b) => b[1] - a[1])[0];
      if (k * 2 > pool.length && r.move !== maj && r.brain === maj) out.set(r.id, { shape: r.kindOnly ? `${shape}（AIX が先の番の中）` : shape, majority: maj, share: Math.round((k / pool.length) * 100) / 100, n: pool.length });
      break; // 届いた一番細かい形で決める（粗い形へは下りない）
    }
    if (out.has(r.id)) continue;
    for (const shape of r.namedShapes ?? []) {
      const pool = rows.filter((x) => (x.namedShapes ?? []).includes(shape) && (!r.kindOnly || x.move.startsWith("aix:")));
      if (pool.length < minN) continue;
      const c: Record<string, number> = {};
      for (const x of pool) c[x.move] = (c[x.move] ?? 0) + 1;
      const [maj, k] = Object.entries(c).sort((a, b) => b[1] - a[1])[0];
      if (k * 2 > pool.length && r.move !== maj && r.brain === maj) { out.set(r.id, { shape: r.kindOnly ? `${shape}（AIX が先の番の中）` : shape, majority: maj, share: Math.round((k / pool.length) * 100) / 100, n: pool.length }); break; }
    }
  }
  return out;
}
/** 端末の版の番の形・竹内さんの一手・ブレインの一手（純関数）。形＝場面 × 開いている約束（前の24時間のこちらの約束）× お客様の連投の型。一手は「返信が先（返信・2段）」か「AIX:<種類>」 */
export function deviceMoveRowOf(r: DeviceTurnRow & { prevPromise?: string[]; burst?: string | null; route?: string | null }, sceneKey: string | null, ctx: { brought24h?: boolean; ackPlusCheck?: boolean } = {}): MoveRow {
  const scene = sceneOfWatchKey(sceneKey, r.tk ?? null);
  const pp = [...(r.prevPromise ?? [])].sort().join("+") || "なし";
  // 形は「場面 × 開いている約束の種類 × 連投の型」→「場面 × 約束の種類」まで。場面だけ・約束の有無だけの粗い形には下りない
  //   （11/23 の試しで粗い形まで下りると、#627 で直す番〈物件の約束が開いた了承〉まで 56% の多い方で少数側に飲んだ）
  const shapes = [`${scene}|約束:${pp}|${r.burst ?? "other"}`, `${scene}|約束:${pp}`];
  const move = r.cls === "reply" || r.cls === "two_stage" ? "reply_first" : `aix:${r.tk ?? "?"}`;
  const brain = r.route === "aix" ? `aix:${r.bk ?? "?"}` : "reply_first";
  // 11/23 統括役の決め（作業員A が実物で数えた形）: 前24時間にお客様が物件を送ってきた番・お客様の問い × 物件の約束が開いている番
  const namedShapes = [ctx.brought24h ? "前24時間にお客様が物件を送ってきた" : null, r.burst === "question" && (r.prevPromise ?? []).includes("property") ? "お客様の問い×物件の約束が開いている" : null,
    ctx.ackPlusCheck ? "確認の約束が開いている×お客様が了承に少し足した" : null].filter((x): x is string => !!x);
  return { id: r.id, shapes, move, brain, isMiss: !(r.v === "一致" || r.v === "返信一致"), kindOnly: r.v === "種類違い", namedShapes };
}

// ── 2026-11-23 統括役: 毎朝の1枚に出す地図の行を、竹内さんが読む形（短い日本語・数と理由）に ──
export const KIND_JA: Record<string, string> = {
  "application_push": "申込の後押し", "application_push/push": "申込の後押し", pickup: "探す約束", check: "確認の約束", estimate: "見積の約束", hand: "手打ちで決めに行った", phone_call: "電話（審査の相談）", "phone_call/default": "電話（審査の相談）",
  property: "物件", property_check_result: "物件確認した", estimate_sheet: "見積書", viewing_invite: "内覧の誘い", greeting_viewing: "内覧当日のご挨拶",
  meeting_place: "待ち合わせ場所", zenryoku_support: "全力サポート", condition_hearing: "条件の聞き取り", acknowledge_check: "確認の了承", other: "その他",
};
export const SCENE_JA: Record<string, string> = {
  ack: "お礼・了承", question: "質問", conditions: "条件", considering: "検討中", property_share: "お客様が物件を送ってきた", property_send: "物件を送る場面",
  viewing: "内覧", cost: "費用", apply: "申込", other: "その他",
  hot: "申込予測 高い", warm: "申込予測 中", cold: "申込予測 低い", none: "申込予測 判定なし",
};
const MISS_SHORT: Record<string, string> = { reply_not_aix: "AIX の番を返信にした", aix_kind: "AIX の種類違い", order: "先後", push_missed: "地図は AIX・竹内さんは返信", other_aix: "地図と違う AIX", pushed_off_map: "地図は返信・竹内さんは AIX" };
export const STATION_JA: Record<string, string> = {
  inquiry: "問い合わせ", hearing: "聞き取り", proposing: "提案中", viewing_arrange: "内覧の調整", viewing_scheduled: "内覧の予定あり", viewed: "内覧済み", interested: "気に入った",
  estimate: "見積", pickup: "ピックアップ", apply_prep: "申込の準備", brought_property: "お客様の持ち込み", condition_change: "条件の変更", screening_concern: "審査の心配", move_in_later: "入居は先",
  considering: "検討中", other_agent_viewing: "他社で内覧", postponed: "延期", new_arrival_wait: "新着待ち", competing_estimate: "他社の見積", negotiation: "交渉", rank_offered: "順位を出した",
};
const CAUSE_SHORT: Record<string, string> = { material: "材料が届いていない", misread: "読み違い", aix_turn_as_reply: "判断の誤り", counting: "数え方" };
/** 葉の鍵を短い日本語に（純関数）: 物件 › お礼・了承 › AIX の番を返信にした › 判断の誤り */
export function leafJa(key: string): string {
  return key.split("/").slice(1).map((seg) => {
    const [d, v = ""] = seg.split("=");
    if (d === "kind") return KIND_JA[v] ?? v;
    if (d === "scene") return SCENE_JA[v] ?? v;
    if (d === "miss") return MISS_SHORT[v] ?? MAP_MISS_JA[v as MapMiss] ?? v;
    if (d === "cause") return CAUSE_SHORT[v] ?? v;
    if (d === "station") return v.startsWith("分:") ? `分かれ道「${STATION_JA[v.slice(2)] ?? v.slice(2)}」` : `駅「${STATION_JA[v] ?? v}」`;
    return v;
  }).join(" › ");
}
/** 外れの内訳（純関数）: 外れの型ごとの番の数（miss の段の n の合計）。分けて外す型と本当の外れ */
export function missBreakdownOf(nodes: readonly MapNode[]): { real: number; decided: number; minority: number; split: number; timed: number; fixed_since: number } {
  const by: Record<string, number> = {};
  for (const x of nodes) if (x.dim === "miss" && x.val && x.val !== "ok") by[x.val] = (by[x.val] ?? 0) + x.n;
  const aside = (k: string) => by[k] ?? 0;
  const total = Object.values(by).reduce((s, v) => s + v, 0);
  return { real: total - [...SET_ASIDE_MISS].reduce((s, k) => s + aside(k), 0), decided: aside("decided"), minority: aside("minority"), split: aside("split"), timed: aside("timed"), fixed_since: aside("fixed_since") };
}

// ── 2026-11-23 作業員N2 の頼み（KB 0f38f47f・穴を台帳へ自動で・統括に届いているか）──
/** 葉の持ち主の表（11/23 統括役が決めた穴の持ち主 #640〜#643・作業員の持ち場から）。上から順に、葉の鍵の中に段の値が含まれれば当たる。当たらなければ根の持ち主 */
export const LEAF_OWNER_RULES: Array<{ match: string; owner: string; why: string }> = [
  { match: "kind=zenryoku_support", owner: "作業員N2", why: "手打ちの網（aix-should-be）・数え方の持ち場（#641）" },
  { match: "scene=property_send", owner: "作業員L", why: "統括の学び（conductor_lessons）の持ち場（#642）" },
  { match: "kind=viewing_invite", owner: "作業員P", why: "#643" },
  { match: "kind=property", owner: "作業員A", why: "AIX の番の判断（物件）の持ち場（#627・#640）" },
  { match: "kind=property_check_result", owner: "作業員A", why: "#627 の部品" },
  { match: "kind=estimate_sheet", owner: "作業員A", why: "#627 の部品" },
  { match: "station=", owner: "作業員A", why: "申込までの地図の台本の持ち主（11/23 統括役）" },
];
/** 葉の持ち主の案（純関数） */
export function ownerOfLeaf(key: string, rootOwner: string): { owner: string; why: string } {
  const r = LEAF_OWNER_RULES.find((x) => key.includes(x.match));
  return r ? { owner: r.owner, why: r.why } : { owner: rootOwner, why: "根の持ち主" };
}
/**
 * 穴の葉が統括に届いているか（純関数）: 今の統括の学び（conductor_lessons.is_current）の葉の印（leaf_keys）が、穴の葉かその上か下を指していれば届いている。
 *   根の名前が違っても（文の癖の版の葉で書いた学び）付け替えて比べる。印の付いた学びが1つも無ければ「未確認」（印を付ける仕組み exam-leaf.ts --lessons はまだ既定で回していない）
 */
export function leafReachOf(holeKey: string, lessonLeafKeys: ReadonlyArray<string>, rebaseFrom: ReadonlyArray<string> = []): "届いている" | "届いていない" | "未確認" {
  if (!lessonLeafKeys.length) return "未確認";
  const root = holeKey.split("/")[0];
  const keys = lessonLeafKeys.map((k) => { const r = [root, ...rebaseFrom].find((x) => k === x || k.startsWith(`${x}/`)); return r ? rebaseKey(k, r, root) : k; });
  return keys.some((k) => covers(k, holeKey) || covers(holeKey, k)) ? "届いている" : "届いていない";
}

// ── 2026-11-23 統括役の決め: 統括に届いているかを「学び」と「材料」の2つの道で（どちらかで届いていれば届いている）──
/** 葉の材料が統括ブレインの入力に届く道（app/lib/linkage-map.ts の LINKAGE_MAP の行 id）。上から順に、葉の鍵に段の値が含まれれば当たる（重ねて足す） */
export const LEAF_MATERIAL_ROWS: Array<{ match: string; rows: string[] }> = [
  { match: "kind=property_check_result", rows: ["read.staff_hand", "read.on_hand", "read.now_fulfillable", "read.promise_read"] },
  { match: "kind=property", rows: ["read.on_hand", "read.staff_hand", "read.sent_full", "read.situation_now"] },
  { match: "kind=estimate_sheet", rows: ["read.estimate_records", "read.on_hand"] },
  { match: "kind=viewing_invite", rows: ["read.timeline", "read.situation_now"] },
  { match: "kind=greeting_viewing", rows: ["read.timeline"] },
  { match: "kind=zenryoku_support", rows: ["read.situation_now", "read.mindset"] },
  { match: "scene=ack", rows: ["read.promise_read", "read.ack_confirm"] },
  { match: "station=", rows: ["read.route_map", "read.route_substate"] },
  { match: "kind=application_push", rows: ["read.mindset", "read.route_map", "read.situation_now"] }, // 作業員A の統括の受け持ち表（#662・決めに行く＝持つ read.mindset）と揃えた
  { match: "kind=hand", rows: ["read.mindset", "read.route_map"] },
];
export function materialRowsOfLeaf(key: string): string[] {
  return [...new Set(LEAF_MATERIAL_ROWS.filter((x) => key.includes(x.match)).flatMap((x) => x.rows))];
}
/** 連携の地図の見張りの最新（cron_run_logs の linkage-watch の result_json の cut＝切れている・空が多い・off＝親が off） */
export type LinkageStatus = { cut: ReadonlySet<string>; off: ReadonlySet<string>; at: string | null;
  /** 測れなかった行（作業員L ce4e79dc1 の result_json.unmeasured・古い記録には無い＝無い時は今まで通り） */
  unmeasured?: ReadonlySet<string> };
/**
 * 統括に届いているか（純関数）: ①学びの道＝今の統括の学びの葉の印が葉かその上下を指す ②材料の道＝葉の材料の行（LEAF_MATERIAL_ROWS）が連携の地図で全部つながっている（切れ・空が多い・親が off が1つも無い）。
 *   どちらかで届いていれば「届いている」。どちらの道も測れない（学びの印が無く・材料の行も見張りの結果も無い）なら「未確認」。ほかは「届いていない」（切れている行を返す）
 */
export function conductorReachOf(holeKey: string, lessonLeafKeys: ReadonlyArray<string>, rebaseFrom: ReadonlyArray<string>, linkage: LinkageStatus | null): { reach: "届いている" | "届いていない" | "未確認"; via: "学び" | "材料" | null; cutRows: string[] } {
  const viaLesson = leafReachOf(holeKey, lessonLeafKeys, rebaseFrom);
  if (viaLesson === "届いている") return { reach: "届いている", via: "学び", cutRows: [] };
  const rows = materialRowsOfLeaf(holeKey);
  if (linkage && rows.length) {
    const cut = rows.filter((r) => linkage.cut.has(r) || linkage.off.has(r));
    if (cut.length) return { reach: "届いていない", via: null, cutRows: cut };
    // 材料の行に測れなかった行があれば「届いている」と言えない＝未確認（作業員L の案）
    if (rows.some((r) => linkage.unmeasured?.has(r))) return { reach: "未確認", via: null, cutRows: [] };
    return { reach: "届いている", via: "材料", cutRows: [] };
  }
  return { reach: viaLesson === "届いていない" ? "届いていない" : "未確認", via: null, cutRows: [] };
}
/** 約束の地図（作業員L の audit-promise-map.ts --out の json）の番をそのまま木の番に（純関数） */
export function promiseMapTurnsOf(j: unknown): MapTurn[] {
  const turns = (Array.isArray(j) ? j : ((j ?? {}) as { turns?: unknown[] }).turns ?? []) as Array<{ id: number | string; kind?: string; scene?: string; miss?: string; cause?: string | null }>;
  return turns.map((t) => ({ id: t.id, kind: String(t.kind ?? "other"), scene: String(t.scene ?? "other"), miss: (t.miss === "ok" || t.miss === "late" || t.miss === "overdue" ? t.miss : "overdue") as MapMiss, cause: t.miss === "ok" ? null : ((t.cause ?? "misread") as MapCause) }));
}
