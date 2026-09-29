// app/lib/customer-pref-episodes.ts
// 「今までお客様に実際に送った物件」を起点に、お客様ごとのこだわりに合わせた重み（札の倍率）を学ぶための材料を組み立てる純関数
// （DB・ネット・LLM に触れない。ここでは重みを直さない＝材料と件数だけ）。
//
// 2026-09-29 竹内「お客さんの希望の条件によってさらに細かく加点の部分変動してお客さんに合ったスコアリング」→「行う。実際に今まで
//   お客さんに送った物件の部分で実績してもできるから、その点も併せて分析すればよりスコアリング強化できる」
//   正解は「スタッフが選んで送った事実」（memory feedback_property_selection_label）。お客様の返信の有無で正誤を決めない。
//
// ■ 週1回の学習（scoring-learning-episodes.ts）との違い
//   あちらは材料（🌟の時点・拡張の回・売上サポの回）ごとに1回を作る。拡張の回は1回の検索が1回になるので、同じ日に7回検索して
//   1束を送ると「同じ送付を正解にした7回」ができる（2026-09-29 dry: pool 295回のうち多くがこの形）。
//   こちらは **送付の束（sent_properties のお客様に届いた行・30分以内の連なり）を1回** にし、その束の前 72時間に候補にあった物件
//   （売上サポの回 → 無ければ拡張の回の候補をまとめた物）を「選ばなかった物」にする。1束＝1回なので同じ正解を数え直さない。
//
// ■ 決めたこと
//   ・候補の値は候補の側の値だけ（送付記録の家賃・AD は選んだ物にしか無いので使わない＝選んだ物だけ材料が多いと順位が歪む）
//   ・売上サポの回があればその札（保存済み reason_codes・資料の表・設備・エリアまで読めている）。無ければ拡張の回を今の判定で付け直す
//   ・材料が無いだけの札（_UNKNOWN・_UNLISTED・_ASK）・AD・FIT・SEARCH は学ぶ札に数えない（scoring-learning.isFrozenCode と同じ線）
//   ・こだわりの強さは recommend-score-drift.customerStrength（条件欄・自由文・強い言い方・NG 欄・発言・言い直し）に、
//     「送った物件がその条件を満たす率」（sentFit）を足す。sentFit は stated → strong にだけ上げる（お客様が書いていない条件を
//     送付の偏りだけで「こだわり」にしない）。**学べる件数の表（learnableBy*）には sentFit で上げた強さを使わない**
//     （同じ送付を正解にも使うので循環する＝2026-09-29 の1回目で「間取り strong 33回・選んだ物が満たす 100%」と出たのはこれ）
//   ・拡張の回は束の前 72h をまとめる。続けて送った束（例: 朝と夕方）は同じ検索の候補を2度「選ばなかった物」に数える（知った上で採る＝
//     30分で束を切らないと1束に大量の送付が入り、1束の中の候補が分からなくなる）
//
// ■ 2026-09-29 1回目の結果（scripts/build-customer-pref-episodes.ts・400日・YUMA 除く・scratchpad/pcs/summary.json）
//   送付の束 541 → 回になった 163（拡張の回 158・売上サポの回 5）・お客様 76人。回にならなかった束: 候補が無い 222（画像だけの送付）・候補に当たらない 156
//   （137 は vision＝読み取った名前が候補に一致しない）。拡張の候補の値は 間取りと AD だけ（家賃 28/7,125・築年・駅・設備 0）なので
//   条件の種類 × 強さ で学べる回は 間取り strong 8〜10・stated 50〜58 の他は全部 1桁。倍率の当て直し（scripts/tmp-pcs-sim・消した）は
//   どの条件 × 強さでも相対順位の差が ±0.02 以内＝候補は検索の条件で既に絞られていて、条件の札は候補の中で横並び（間取り一致 82%・家賃内 70%）

import { normalizeBuildingName, splitBuildingRoom, normalizeRoomKey } from "./property-brain";
import { sameBuilding, judgeCandidate, segmentsOf, type JudgeContext, type CandLike } from "./scoring-learning-episodes";
import { isSameProperty } from "./sent-property-record";
import { isCustomerRow, rowChannel } from "./sent-delivery";
import { isFrozenCode, usableEpisodes, type Episode, type EpisodeCandidate } from "./scoring-learning";
import { familiesOf, familyOk, codeFamily, FAMILY_SKIP, type CustomerStrength, type StrengthLevel } from "./recommend-score-drift";

