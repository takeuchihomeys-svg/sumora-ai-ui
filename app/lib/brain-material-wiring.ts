// app/lib/brain-material-wiring.ts — システムが持っているのにブレインに届いていなかった材料を渡す行（純関数）
//
// 2026-11-11 作業員1（統括役の A1・弱い所 326）: ブレインの自己申告 material_missing（14日 573回）を決まった鍵に寄せた（material-missing-key.ts）。
//   system の側（システムが持っている事）の上位:
//   ① sendable_candidates 133回: 売上サポの候補（property_pickups の pending）があるのに、材料は「候補がある／無い」の1行だけ（pickupReadyMaterialLine・b3476f98）。
//      本番の記録 76件のうち 23件はその時点で pending があった＝中身（どの物件・合い方）が届いていない。
//   ② property_doc 26・guarantor_company 10・move_in_date 12: 主のお部屋の資料（property_pickups.image_lines）に書いてあるのに、
//      資料の材料（contract-terms-answer）はお客様の言葉が契約条件の質問の網に当たった時だけ読まれる。記録の 32／14／14件のうち 27／10／9件は会話に資料の行があった。
//   どちらも既定 off（入れる BRAIN_PICKUP_CANDIDATES_LIST=on・BRAIN_FOCUS_DOC_DIGEST=on）。判断は変えない＝材料の行を足すだけ（P0 9eb6aa9c 判断はブレイン基準）。
import { CONTRACT_TERM_LABEL, type ContractRoute, type ContractTarget, type ContractTermTopic } from "@/app/lib/contract-terms-question";

type Env = Record<string, string | undefined>;
const envOf = (env?: Env): Env => env ?? (typeof process !== "undefined" ? process.env : {});

export function pickupCandidatesListOn(env?: Env): boolean {
  return (envOf(env).BRAIN_PICKUP_CANDIDATES_LIST ?? "").trim().toLowerCase() === "on";
}
export function focusDocDigestOn(env?: Env): boolean {
  return (envOf(env).BRAIN_FOCUS_DOC_DIGEST ?? "").trim().toLowerCase() === "on";
}

export type PickupCandidateRow = {
  property_name: string | null; room_no?: string | null; summary_text?: string | null; score?: number | null;
  rank?: number | null; verdict?: string | null; created_at: string; expired_at?: string | null;
};
const FRESH_DAYS = 3; // two-stage.PICKUP_FRESH_DAYS と同じ線（循環の import を避けて持つ）
const clip = (s: unknown, n: number) => Array.from(String(s ?? "").replace(/\s+/g, " ").trim()).slice(0, n).join("");

/** 今送れる候補（two-stage.freshPickupReady と同じ線: expired_at なし・3日以内・最後に物件を送った時刻より後）を並べる（rank → 点の高い順） */
export function freshPickupCandidates(rows: ReadonlyArray<PickupCandidateRow>, o: { lastPropertiesSentAt: string | null; nowMs: number }): PickupCandidateRow[] {
  const sentMs = o.lastPropertiesSentAt ? Date.parse(o.lastPropertiesSentAt) : NaN;
  return rows.filter((r) => {
    if (r.expired_at || !r.property_name) return false;
    const c = Date.parse(r.created_at);
    if (!Number.isFinite(c) || o.nowMs - c > FRESH_DAYS * 86_400_000) return false;
    return !Number.isFinite(sentMs) || c > sentMs;
  }).sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999) || (b.score ?? 0) - (a.score ?? 0));
}

/** 材料の行: 送れる候補の中身（最大 max 件・無ければ空） */
export function pickupCandidatesMaterialLine(rows: ReadonlyArray<PickupCandidateRow>, o: { lastPropertiesSentAt: string | null; nowMs: number; max?: number }): string {
  const c = freshPickupCandidates(rows, o);
  if (!c.length) return "";
  const max = Math.max(1, o.max ?? 5);
  const lines = c.slice(0, max).map((r) => `- ${clip(r.property_name, 30)}${r.room_no ? ` ${clip(r.room_no, 8)}` : ""}${r.summary_text ? `：${clip(r.summary_text, 70)}` : ""}${r.score != null ? `（点 ${r.score}）` : ""}`);
  return `【送れる物件の候補の中身（売上サポ・今送れる ${c.length}件${c.length > max ? `のうち上位${max}件` : ""}）】\n${lines.join("\n")}\n→ どれを送るか・送る番かはブレインが決める（候補の文をお客様への返信に写さない）。`;
}

/**
 * 2026-11-11 作業員1（a1-doc-dig-1111: q403・q404 で資料の行が一度も出なかった）: 主のお部屋（customerState.focusKey）は内覧の予定・申込・
 *   関心の段階の時しか決まらず、「送ったお部屋に『気になります』『めっちゃいい』」の番では空だった。
 *   主のお部屋が無い時は、物件ごとの台帳（property-thread）の今の番の物件を対象にする（contract-terms と同じ決め方）:
 *   ①引用・名指しの物件（turnTargets）が1つ ②主語の抜けた番の物件（turnReferent）が1つ（直前に1件だけ送った 等）。それ以外（複数・不明）は出さない。
 *   1b52291e の「一番新しく送った物件」は q404（お客様の言う「長居東」でなく直近の送付「サンシエ南巽」）を取り違えたので外した（a1-doc-dig2-1111）。
 */
export type ThreadLite = {
  rooms: ReadonlyArray<{ key: string; ref: { building: string; room: string | null } }>;
  turnTargets: ReadonlyArray<{ roomKey: string }>;
  turnReferent?: { kind: "one"; roomKey: string } | { kind: "many" } | null;
};
export function threadDocTarget(s: ThreadLite | null | undefined): { name: string; roomNo: string | null; by: "turn_target" | "referent" } | null {
  if (!s) return null;
  const pick = (key: string) => s.rooms.find((r) => r.key === key) ?? null;
  const keys = [...new Set(s.turnTargets.map((t) => t.roomKey))];
  if (keys.length === 1) { const r = pick(keys[0]); if (r?.ref.building) return { name: r.ref.building, roomNo: r.ref.room ?? null, by: "turn_target" }; }
  if (keys.length > 1) return null;
  const ref = s.turnReferent;
  if (ref && ref.kind === "one") { const r = pick(ref.roomKey); if (r?.ref.building) return { name: r.ref.building, roomNo: r.ref.room ?? null, by: "referent" }; }
  return null;
}

/** 資料の写しで渡す項目（お客様が聞いていなくても判断に要る物） */
export const FOCUS_DOC_TOPICS: readonly ContractTermTopic[] = ["move_in", "guarantor_company", "guarantor_person", "key_money", "deposit", "two_person", "parking"];

/** 材料の行: 主のお部屋の資料に書いてある項目だけ（聞かれた時の答え方は contract-terms の別の行・ここは参考） */
export function focusDocDigestNote(target: ContractTarget | null, routes: ReadonlyArray<ContractRoute>): string {
  if (!target) return "";
  const got = routes.filter((r) => r.route === "material" && !(r.unitUnclear?.length) && r.facts.length);
  if (!got.length) return "";
  const label = `${target.name}${target.roomNo ? ` ${target.roomNo}` : ""}`;
  return `【📄 対象のお部屋の資料（参考・${clip(label, 40)}）— お客様は今これを聞いていない。判断の材料にだけ使い、聞かれていない項目を返信に足さない】\n${got.map((r) => `- ${CONTRACT_TERM_LABEL[r.topic]}: 「${r.facts.map((f) => clip(f, 40)).join("／")}」`).join("\n")}`;
}
