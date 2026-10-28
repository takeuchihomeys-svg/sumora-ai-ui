// app/lib/situation-summary.ts — 統括の②「状況のまとめ」の欄（純関数・DB/LLM なし）
//
// 2026-10-29 竹内さんの答え（統括の設計図 ①今の LINE のブレインを育てる ②段階の正は一次事実 ③軽い番は引き継ぎ）・設計図 conductor-design.md ②。
// まず「今すぐ果たせる物」の欄: 作業員5の数え（ブレインの負けの多くは「約束で返すか、その場で AIX で果たすか」の取り違え・602番中 95番）。
//   その場で果たせるかは、スタッフがもう確認・見積を済ませているか（記録にある）で決まる → 記録から1行で渡す（どう返すかはブレイン＝P0）。
//   置き場所は customer-state の【お客様の今の状況】の帯（新しい帯を足さない＝二重にしない）。
// 切替: SITUATION_NOW_FULFILLABLE=on（既定 off）。テスト: app/lib/__tests__/situation-summary.test.ts
import type { RoomState, CustomerState, CustomerStage } from "./customer-state";
import type { PromiseStep } from "./promise-queue";
import type { FilledEmotion } from "./customer-emotion-fill";
import type { BindResult } from "./sent-ledger-bind";

type Env = Record<string, string | undefined>;
export function nowFulfillableEnabled(env: Env = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.SITUATION_NOW_FULFILLABLE ?? "").trim().toLowerCase() === "on";
}

const DAY = 86_400_000;
/** 送った・確かめた時点の募集中を「今も確認済み」と見る日数（KB 90237498「7日以上前の資料だけ念のため確認」） */
export const FRESH_DAYS = 7;

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
/** 今すぐ果たせる物（型・作業員1の AIX の統括・作業員5の2通目が読む） */
export type NowFulfillable = { confirmed: string[]; estimateReady: string[]; estimated: string[]; needCheck: string[]; pickupReady: boolean | null };
export function nowFulfillableOf(o: { rooms: ReadonlyArray<RoomState>; pickupReady: boolean | null; nowMs: number }): NowFulfillable {
  const live = o.rooms.filter((r) => r.status !== "ended" && r.status !== "applying");
  const confirmed = live.filter((r) => { const t = lastConfirmedAt(r); return t !== null && o.nowMs - t <= FRESH_DAYS * DAY && (r.sentByUs || r.events.some((e) => e.kind === "check_available" || e.kind === "check_vacating")); });
  const confirmedKeys = new Set(confirmed.map((r) => r.key));
  return {
    confirmed: confirmed.map((r) => r.name),
    estimateReady: confirmed.filter((r) => !r.estimateSent).map((r) => r.name),
    estimated: live.filter((r) => r.estimateSent).map((r) => r.name),
    needCheck: live.filter((r) => !confirmedKeys.has(r.key) && (!r.sentByUs || r.status === "candidate" || r.status === "checking")).map((r) => r.name),
    pickupReady: o.pickupReady,
  };
}
const nameList = (xs: ReadonlyArray<string>, max = 4) => `${xs.slice(0, max).join("・")}${xs.length > max ? ` ほか${xs.length - max}件` : ""}`;
export function nowFulfillableLine(o: { rooms: ReadonlyArray<RoomState>; pickupReady: boolean | null; nowMs: number }): string {
  const n = nowFulfillableOf(o);
  const parts: string[] = [];
  if (n.confirmed.length) parts.push(`確認済み（今も募集中と分かっている）: ${nameList(n.confirmed)}`);
  if (n.estimateReady.length) parts.push(`見積を作れる（確認済み・見積まだ）: ${nameList(n.estimateReady)}`);
  if (n.estimated.length) parts.push(`見積済み: ${nameList(n.estimated)}`);
  if (n.needCheck.length) parts.push(`確認が要る（お客様の持ち込みで未確認・送ってから7日超え）: ${nameList(n.needCheck)}`);
  if (n.pickupReady !== null) parts.push(`送れる新しい候補: ${n.pickupReady ? "あり" : "なし"}`);
  if (!parts.length) return "";
  return `- 今すぐ果たせる物（記録から。この場で AIX で果たせるか、確かめる約束にするかの材料）: ${parts.join("／")}`;
}