type Row = Record<string, any>;
const H = 3600_000;

export const PREF_CONFIG = {
  /** 送付の連なりを1束にする間隔 */
  bundleGapMs: 30 * 60_000,
  /** 束の前、候補を拾う幅（scoring-learning-episodes.POOL_SENT_WINDOW_MS と同じ 72時間） */
  candWindowMs: 72 * H,
  /** 束の後、売上サポの回を拾う幅（回が届いてから送るまで。回の開始は束の前でも後でもよい） */
  pickupAfterMs: 10 * 60_000,
  /** 送った物件がその条件を満たす率で stated → strong に上げる線（満たすか分かった送付の数・率） */
  fitMinKnown: 3,
  fitStrongRate: 0.85,
} as const;

// ─── 送付の束 ────────────────────────────────────────────────────────────────

export type SendRow = {
  id?: string | null;
  property_name: string;
  room_no?: string | null;
  sent_at: string;
  source?: string | null;
  channel?: string | null;
  delivery?: string | null;
  pickup_id?: number | null;
};
export type SendBundle = { start: string; end: string; sends: SendRow[]; vias: string[] };

/** お客様に届いた送付（共有だけの行は外す）を時刻順に、gapMs 以内の連なりで1束にする */
export function bundleSends(rows: ReadonlyArray<SendRow>, gapMs: number = PREF_CONFIG.bundleGapMs): SendBundle[] {
  const list = rows.filter((r) => r.property_name && r.sent_at && isCustomerRow(r) && Number.isFinite(Date.parse(r.sent_at)))
    .slice().sort((a, b) => Date.parse(a.sent_at) - Date.parse(b.sent_at) || String(a.property_name).localeCompare(String(b.property_name)));
  const out: SendBundle[] = [];
  let cur: SendBundle | null = null;
  for (const r of list) {
    const t = Date.parse(r.sent_at);
    if (cur && t - Date.parse(cur.end) <= gapMs) { cur.sends.push(r); cur.end = r.sent_at; }
    else { cur = { start: r.sent_at, end: r.sent_at, sends: [r], vias: [] }; out.push(cur); }
  }
  for (const b of out) b.vias = [...new Set(b.sends.map((s) => rowChannel(s) ?? "other"))].sort();
  return out;
}

// ─── 候補との照合 ────────────────────────────────────────────────────────────

const normRoom = (r: unknown) => normalizeRoomKey(String(r ?? "")) || String(r ?? "").normalize("NFKC").replace(/号室?$/, "").replace(/^0+(?=\d)/, "").trim();
/** 候補の見分け（建物の正規形＋号室）。同じ部屋が別の回・別のサイトで2度出ても1つ */
export function candKey(name: string | null | undefined, room: unknown): string {
  const split = splitBuildingRoom(String(name ?? ""));
  return `${normalizeBuildingName(split.building).replace(/[・･\-‐ー－\s]/g, "").toLowerCase()}#${normRoom(room) || split.room}`;
}

/** 送付の行が拡張の候補（名前＋号室）に当たるか（episodeFromPool と同じ線: 建物が同じで、号室が両方ある時は号室も同じ） */
export function sendMatchesCand(s: Pick<SendRow, "property_name" | "room_no">, c: Pick<CandLike, "name" | "room_no">): boolean {
  if (!s.property_name || !c.name) return false;
  if (!sameBuilding(s.property_name, c.name)) return false;
  const sr = normRoom(s.room_no) || splitBuildingRoom(s.property_name).room, cr = normRoom(c.room_no) || splitBuildingRoom(String(c.name)).room;
  return !sr || !cr || sr === cr;
}

/** 送付の行が売上サポの行に当たるか（pickup_id の結び → 物件名＋号室の一致・audit-recommend-vs-score と同じ線） */
export function sendMatchesPickup(s: SendRow, r: { id?: number | null; property_name?: string | null; room_no?: string | null }): boolean {
  if (s.pickup_id != null && r.id != null && s.pickup_id === r.id) return true;
  return isSameProperty({ property_name: String(r.property_name ?? ""), room_no: r.room_no ? String(r.room_no) : null }, { property_name: s.property_name, room_no: s.room_no ?? null });
}

