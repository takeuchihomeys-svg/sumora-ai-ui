// app/lib/shadow-reach.ts — 影の届き（#823 ①・竹内さん 11/27「ブレインと連携したらさらに試験の費用節約して質上げれないのか」・2026-11-27 作業員A）
//
// 本番の番で、既定 off の部品の材料を「記録だけ」で組み、材料が届いたか（その番で1行が出たか）を印で残す。試験の問題の元の候補（②）と、
//   試験を寄せる場面（③）に使う。夜の試験より先に、本番の番で「どの部品がどの番に届くか」が分かる＝届かない組を積まずに済む（費用の節約）。
// 決まり（統括役 11/27）:
//   ・ブレインに渡すプロンプトは1バイトも変えない＝ブレインの LLM の後（返す物を組む所）で動かす。材料の文・材料の塊・印（materialMarks）には書かない
//   ・LLM は呼ばない・DB の読みは増やさない＝今の番で既に持っている値（ShadowReachCtx）だけで組める部品だけ（読みが混じる物は外す・迷ったら外す）
//   ・部品ごとに try で包む（失敗は parts に "err" だけ）・1番の影の組み全体に上限の時間（既定 50ms・超えたら残りは "skip"）
//   ・その部品のスイッチが on の番は組まない（本物が材料に入れている＝"on"）
// スイッチ SHADOW_REACH（既定 off・段階で読む）。記録 meta.shadow_reach = { v, parts: { 印: 字数（0＝届かず）| "err" | "skip" | "on" }, ms } → digest.shr
import { stagedOn, STAGE_OFF } from "./switch-stage";
import { stationStateLine } from "./route-station-state";
import { buildAixStateCard } from "./aix-state-card";
import { aixDictionaryLine } from "./aix-dictionary";
import { chainInsightLine, featuresOf } from "./chain-patterns";
import { matchSubstateOf } from "./turn-aims-after";
import { substateInContext } from "./substate-context";
import { substateAlsoHit, substatesFor } from "./apply-route-substate";
import { checkOrderGuideFor, preBrainCues } from "./check-order-guide";
import { unansweredAsks, unansweredLine } from "./unanswered-asks";
import { openPromises, PROMISE_READ_KIND_JA } from "./promise-read";
import { exchangeLedgerLine, buildExchangeLedger } from "./exchange-ledger";
// 2026-11-27 作業員A（統括役）: 部品は brain-core と同じ静的 import（冷えた動的 import の読み込みが影の組みの 50ms に入って skip が出た＝読み込みは影の時間の外に）

type Env = Record<string, string | undefined>;
export const SHADOW_REACH_VERSION = "shr-2026-11-27";
export const SHADOW_REACH_BUDGET_MS = 50;
export const shadowReachOn = (env: Env = typeof process !== "undefined" ? process.env : {}) => stagedOn("SHADOW_REACH", env, STAGE_OFF);

/** 今の番で既に持っている値（brain-core の関数の中の変数をそのまま渡す・読み直さない） */
export type ShadowReachCtx = {
  loc: { node: string | null; branch: string | null; next?: { aix?: string[] } | null } | null;
  since: string | null;
  ledgerMessages: unknown[]; recentAixRows: Array<{ aix_type?: string | null; sent_at?: string | null; created_at?: string | null }>; viewingHistory: unknown[]; lineTasks: unknown[];
  ledgerFacts: { estimateSent?: boolean; propertiesSentCount?: number; pickupPromisedUnfulfilled?: boolean; confirmationPromisedUnfulfilled?: boolean; estimatePromisedUnfulfilled?: boolean; lastStaffEntry?: unknown };
  unrepliedText: string; unrepliedHasImage: boolean; scene: string | null; pickupReady: boolean | null;
  typedMessages: Array<{ sender: string; text: string | null; created_at: string; is_aix_generated?: boolean | null }>;
  aixLogs: Array<{ aix_type: string | null; created_at: string; sent_at?: string | null; check_pattern?: string | null }>;
  prevMindset: string | null; turnAtMs: number;
};
export type ShadowPart = { sw: string; mark: string; build: (c: ShadowReachCtx) => Promise<string> };

