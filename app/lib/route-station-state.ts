// app/lib/route-station-state.ts — 駅ごとに「その駅にいる時ブレインが知っているべき状態」（台帳 #739・決まった計算・LLM なし）
// 2026-11-25 作業員A（竹内さん 11/25 18時台「地図の部分かなり重要・土台も整えて強化・細分化」・統括役の頼み）:
//   駅ごとの土台の表で材料（駅の中の状態）が無い駅が 16。駅ごとに要る状態を決め、今ある材料で埋まる物（どこから来るか）と足りない物に分ける。
//   今ある材料の出所: customer-state（段・since・内覧の予定）・AIX の札（aix-state-card: 束・内覧・見積・確認・候補）・行動台帳（約束）・番の型（route type）。
//   足りない物（駅に入ってからの日数・見積と束の後のお客様の通の有無）は STATION_STATE_LINE=on の時だけ材料の1行に（既定 off＝1文字も変わらない）。
import type { AixStateCard } from "./aix-state-card";

export type StationNeed = { key: string; label: string; source: string | null };
/** 駅ごとの要る状態（source＝今ある材料の出所・null＝足りない＝この1行で埋める） */
export const STATION_NEEDS: Record<string, StationNeed[]> = {
  inquiry: [{ key: "first", label: "初めての通か（こちらはまだ何も送っていない）", source: "customer-state.stage=first" }, { key: "conditions_in_first", label: "初回の通に条件まで書いてあるか", source: "route type condition_feedback" }],
  hearing: [{ key: "conditions", label: "そろった条件・足りない条件", source: "meta.property_search_params" }, { key: "days_in_station", label: "この駅に入ってからの日数", source: null }],
  pickup: [{ key: "pickup_promise", label: "探す約束の時刻と期限", source: "行動台帳 pickupPromisedUnfulfilled・約束の見張り" }, { key: "candidates", label: "送れる候補の数", source: "AIX の札 candidates" }, { key: "days_in_station", label: "この駅に入ってからの日数", source: null }],
  proposing: [{ key: "bundle_age", label: "束を送ってからの時間", source: "AIX の札 bundle.lastMinAgo" }, { key: "reply_after_bundle", label: "束の後のお客様の通", source: "AIX の札 bundle.replyAfter" }, { key: "days_in_station", label: "この駅に入ってからの日数", source: null }],
  interested: [{ key: "focus", label: "気に入ったお部屋（主のお部屋）", source: "customer-state.focusKey" }, { key: "check_result", label: "募集状況の確認の結果", source: "AIX の札 estimate.checkResult" }],
  estimate: [{ key: "estimate_age", label: "見積書を送ってからの時間", source: "AIX の札 estimate.sentMinAgo" }, { key: "reply_after_estimate", label: "見積書の後のお客様の通", source: null }, { key: "viewing_invited", label: "内覧を打診したか", source: "AIX の札 viewing.invitedMinAgo" }, { key: "days_in_station", label: "この駅に入ってからの日数", source: null }],
  viewing_arrange: [{ key: "invited", label: "候補日を出したか", source: "AIX の札 viewing.invitedMinAgo" }, { key: "decided", label: "日時が決まったか", source: "AIX の札 viewing.decided" }],
  viewing_scheduled: [{ key: "days_to", label: "内覧まで何日", source: "AIX の札 viewing.daysTo" }, { key: "meeting", label: "待ち合わせを送ったか", source: "AIX の札 viewing.meetingSent" }, { key: "greeting_today", label: "今日の挨拶を送ったか", source: "AIX の札 viewing.greetingToday" }],
  viewed: [{ key: "days_since_viewing", label: "内覧から何日", source: "AIX の札 viewing.doneDaysAgo" }, { key: "days_in_station", label: "この駅に入ってからの日数", source: null }],
};
/** 足りない物の一覧（駅 → 要る状態のうち出所の無い物） */
export function missingNeeds(): Array<{ station: string; key: string; label: string }> {
  return Object.entries(STATION_NEEDS).flatMap(([station, xs]) => xs.filter((x) => !x.source).map((x) => ({ station, key: x.key, label: x.label })));
}

export function stationStateLineOn(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.STATION_STATE_LINE ?? "").trim().toLowerCase() === "on";
}
type Msg = { sender: string; createdAt: string };
/** 足りない物を埋める1行（純関数・当たらない時は ""）。since＝customer-state の今の段階になった時刻・card＝AIX の札（無ければ見積の後の通は出さない） */
export function stationStateLine(i: { node: string | null; since: string | null; nowMs: number; messages: ReadonlyArray<Msg>; card?: Pick<AixStateCard, "estimate"> | null }): string {
  if (!i.node || !STATION_NEEDS[i.node]) return "";
  const needs = STATION_NEEDS[i.node].filter((x) => !x.source).map((x) => x.key);
  const parts: string[] = [];
  if (needs.includes("days_in_station") && i.since) {
    const d = Math.floor((i.nowMs - Date.parse(i.since)) / 86_400_000);
    if (Number.isFinite(d) && d >= 0) parts.push(`この駅に入って ${d}日`);
  }
  if (needs.includes("reply_after_estimate") && i.card?.estimate.sentMinAgo != null) {
    const sentAt = i.nowMs - i.card.estimate.sentMinAgo * 60_000;
    const after = i.messages.some((m) => m.sender === "customer" && Date.parse(m.createdAt) > sentAt && Date.parse(m.createdAt) <= i.nowMs);
    parts.push(`見積書の後のお客様の通 ${after ? "あり" : "まだ無い"}`);
  }
  return parts.length ? `【この駅の今の状態（決まった計算）】${parts.join("・")}` : "";
}