// ─── 1束 → 1回 ───────────────────────────────────────────────────────────────

export type PrefEpisode = Episode & {
  /**
   * お客様の見分け（物件顧客 ID の先頭8文字・報告に名前を出さない）。2026-09-29 反証レビュー: 前は会話 ID を先に使っていて、
   *   送付の束の回と🌟の回で同じお客様が別の鍵になり得た（お客様で分ける当て直しで学ぶ側と確かめる側の両方に入る）→ 物件顧客 ID に揃えた
   */
  customerKey: string;
  /** 送った経路（pickup・recommendation・check・staff_image…） */
  vias: string[];
  /** 束の送付の件数と、候補に当たった件数（当たらなかった送付＝候補の外から選んだ物件・材料には入らない） */
  sent: number;
  matched: number;
  /** 拡張の回をまとめた時の回の数（pool の時だけ） */
  poolsMerged?: number;
  /** 帯の材料（当て直しを帯ごとに出すため・customer-pref-weights.bandsOf）。rentMax＝その時点の家賃の上限・priorSends＝この回より前にお客様へ送った件数（0＝新規） */
  meta?: { rentMax?: number | null; priorSends?: number | null; unreadable?: string[] };
};

// ─── その回の時点で読める条件（未来の情報を混ぜない） ─────────────────────────

/**
 * property_condition_history に変更が残る欄と、残り始めた時刻（2026-09-29 DB で確認: 表の最初の行 2026-08-20、
 *   広さ・通勤・こだわり・NG は condition-history.ts で 2026-09-27 から）。ここに無い欄（NG の他の自由文・ペット・layout・max_rent 等）は履歴が無い
 */
export const HISTORY_TRACKED_SINCE: Readonly<Record<string, string>> = {
  desired_area: "2026-08-20T09:00:00Z", floor_plan: "2026-08-20T09:00:00Z", rent_max: "2026-08-20T09:00:00Z", rent_min: "2026-08-20T09:00:00Z",
  walk_minutes: "2026-08-20T09:00:00Z", move_in_time: "2026-08-20T09:00:00Z", building_age: "2026-08-20T09:00:00Z", initial_cost_limit: "2026-08-20T09:00:00Z",
  other_requests: "2026-08-20T09:00:00Z",
  floor_area_min: "2026-09-27T00:00:00+09:00", commute_station: "2026-09-27T00:00:00+09:00", commute_minutes: "2026-09-27T00:00:00+09:00",
  preferences: "2026-09-27T00:00:00+09:00", ng_points: "2026-09-27T00:00:00+09:00",
};
/** recommend-score-drift.customerStrength と帯（家賃）が読む欄 */
export const STRENGTH_FIELDS = [
  "rent_max", "max_rent", "floor_plan", "layout", "walk_minutes", "building_age", "floor_area_min", "desired_area", "initial_cost_limit",
  "commute_station", "pet", "move_in_time", "preferences", "other_requests", "additional_conditions", "raw_format_text", "ng_points",
] as const;

/**
 * その回の時点で読める条件だけを残す（純関数）。cond は customerAt で履歴から戻した後の条件。
 *   読める＝①履歴が残り始めた後の回（customerAt が戻せる）か ②お客様の行がその回より前から変わっていない（updated_at ≤ 回）。
 *   どちらでもない欄は null にして unreadable に名前を出す（今の値を過去の回に当てない・2026-09-29 反証レビュー: 後で書き足した NG で昔の回の
 *   強さが決まっていた）。本筋は履歴に残す欄を増やすこと（condition-history.ts・9/27 に4欄を足した）
 */
