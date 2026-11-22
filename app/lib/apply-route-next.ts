// app/lib/apply-route-next.ts — 申込までの地図の「申込へ向けた次の一手の候補」を、駅だけでなくお客様の今の番（発言の型・内覧の日）で選び直す（純関数・DB/LLM なし）
//
// 2026-11-23 作業員R（台帳 #608・竹内さん 11/23「申込までの道筋をブレインは理解してちゃんと申込に向かって動くようになっているのか…細分化して強化されているのか」）。
//   見つけた穴（scripts/audit-route-progress-takeuchi.ts・竹内さん本人の番 60日・申込以降を外した 262番）:
//     地図は駅ごとに次の一手が1つ（apply-route-map の ROUTE_NODES[*].next）。番の型を見ないので、竹内さんの一手と合うのは 58%。
//     一番太い外れ push_missed 53番（20%）＝地図は AIX で進める候補・竹内さんは問いに答えて駅を動かさない:
//       内覧予定:greeting_viewing→答え 16（当日のご挨拶を内覧の何日も前から候補にしていた）・物件の提案:確認の結果→答え 7・内覧調整/見積:内覧のご案内→答え 10 ほか
//     次 other_aix 49番: 提案中/持ち込みで費用を聞かれた番に竹内さんは御見積書（8）＝決定 f7ed2a87「費用を聞かれた＝食いつきの合図・見積は決まった段ではない」が地図に無い
//       ／審査の相談で竹内さんは申込のご案内（3・guarantor_info は60日で2回だけ）。
//   ここは位置（駅・分かれ道）は変えず、次の一手の候補だけを番で選び直す。どう返すか・AIX にするかはブレインが決める（P0 9eb6aa9c・地図の線と同じ）。
//
// スイッチ APPLY_ROUTE_NEXT_BY_TURN（既定 off・=on で使う）。off の時は locateApplyRoute の結果をそのまま返す＝プロンプトも記録も1バイトも変わらない。
// ⚠ 前例（KB c5fd146d・凍結 #6）: 状態の候補をブレインの材料に置くと道が次の一手を進める側へ寄った（q065・q425）。
//   ここで変える候補は3つだけ（同じ 262番の監査で 良くなった/悪くなった）: 費用の問い→御見積書（f7ed2a87・2/1）・気に入った物件のある審査の相談→申込のご案内（1/0）・
//   内覧の2日以上前の問い→当日のご挨拶を外す（7/0）。試験（brain-exam の地図の組）で悪化0を確かめてから on。
import type { RouteType } from "./brain-route-type";
import type { ApplyRouteLocation, RouteNodeId, RouteStep } from "./apply-route-map";

/** 本線の駅の順（apply-route-map の MAIN_ROUTE と同じ・値を import すると apply-route-map と輪になるので写す。同じかはテストで確かめる） */
export const ROUTE_ORDER: readonly RouteNodeId[] = ["inquiry", "hearing", "pickup", "proposing", "interested", "estimate", "viewing_arrange", "viewing_scheduled", "viewed", "apply_prep", "applying"];

type Env = Record<string, string | undefined>;
export function applyRouteNextByTurnOn(env: Env = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.APPLY_ROUTE_NEXT_BY_TURN ?? "").trim().toLowerCase() === "on";
}

export type RouteNextSignals = {
  routeType?: RouteType | null;
  /** 一番近い内覧の日（customer-state の upcomingViewing.ymd・"YYYY-MM-DD"・分からなければ null） */
  upcomingViewingYmd?: string | null;
  nowMs?: number;
};

/** 費用を聞かれた（食いつきの合図・f7ed2a87） */
const COST_TURN: ReadonlySet<RouteType> = new Set<RouteType>(["cost_question", "estimate_request"]);
/** 内覧の当日の連絡（当日のご挨拶・待ち合わせ場所の番） */
const VIEWING_DAY_TURN: ReadonlySet<RouteType> = new Set<RouteType>(["arrived", "late"]);
const idx = (n: RouteNodeId | null) => (n ? ROUTE_ORDER.indexOf(n) : -1);