/** 対象の部品（A＝今の番の材料だけで組める）。本物の材料の塊と同じ純関数を同じ値で呼ぶ */
export const SHADOW_PARTS: readonly ShadowPart[] = [
  { sw: "STATION_STATE_LINE", mark: "station_state", build: async (c) => {
    if (!c.loc?.node || c.loc.branch) return "";
    const card = buildAixStateCard({ messages: c.ledgerMessages as never, aixRows: c.recentAixRows as never, viewingHistory: c.viewingHistory as never, lineTasks: c.lineTasks as never }, c.turnAtMs);
    return stationStateLine({ node: c.loc.node as never, since: c.since, nowMs: c.turnAtMs, messages: c.ledgerMessages as never, card }) ?? "";
  } },
  { sw: "AIX_DICTIONARY_LINE", mark: "aix_dictionary", build: async (c) => {
    const aix = c.loc?.next?.aix ?? []; if (!aix.length) return "";
    return aixDictionaryLine(aix) ?? "";
  } },
  { sw: "CHAIN_INSIGHT_LINE", mark: "chain_insight", build: async (c) => {
    if (!c.loc) return "";
    const sentB: Record<string, string> = {};
    for (const x of c.recentAixRows) { const k = String(x.aix_type ?? "").split("/")[0]; const at = x.sent_at ?? x.created_at; if (k && at && (!sentB[k] || at > sentB[k])) sentB[k] = at; }
    const sub = matchSubstateOf(c.unrepliedText)?.id ?? null;
    return chainInsightLine(featuresOf({ node: c.loc.node, branch: c.loc.branch, sub1: sub, sentBefore: sentB, at: new Date(c.turnAtMs).toISOString(), mindset: c.prevMindset })) ?? "";
  } },
  { sw: "SUBSTATE_CONTEXT", mark: "substate_context", build: async (c) => {
    if (!c.loc) return "";
    const sc = substateInContext(c.unrepliedText, { estimateSent: !!c.ledgerFacts.estimateSent, propertiesSent: (c.ledgerFacts.propertiesSentCount ?? 0) > 0 }, { SUBSTATE_CONTEXT: "on" });
    return sc.id ?? "";
  } },
  { sw: "SUBSTATE_MULTI_STATION", mark: "substate_multi_station", build: async (c) => {
    if (!c.loc) return "";
    return substateAlsoHit(c.loc as never, { SUBSTATE_MULTI_STATION: "on" }) ? substatesFor(c.loc as never, { SUBSTATE_MULTI_STATION: "on" }).map((s) => s.id).join(",") : "";
  } },
  { sw: "CHECK_ORDER_GUIDE", mark: "check_order_guide", build: async (c) => {
    const f = c.ledgerFacts;
    const g = checkOrderGuideFor(preBrainCues({ scene: c.scene, customerText: c.unrepliedText, hasImageOrUrl: c.unrepliedHasImage || /https?:/.test(c.unrepliedText),
      pickupPromisedUnfulfilled: !!f.pickupPromisedUnfulfilled, confirmationPromisedUnfulfilled: !!f.confirmationPromisedUnfulfilled, estimatePromisedUnfulfilled: !!f.estimatePromisedUnfulfilled,
      pickupReady: c.pickupReady, firstContact: f.propertiesSentCount === 0 && f.lastStaffEntry == null }));
    return g?.text ?? "";
  } },
  { sw: "UNANSWERED_ASKS_LINE", mark: "unanswered", build: async (c) => {
    const aix = c.aixLogs.filter((a): a is { aix_type: string; created_at: string; sent_at?: string | null } => !!a.aix_type);
    const asks = unansweredAsks({ msgs: c.typedMessages, aix, nowMs: c.turnAtMs });
    const proms = openPromises({ msgs: c.typedMessages, aix, nowMs: c.turnAtMs, days: 7 }).map((p) => ({ kindJa: PROMISE_READ_KIND_JA[p.kind], sentence: p.sentence, at: p.at, overdue: !p.waiting && p.elapsedH > 24 }));
    return unansweredLine(asks, proms);
  } },
  { sw: "CONDUCTOR_EXCHANGE_LEDGER_BRAIN", mark: "exchange", build: async (c) => {
    return exchangeLedgerLine(buildExchangeLedger({ msgs: c.typedMessages, aix: c.aixLogs.filter((a): a is { aix_type: string; created_at: string } => !!a.aix_type) as never, nowMs: c.turnAtMs }));
  } },
];

export type ShadowReachRecord = { v: string; parts: Record<string, number | "err" | "skip" | "on">; ms: number };
/** 影の組み（純粋に近い: 渡された値だけ・失敗は err・上限の時間で skip）。now は試験用に差し替えられる */
export async function runShadowReach(ctx: ShadowReachCtx, o: { env?: Env; budgetMs?: number; parts?: readonly ShadowPart[]; now?: () => number } = {}): Promise<ShadowReachRecord> {
  const env = o.env ?? (typeof process !== "undefined" ? process.env : {});
  const now = o.now ?? (() => Date.now());
  const budget = o.budgetMs ?? SHADOW_REACH_BUDGET_MS;
  const t0 = now();
  const parts: ShadowReachRecord["parts"] = {};
  for (const p of o.parts ?? SHADOW_PARTS) {
    if (stagedOn(p.sw, env, STAGE_OFF)) { parts[p.mark] = "on"; continue; }
    if (now() - t0 > budget) { parts[p.mark] = "skip"; continue; }
    try { parts[p.mark] = (await p.build(ctx)).length; } catch { parts[p.mark] = "err"; }
  }
  return { v: SHADOW_REACH_VERSION, parts, ms: Math.round(now() - t0) };
}
/** digest の小さい形（"印:字数" を "," で・0 と on は入れない＝届いた・失敗・飛ばしただけ） */
export function shadowReachDigest(r: ShadowReachRecord | null | undefined): string | null {
  if (!r) return null;
  const xs = Object.entries(r.parts).filter(([, v]) => v !== 0 && v !== "on").map(([k, v]) => `${k}:${v}`);
  return `${xs.join(",") || "-"}|${r.ms}ms`.slice(0, 200);
}