// ── 状況のまとめの型（統括②・LINE の統括 → AIX の統括 AixHandoff.situation／2通目） ──────────────────
/** 2026-10-29 作業員1（aix-desk-types.ts の AixHandoff<SituationSummary, BindResult>）・作業員5（AIX の2通目）と合わせた形 */
export type SituationSummary = {
  /** 一次事実の段階（customer-state） */
  stage: CustomerStage;
  stageLabel: string;
  /** まだ果たしていない約束（promise-queue の pending） */
  openPromises: Array<Pick<PromiseStep, "kind" | "action" | "object" | "evidence" | "promisedAt">>;
  /** 気持ち（customer-emotion-fill：ブレイン→気持ちの要約→前の判断→言葉の仮の値） */
  emotion: FilledEmotion;
  nowFulfillable: NowFulfillable;
  /** 今の発言が指す、こちらの送った事（sent-ledger-bind） */
  bind: { kind: string; name: string | null; topic: string | null; by: string } | null;
  /** 訴求の材料（お客様のメモ）と、ブレインの訴求の判断（無ければ null） */
  appealMaterials: AppealMaterials;
  appeal: AppealDecision | null;
};
export function buildSituationSummary(o: { state: Pick<CustomerState, "stage" | "stageLabel" | "properties">; promises: ReadonlyArray<PromiseStep>; emotion: FilledEmotion; bind: BindResult; pickupReady: boolean | null; nowMs: number; memoItems?: ReadonlyArray<{ kind: string; text: string; retiredAt?: string | null }>; mindsetState?: string | null; appeal?: AppealDecision | null }): SituationSummary {
  return {
    stage: o.state.stage, stageLabel: o.state.stageLabel,
    openPromises: o.promises.filter((p) => p.status === "pending").map((p) => ({ kind: p.kind, action: p.action, object: p.object, evidence: p.evidence, promisedAt: p.promisedAt })),
    emotion: o.emotion,
    nowFulfillable: nowFulfillableOf({ rooms: o.state.properties, pickupReady: o.pickupReady, nowMs: o.nowMs }),
    bind: o.bind ? { kind: o.bind.item.kind, name: o.bind.item.name, topic: o.bind.item.topic, by: o.bind.by } : null,
    appealMaterials: appealMaterialsOf(o.memoItems ?? [], o.mindsetState ?? null),
    appeal: o.appeal ?? null,
  };
}

// ── 訴求の材料と、統括（ブレイン）の訴求の判断（2026-10-29 竹内さん KB 585ec774・作業員5の appeal と同じ形） ─────────
/** 訴求の材料（お客様のメモから・決まった手順）。希望・こだわり／不安／暮らし方／刺さっている状態 */
export type AppealMaterials = { wants: string[]; worries: string[]; lifestyle: string[]; hooked: string[] };
export type AppealAxis = "commute" | "cost" | "screening" | "move_in" | "space" | "quiet" | "pet" | "security" | "newness" | "compare";
/** ブレインの訴求の判断（作業員5の案と同じ形・お客様ごと・物件にはよらない） */
export type AppealDecision = { axes: Array<{ axis: AppealAxis; why: string; quote: string | null }>; count: 1 | 2; closing: "viewing" | "apply" | "receipt"; closingWhy: string };
/** メモの行（customer-memo の MemoItem の kind・text）から訴求の材料を作る。刺さっている状態はブレインの気持ちの要約（mindset.state）も足す */
export function appealMaterialsOf(items: ReadonlyArray<{ kind: string; text: string; retiredAt?: string | null }>, mindsetState?: string | null): AppealMaterials {
  const live = items.filter((x) => !x.retiredAt);
  const pick = (...kinds: string[]) => live.filter((x) => kinds.includes(x.kind)).map((x) => x.text).slice(0, 5);
  const hooked = pick("like");
  if (mindsetState && /刺さ|前向き|気に入/.test(mindsetState)) hooked.unshift(`（気持ち）${mindsetState}`);
  return { wants: pick("core", "flexible"), worries: pick("concern"), lifestyle: pick("people", "circumstance"), hooked: hooked.slice(0, 5) };
}