export function conditionsReadableAt<T extends Record<string, unknown>>(cond: T, atIso: string, rowUpdatedAt: string | null | undefined, trackedSince: Readonly<Record<string, string>> = HISTORY_TRACKED_SINCE): { c: T; unreadable: string[] } {
  const at = Date.parse(atIso);
  const upd = rowUpdatedAt ? Date.parse(rowUpdatedAt) : NaN;
  const unchanged = Number.isFinite(upd) && upd <= at;
  const out: Record<string, unknown> = { ...cond };
  const unreadable: string[] = [];
  for (const f of STRENGTH_FIELDS) {
    const v = out[f];
    if (v == null || v === "" || v === false) continue;
    const since = trackedSince[f];
    if (unchanged || (since && at >= Date.parse(since))) continue;
    out[f] = null;
    unreadable.push(f);
  }
  return { c: out as T, unreadable };
}

export type PickupRowLike = {
  id: number; created_at: string; batch_id?: string | null; complete_group_id?: string | null; rank?: number | null; complete_rank?: number | null;
  property_name?: string | null; room_no?: string | null; score?: number | null; reason_codes?: unknown; status?: string | null; sent_at?: string | null;
};
export type PoolRowLike = { id: string; sent_at: string; candidates: unknown };

const parse = (v: unknown) => (typeof v === "string" ? (() => { try { return JSON.parse(v); } catch { return null; } })() : v);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * 送付の束1つ → 1回。売上サポの回（束の前 72h〜束の後 10分に届いた行・送付に当たる行がある）があればその札、
 *   無ければ拡張の回（束の前 72h〜束の始まり＋10分）の候補をまとめて今の判定で付け直す（ctx が無ければ拡張の回は使えない）。
 *   選んだ物＝送付に当たった候補。候補に当たる送付が1つも無い・選ばなかった物が無い時は null
 */
export function episodeFromBundle(input: {
  bundle: SendBundle; customerKey: string; pickups?: ReadonlyArray<PickupRowLike> | null; pools?: ReadonlyArray<PoolRowLike> | null; ctx?: JudgeContext | null; cfg?: typeof PREF_CONFIG;
}): PrefEpisode | null {
  const cfg = input.cfg ?? PREF_CONFIG;
  const b = input.bundle;
  const t0 = Date.parse(b.start), t1 = Date.parse(b.end);
  const segments = input.ctx ? segmentsOf(input.ctx.profile, input.ctx.customer) : [];
  const idOf = (src: string, k: string) => `${src}:${input.customerKey}:${b.start.slice(0, 16)}:${k}`;

  // ① 売上サポの回（届いた時刻が窓の中）
  const pk = (input.pickups ?? []).filter((r) => { const t = Date.parse(r.created_at); return t >= t0 - cfg.candWindowMs && t <= t1 + cfg.pickupAfterMs; });
  if (pk.length >= 2) {
    // 同じ部屋の2行（リアプロと itandi）は点の高い方だけ
    const byKey = new Map<string, EpisodeCandidate & { _score: number }>();
    let matched = 0;
    const matchedSends = new Set<number>();
    for (const r of [...pk].sort((x, y) => (num(y.score) ?? -1e9) - (num(x.score) ?? -1e9))) {
      const codes = (parse(r.reason_codes) ?? []) as string[];
      if (!Array.isArray(codes)) continue;
      const hit = b.sends.map((s, i) => [s, i] as const).filter(([s]) => sendMatchesPickup(s, r));
      const chosen = hit.length > 0 || r.status === "sent" || !!r.sent_at;
      for (const [, i] of hit) matchedSends.add(i);
      const k = candKey(r.property_name, r.room_no);
      const prev = byKey.get(k);
      if (prev) { prev.chosen = prev.chosen || chosen; continue; }
      byKey.set(k, {
        key: `${r.property_name ?? ""}${r.room_no ? ` ${normRoom(r.room_no)}` : ""}`, chosen, codes,
        feats: { score: num(r.score), pool_rank: num(r.complete_rank) ?? num(r.rank) }, _score: num(r.score) ?? -1e9,
      });
    }
    matched = matchedSends.size;
    const cands = [...byKey.values()].map(({ _score, ...c }) => c);
    if (matched > 0 && cands.some((c) => c.chosen) && cands.some((c) => !c.chosen)) {
      const gid = pk[0].complete_group_id ?? pk[0].batch_id ?? String(pk[0].id);
      return { id: idOf("pickup", String(gid)), at: b.start, source: "pickup", segments, cands, customerKey: input.customerKey, vias: b.vias, sent: b.sends.length, matched };
    }
  }

  // ② 拡張の回をまとめて付け直す
  if (!input.ctx) return null;
  const pools = (input.pools ?? []).filter((p) => { const t = Date.parse(p.sent_at); return t >= t0 - cfg.candWindowMs && t <= t0 + cfg.pickupAfterMs; })
    .sort((x, y) => Date.parse(y.sent_at) - Date.parse(x.sent_at)); // 新しい回の値を優先
  if (!pools.length) return null;
  const seen = new Map<string, EpisodeCandidate>();
  const matchedSends = new Set<number>();
  let i = 0;
  for (const p of pools) {
    const raw = parse(p.candidates) as CandLike[] | null;
    if (!Array.isArray(raw)) continue;
    for (const c of raw) {
      if (!c?.name) continue;
      const k = candKey(c.name, c.room_no);
      if (seen.has(k)) continue;
      const hit = b.sends.map((s, j) => [s, j] as const).filter(([s]) => sendMatchesCand(s, c));
      for (const [, j] of hit) matchedSends.add(j);
      const r = judgeCandidate(c, i++, input.ctx);
      seen.set(k, { key: `${c.name}${c.room_no ? ` ${normRoom(c.room_no)}` : ""}`, chosen: hit.length > 0, codes: r.codes, feats: r.feats });
    }
  }
  const cands = [...seen.values()];
  if (!matchedSends.size || !cands.some((c) => c.chosen) || !cands.some((c) => !c.chosen)) return null;
  return { id: idOf("pool", String(pools[0].id).slice(0, 8)), at: b.start, source: "pool", segments, cands, customerKey: input.customerKey, vias: b.vias, sent: b.sends.length, matched: matchedSends.size, poolsMerged: pools.length };
}