/** 日本時間の今日から ymd まで何日か（今日=0・過ぎた=負・読めなければ null） */
export function daysUntilYmd(ymd: string | null | undefined, nowMs: number): number | null {
  const m = String(ymd ?? "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const today = new Date(nowMs + 9 * 3600_000); // JST
  const t0 = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const t1 = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isFinite(t1) ? Math.round((t1 - t0) / 86_400_000) : null;
}

export type RouteNextRule = "cost_estimate" | "brought_cost" | "screening_apply" | "viewing_not_today" | "viewing_passed";

/** 選び直した次の一手（選び直さない番は null） */
export function refineRouteNextStep(loc: Pick<ApplyRouteLocation, "node" | "branch" | "next">, s: RouteNextSignals): { next: RouteStep; rule: RouteNextRule } | null {
  const rt = s.routeType ?? null;
  const now = s.nowMs ?? Date.now();
  // ① 費用を聞かれた（f7ed2a87）: 提案中・気に入った・ピックアップ（送付後）＝その物件に食いついている → 最大限割引の御見積書
  if (rt && COST_TURN.has(rt) && !loc.branch && (loc.node === "proposing" || loc.node === "interested" || loc.node === "pickup")) {
    return { rule: "cost_estimate", next: { label: "費用を聞かれた＝その物件に食いついている合図。最大限割引の御見積書で答える（見積から内覧・申込へ）", aix: ["estimate_sheet"] } };
  }
  // ② 持ち込みの物件の費用（9de893ed: 持ち込みは募集状況の確認が先）。確認の後の御見積書も候補に並べる
  if (rt && COST_TURN.has(rt) && loc.branch === "brought_property") {
    return { rule: "brought_cost", next: { label: "持ち込みのお部屋の費用: 募集状況の確認の約束→確認できたら最大限割引の御見積書", aix: ["property_check_result", "estimate_sheet"] } };
  }
  // ③ 気に入った物件がある審査の相談: 通るまでサポートする旨と、まず審査をかけてみる（申込で抑える）
  if (loc.branch === "screening_concern" && idx(loc.node) >= idx("interested")) {
    return { rule: "screening_apply", next: { label: "気に入ったお部屋があるので、通るまでサポートする旨と、まず審査をかけてみる（お申込みで抑える）。保証会社の説明も添える", aix: ["application_push", "guarantor_info"] } };
  }
  if (loc.branch) return null; // 分かれ道の一手は今の表のまま
  // ④ 内覧予定: 当日のご挨拶は内覧の日（前日を含む）と当日の連絡だけ。日が過ぎていれば感想・再調整を伺う
  //   内覧の段取りが済んだ後のお礼（ack_after_viewing_setup）は外す: 竹内さんはその番に内覧の何日も前でも AIX【当日のご挨拶】で日時と待ち合わせを確かめる
  //   （監査 11/23: 2〜8日前の段取りの後のお礼 5番が全部 AIX【当日のご挨拶】＝この番に当てると悪くなった 5）
  if (loc.node === "viewing_scheduled" && !(rt && VIEWING_DAY_TURN.has(rt)) && rt !== "ack_after_viewing_setup") {
    const d = daysUntilYmd(s.upcomingViewingYmd, now);
    if (d != null && d < 0) return { rule: "viewing_passed", next: { label: "内覧の日が過ぎている: ご内覧のご感想、または日程の再調整を伺う", aix: [] } };
    if (d != null && d >= 2) return { rule: "viewing_not_today", next: { label: "内覧の日まではお問い合わせに答え、日時と待ち合わせを確かめておく（当日のご挨拶は内覧の日）", aix: [] } };
    return null;
  }
  // ⑤（作って監査で止めた・2026-11-23）「資料・会社の事実で答える問いは、駅を進める AIX の前にまず答える（候補の AIX を空に）」は入れない。
  //   監査（竹内さん本人の番 60日・23番）で 良くなった 4・悪くなった 17: 竹内さんは問いに答えたうえで同じ番に次の一手を置く
  //   （確認の約束 10・内覧へのお誘い 4・物件オススメ 3）＝問いの番でも申込へ向けた一手は消さない。答えの番の扱いはブレインが決める
  return null;
}

/** 位置はそのまま、次の一手だけ選び直した位置（off の時・選び直さない番はそのまま返す） */
export function withRefinedNext(loc: ApplyRouteLocation, s: RouteNextSignals, env?: Env): ApplyRouteLocation {
  if (!applyRouteNextByTurnOn(env)) return loc;
  const r = refineRouteNextStep(loc, s);
  if (!r) return loc;
  return { ...loc, next: r.next, evidence: [...loc.evidence, `次の一手を番で選び直し:${r.rule}`] };
}

// ── 番ごとの駅の記録（brain_decision_logs.digest.ar・ROUTE_DIGEST・既定 off）──
//   見つけた穴: meta.apply_route は conversations.last_brain_meta にしか無く毎番上書き＝番ごとの駅の履歴が無く、「駅が進んだか」を本番の記録で測れない
//   （作業員L の誘導の物差しは digest.sg＝customer-state の段で測っていて、地図の駅（作り直し）と一致は 54%・段の記録が無い番 27%）。
//   digest に "node|branch|substate|網の版" の短い1語を残す（記録だけ）。digest の欄のうち次の番のブレインが読むのは名前の決まった項目だけ
//   （brain-core FreshDigestRow・lastTurnReview の sg）で ar は読まれない＝ブレインの材料に戻らない（作業員M の注意・KB c5fd146d）。
export function routeDigestOn(env: Env = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.ROUTE_DIGEST ?? "").trim().toLowerCase() === "on";
}
/** meta.apply_route → "proposing|considering|proposing_considering|v1"（無ければ null） */
export function routeDigestOf(meta: Record<string, unknown> | null | undefined, env: Env = typeof process !== "undefined" ? process.env : {}): string | null {
  const ar = meta && typeof meta.apply_route === "object" && meta.apply_route && !Array.isArray(meta.apply_route) ? (meta.apply_route as Record<string, unknown>) : null;
  if (!ar) return null;
  const s = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 30).replace(/\|/g, "") : "");
  const node = s(ar.node), branch = s(ar.branch), sub = s(ar.substate);
  if (!node && !branch) return null;
  const ver = (env.ROUTE_SUBSTATE_NET_V2 ?? "").trim().toLowerCase() === "on" ? "v2" : "v1";
  return `${node}|${branch}|${sub}|${ver}`;
}
