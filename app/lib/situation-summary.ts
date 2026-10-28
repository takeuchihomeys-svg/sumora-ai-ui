// app/lib/situation-summary.ts — 統括の②「状況のまとめ」の欄（純関数・DB/LLM なし）
//
// 2026-10-29 竹内さんの答え（統括の設計図 ①今の LINE のブレインを育てる ②段階の正は一次事実 ③軽い番は引き継ぎ）・設計図 conductor-design.md ②。
// まず「今すぐ果たせる物」の欄: 作業員5の数え（ブレインの負けの多くは「約束で返すか、その場で AIX で果たすか」の取り違え・602番中 95番）。
//   その場で果たせるかは、スタッフがもう確認・見積を済ませているか（記録にある）で決まる → 記録から1行で渡す（どう返すかはブレイン＝P0）。
//   置き場所は customer-state の【お客様の今の状況】の帯（新しい帯を足さない＝二重にしない）。
// 切替: SITUATION_NOW_FULFILLABLE=on（既定 off）。テスト: app/lib/__tests__/situation-summary.test.ts
import type { RoomState } from "./customer-state";

type Env = Record<string, string | undefined>;
export function nowFulfillableEnabled(env: Env = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.SITUATION_NOW_FULFILLABLE ?? "").trim().toLowerCase() === "on";
}

const DAY = 86_400_000;
/** 送った・確かめた時点の募集中を「今も確認済み」と見る日数（KB 90237498「7日以上前の資料だけ念のため確認」） */
export const FRESH_DAYS = 7;
const names = (rs: ReadonlyArray<Pick<RoomState, "name">>, max = 4) => `${rs.slice(0, max).map((r) => r.name).join("・")}${rs.length > max ? ` ほか${rs.length - max}件` : ""}`;

/** 最後に募集中が分かった時刻（こちらが送った・確認で募集中・退去予定） */
function lastConfirmedAt(r: Pick<RoomState, "events">): number | null {
  let t: number | null = null;
  for (const e of r.events) if (e.kind === "sent" || e.kind === "check_available" || e.kind === "check_vacating") { const x = Date.parse(e.at); if (Number.isFinite(x) && (t === null || x > t)) t = x; }
  return t;
}

/**
 * 今すぐ果たせる物の1行（無ければ ""）。
 *   確認済み＝7日以内に送った・募集中を確かめたお部屋（終了・申込中は除く）／見積を作れる＝確認済みで見積まだ／見積済み／
 *   確認が要る＝お客様の持ち込みでまだ確かめていない・送ってから7日を超えた／送れる新しい候補（売上サポ）
 */
export function nowFulfillableLine(o: { rooms: ReadonlyArray<RoomState>; pickupReady: boolean | null; nowMs: number }): string {
  const live = o.rooms.filter((r) => r.status !== "ended" && r.status !== "applying");
  const confirmed = live.filter((r) => { const t = lastConfirmedAt(r); return t !== null && o.nowMs - t <= FRESH_DAYS * DAY && (r.sentByUs || r.events.some((e) => e.kind === "check_available" || e.kind === "check_vacating")); });
  const confirmedKeys = new Set(confirmed.map((r) => r.key));
  const estimateReady = confirmed.filter((r) => !r.estimateSent);
  const estimated = live.filter((r) => r.estimateSent);
  const needCheck = live.filter((r) => !confirmedKeys.has(r.key) && (!r.sentByUs || r.status === "candidate" || r.status === "checking"));
  const parts: string[] = [];
  if (confirmed.length) parts.push(`確認済み（今も募集中と分かっている）: ${names(confirmed)}`);
  if (estimateReady.length) parts.push(`見積を作れる（確認済み・見積まだ）: ${names(estimateReady)}`);
  if (estimated.length) parts.push(`見積済み: ${names(estimated)}`);
  if (needCheck.length) parts.push(`確認が要る（お客様の持ち込みで未確認・送ってから7日超え）: ${names(needCheck)}`);
  if (o.pickupReady !== null) parts.push(`送れる新しい候補: ${o.pickupReady ? "あり" : "なし"}`);
  if (!parts.length) return "";
  return `- 今すぐ果たせる物（記録から。この場で AIX で果たせるか、確かめる約束にするかの材料）: ${parts.join("／")}`;
}