// ─── 送った物件がその条件を満たす率（こだわりの強さに足す） ────────────────────

export type FamilyFit = { ok: number; known: number; rate: number | null };

/** 選んだ物（送った物件）の札から、条件の種類ごとに「満たす／満たさない」が分かった数と満たした数 */
export function sentFamilyFit(eps: ReadonlyArray<Episode>): Record<string, FamilyFit> {
  const out: Record<string, FamilyFit> = {};
  for (const e of eps) for (const c of e.cands) {
    if (!c.chosen) continue;
    const fam = familiesOf(c.codes);
    for (const [f, v] of Object.entries(fam)) {
      const ok = familyOk(v);
      if (ok == null) continue;
      const a = (out[f] ??= { ok: 0, known: 0, rate: null });
      a.known++; if (ok) a.ok++;
    }
  }
  for (const a of Object.values(out)) a.rate = a.known ? Math.round((a.ok / a.known) * 1000) / 1000 : null;
  return out;
}

export type PrefStrength = {
  base: CustomerStrength;
  sentFit: Record<string, FamilyFit>;
  /** 条件の種類ごとの最終の強さ（base の level に sentFit で stated → strong だけ上げる） */
  level: Record<string, StrengthLevel>;
  /** sentFit で上げた条件の種類 */
  raisedBySentFit: string[];
};

/**
 * こだわりの強さ＝お客様の書き方・言い方（customerStrength）＋送った物件がその条件を満たす率。
 *   満たすか分かった送付が fitMinKnown 件以上で率が fitStrongRate 以上なら、お客様が書いた（stated）条件は strong に上げる。
 *   お客様が書いていない条件（none）は上げない（スタッフの選び方の癖をお客様のこだわりと取り違えない）
 */
export function prefStrength(base: CustomerStrength, sentFit: Record<string, FamilyFit>, cfg = PREF_CONFIG): PrefStrength {
  const level: Record<string, StrengthLevel> = {};
  const raised: string[] = [];
  const fams = new Set([...Object.keys(base.byFamily), ...Object.keys(sentFit)]);
  for (const f of fams) {
    let lv: StrengthLevel = base.byFamily[f]?.level ?? "none";
    const fit = sentFit[f];
    if (lv === "stated" && fit && fit.known >= cfg.fitMinKnown && (fit.rate ?? 0) >= cfg.fitStrongRate) { lv = "strong"; raised.push(f); }
    level[f] = lv;
  }
  return { base, sentFit, level, raisedBySentFit: raised.sort() };
}

// ─── 学べる件数 ──────────────────────────────────────────────────────────────

export type StrengthOf = (e: PrefEpisode, family: string) => StrengthLevel;
/** 学べる件数から外す条件の種類: 条件でない札（FAMILY_SKIP）＋ AD（竹内さんの方針で学習では動かさない＝isFrozenCode と同じ線） */
export const LEARN_FAMILY_SKIP = new Set([...FAMILY_SKIP, "ad"]);
const LV_ORDER = { strong: 0, stated: 1, none: 2, all: 3 } as const;

export type FamilyCountRow = {
  family: string; level: StrengthLevel | "all";
  /** 選んだ物と選ばなかった物で「満たす／満たさない」が違う回（＝この条件で学べる回） */
  rounds: number; customers: number;
  /** 回ごとの「選んだ物が満たす率」「候補全体が満たす率」の平均 */
  chosenOk: number | null; poolOk: number | null;
  /** 全部の回のうち、この条件がどの候補でも読めていない回（材料の欠け） */
  blindRounds: number;
};

const mean = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, x) => a + x, 0) / xs.length) * 1000) / 1000 : null);

/** 条件の種類 × こだわりの強さ ごとに、学べる回の数（選んだ物と選ばなかった物で満たすかが違う回） */
export function learnableByFamily(eps: ReadonlyArray<PrefEpisode>, strengthOf: StrengthOf = () => "none"): FamilyCountRow[] {
  type Acc = { rounds: Set<string>; customers: Set<string>; chosenOk: number[]; poolOk: number[]; blind: number };
  const acc = new Map<string, Acc>();
  const get = (k: string) => { let a = acc.get(k); if (!a) { a = { rounds: new Set(), customers: new Set(), chosenOk: [], poolOk: [], blind: 0 }; acc.set(k, a); } return a; };
  const allFamilies = new Set<string>();
  const list = usableEpisodes([...eps]) as PrefEpisode[];
  for (const e of list) for (const c of e.cands) for (const k of c.codes) { const f = codeFamily(k); if (f && !LEARN_FAMILY_SKIP.has(f)) allFamilies.add(f); }
  for (const e of list) {
    const fam = e.cands.map((c) => familiesOf(c.codes));
    for (const f of allFamilies) {
      const oks = fam.map((x) => familyOk(x[f]));
      const known = oks.filter((x): x is boolean => x != null);
      const lvls = [strengthOf(e, f), "all"] as const;
      if (!known.length) { for (const lv of lvls) get(`${f}|${lv}`).blind++; continue; }
      const chosenVals = e.cands.map((c, i) => (c.chosen ? oks[i] : null)).filter((x): x is boolean => x != null);
      const otherVals = e.cands.map((c, i) => (!c.chosen ? oks[i] : null)).filter((x): x is boolean => x != null);
      if (!chosenVals.length || !otherVals.length) continue;
      const differs = chosenVals.some((a) => otherVals.some((b) => a !== b));
      if (!differs) continue;
      for (const lv of lvls) {
        const a = get(`${f}|${lv}`);
        a.rounds.add(e.id); a.customers.add(e.customerKey);
        a.chosenOk.push(chosenVals.filter(Boolean).length / chosenVals.length);
        a.poolOk.push(known.filter(Boolean).length / known.length);
      }
    }
  }
  const rows: FamilyCountRow[] = [];
  for (const [k, a] of acc) {
    const [family, level] = k.split("|") as [string, FamilyCountRow["level"]];
    rows.push({ family, level, rounds: a.rounds.size, customers: a.customers.size, chosenOk: mean(a.chosenOk), poolOk: mean(a.poolOk), blindRounds: a.blind });
  }
  return rows.sort((x, y) => x.family.localeCompare(y.family) || LV_ORDER[x.level] - LV_ORDER[y.level]);
}

export type CodeCountRow = {
  code: string; family: string | null; level: StrengthLevel | "all";
  /** 札の有無が選んだ物と選ばなかった物で違う回・お客様の数 */
  rounds: number; customers: number;
  /** 回ごとの「選んだ方が札を持つ率」の平均 */
  winRate: number | null;
};

/** 札ごと × こだわりの強さ（札の条件の種類の強さ）: 学べる回の数（凍結の札＝AD・FIT・SEARCH・_UNKNOWN 等は出さない） */
export function learnableByCode(eps: ReadonlyArray<PrefEpisode>, strengthOf: StrengthOf = () => "none"): CodeCountRow[] {
  type Acc = { rounds: Set<string>; customers: Set<string>; win: number[] };
  const acc = new Map<string, Acc>();
  const get = (k: string) => { let a = acc.get(k); if (!a) { a = { rounds: new Set(), customers: new Set(), win: [] }; acc.set(k, a); } return a; };
  const list = usableEpisodes([...eps]) as PrefEpisode[];
  const codes = new Set<string>();
  for (const e of list) for (const c of e.cands) for (const k of c.codes) if (!isFrozenCode(k)) codes.add(k);
  for (const e of list) {
    const chosen = e.cands.filter((c) => c.chosen), other = e.cands.filter((c) => !c.chosen);
    for (const code of codes) {
      let w = 0, n = 0;
      for (const a of chosen) for (const b of other) {
        const ha = a.codes.includes(code), hb = b.codes.includes(code);
        if (ha === hb) continue;
        n++; if (ha) w++;
      }
      if (!n) continue;
      const f = codeFamily(code);
      for (const lv of [f ? strengthOf(e, f) : "none", "all"] as const) {
        const a = get(`${code}|${lv}`);
        a.rounds.add(e.id); a.customers.add(e.customerKey); a.win.push(w / n);
      }
    }
  }
  const rows: CodeCountRow[] = [];
  for (const [k, a] of acc) {
    const [code, level] = k.split("|") as [string, CodeCountRow["level"]];
    rows.push({ code, family: codeFamily(code), level, rounds: a.rounds.size, customers: a.customers.size, winRate: mean(a.win) });
  }
  return rows.sort((x, y) => y.rounds - x.rounds || x.code.localeCompare(y.code) || LV_ORDER[x.level] - LV_ORDER[y.level]);
}

// ─── 件数のまとめ ────────────────────────────────────────────────────────────

export type MaterialSummary = {
  customers: number; rounds: number; candidates: number; chosen: number;
  bySource: Record<string, { rounds: number; customers: number; candidates: number }>;
  byMonth: Record<string, number>;
  byVia: Record<string, number>;
  /** 候補の値の埋まり方（札で見て、条件の種類が「分からない」でなく読めている候補の数） */
  familyCoverage: Record<string, number>;
  /** 束の送付のうち候補に当たらなかった件数（候補の外から選んだ・材料に入らない） */
  unmatchedSends: number;
};

export function materialSummary(eps: ReadonlyArray<PrefEpisode>): MaterialSummary {
  const customers = new Set<string>();
  const bySource: MaterialSummary["bySource"] = {};
  const byMonth: Record<string, number> = {}, byVia: Record<string, number> = {}, cov: Record<string, number> = {};
  let candidates = 0, chosen = 0, unmatched = 0;
  const srcCust = new Map<string, Set<string>>();
  for (const e of eps) {
    customers.add(e.customerKey);
    const s = (bySource[e.source] ??= { rounds: 0, customers: 0, candidates: 0 });
    s.rounds++; s.candidates += e.cands.length;
    (srcCust.get(e.source) ?? srcCust.set(e.source, new Set()).get(e.source)!).add(e.customerKey);
    byMonth[e.at.slice(0, 7)] = (byMonth[e.at.slice(0, 7)] ?? 0) + 1;
    for (const v of e.vias) byVia[v] = (byVia[v] ?? 0) + 1;
    candidates += e.cands.length; chosen += e.cands.filter((c) => c.chosen).length;
    unmatched += Math.max(0, e.sent - e.matched);
    for (const c of e.cands) for (const [f, v] of Object.entries(familiesOf(c.codes))) if (v.state !== "unknown") cov[f] = (cov[f] ?? 0) + 1;
  }
  for (const [src, set] of srcCust) bySource[src].customers = set.size;
  return { customers: customers.size, rounds: eps.length, candidates, chosen, bySource, byMonth, byVia, familyCoverage: cov, unmatchedSends: unmatched };
}
