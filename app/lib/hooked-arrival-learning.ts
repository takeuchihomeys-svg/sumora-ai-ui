// app/lib/hooked-arrival-learning.ts（純関数・DB/LLM なし・画面とサーバーで共用できる）
// 「刺さった新着1件」（new-arrival-hook.newArrivalHookOf が hooked の物件）を、物件検索の採点の学習に **強い材料** として入れる。
//
// 2026-10-06 竹内さんの決定:
//   新着1件の🌟は条件の近い物件を送ってお客様に連絡を入れるフック。お客様が刺さった新着は「ちゃんと決めにいっている物件」
//   → 採点の学習に強い材料として入れる（スタッフが選んで送った事実＝scoring-learning の正解と並ぶ別の材料）。
//   刺さらなかった新着は「間違い」ではなく「印なし」（feedback_property_selection_label: 反応で正誤を決めない）。
//
// ■ 形（正誤を作らない・足すだけ）
//   ・比べる相手は「スタッフが送った新着1件ぜんぶ」（刺さった物も含む）。刺さった物でその特徴が送った物より多い（lift）時だけ
//     「この型のお客様はこの特徴で刺さる」と学ぶ。刺さらなかった物を負例に数える計算はしない（多い／少ないの比べだけ）。
//   ・出口は **加点だけ**（hookLeanBonus）。学んだ特徴に当たる候補に小さく足す。当たらない候補は 0（減点しない）。
//   ・お客様の型ごと（一人／二人以上 × 初期費用の希望）＋全体。回の少ない型は学ばない（minSent・minHooked）。
//   ・過学習を避ける: 古い半分で学び、新しい半分でも同じ向き（lift ≥ confirmLift・刺さった数 ≥ confirmHooked）の物だけ残す。
//   ・採点に入れるかは別の関門（evaluateHookBonus）: 過去の「スタッフが選んだ回」（scoring-learning の Episode・🌟と送った物）に当てて、
//     1位一致・相対順位・3位以内が **どれも下がらない** 時だけ使う。下がる物は入れない。
//
// ■ 特徴は Episode.feats（scoring-learning-episodes.judgeCandidate）と同じ名前・同じ物差し（家賃は 合計÷上限）
//   rent_ratio・area_sqm・building_age・walk・zero_zero。新着1件の物件の事実はここに揃えて渡す（hookFeatsOf）。

import { householdLayoutOf } from "./star-rank-pickup";
import { customerWants, type CustomerWantInput } from "./recommendation-gaps";
import { nameKey, sameBuildingName, toHalf } from "./candidate-facts";
import { parseRentFromSummary, parseWalkMinutesFromSummary } from "./property-summary-parse";
import { parseAreaSqm } from "./pickup-dedupe";
// 2026-10-06 判定（property-brain）も使う部品は hook-lean-core に移した（import の輪を作らない）。ここからも今まで通り出す
import { hookTypeKeys, hookFeatureBits, hookLeanBonus, HOOK_FEATURE_JA, HOOK_FEATURE_KEYS, HOOK_BONUS, type HookFeats, type HookFeatureKey, type HookCustomerType, type HookLeanTable } from "./hook-lean-core";
export { hookTypeKeys, hookFeatureBits, hookLeanBonus, HOOK_FEATURE_JA, HOOK_BONUS, type HookFeats, type HookFeatureKey, type HookCustomerType, type HookLeanTable };

/**
 * 条件欄（その時点に戻した物）→ 型。👑 の状況（star-rank-pickup.starSituationFromConditions）と同じ読み方:
 *   二人以上＝間取りの希望が 1LDK以上（householdLayoutOf）／初期費用＝customerWants の low_initial・zero_deposit
 */
/**
 * 条件フォームの原文から、初期費用の見出しだけを落とす（答えがある行は「初期費用 〇〇」にして残す・答えが空／特に無しは見出しごと消す）。
 *   例: 「⑦【初期費用の限度額】⇒」→「⑦」／「⑦【初期費用の限度額】⇒特に無し」→「⑦」／「⑦【初期費用の限度額】⇒できれば0」→「⑦初期費用 できれば0」
 */
export function rawFormatForWants(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  return String(raw).replace(/^(.*?)(?:【\s*初期費用の?限度額\s*】|初期費用の?ご?予算)[ \t　]*[⇒:：→]?[ \t　]*(.*)$/gm, (_m, pre: string, ans: string) => {
    const a = ans.trim();
    return a && !/^(?:特に)?(?:無し|なし|ない|無い|ありません|無|ナシ|-|ー|－)$/.test(a) ? `${pre}初期費用 ${a}` : pre;
  });
}

export function hookCustomerTypeOf(cond: CustomerWantInput["conditions"] | null | undefined): HookCustomerType {
  // 2026-10-06 条件フォームの原文（raw_format_text）の見出し「⑦【初期費用の限度額】⇒」「初期費用ご予算」は読まない: 答えが空・特に無しの人まで
  //   「初期費用」の型に入っていた（326人中15人）。答えが書いてある時（「できれば0」「特になし、安ければ嬉しい」）だけ「初期費用 〇〇」として残す（rawFormatForWants）
  const topics = new Set(customerWants({ conditions: { ...(cond ?? {}), raw_format_text: rawFormatForWants(cond?.raw_format_text) } }).map((w) => w.key as string));
  return { household: householdLayoutOf(cond?.floor_plan ?? null), initial: topics.has("low_initial") || topics.has("zero_deposit") };
}

export const HOOK_LEARN_CONFIG = {
  /** その型で特徴が分かる送った新着の最低数 */
  minSent: 30,
  /** その型で特徴を持つ刺さった新着の最低数 */
  minHooked: 8,
  /** 学ぶ線（刺さった物の中の割合 ÷ 送った物の中の割合） */
  minLift: 1.25,
  /** 新しい半分で同じ向きか（lift の線と刺さった数の線） */
  confirmLift: 1.05,
  confirmHooked: 3,
  /** 古い何割で学ぶか（残りで確かめる） */
  trainFrac: 0.5,
  /** 1つ当たりの加点と上限（AD の線 15点・状況の足し点 15 より小さく＝主軸を崩さない） */
  bonusEach: HOOK_BONUS.bonusEach,
  bonusMax: HOOK_BONUS.bonusMax,
  /**
   * 採点に入れる線: スタッフが選んだ回の相対順位がこれ以上良くなる時だけ（customer-pref-weights の minGain 0.01 の半分）。
   *   これより小さい改善は「変わらない」と同じ扱い（入れても誰の👑も変わらない）
   */
  minGain: 0.005,
} as const;
export type HookLearnConfig = { [K in keyof typeof HOOK_LEARN_CONFIG]: number };

/** 新着1件の1回（スタッフが送った事実＋刺さったかの印） */
export type HookRecord = { at: string; hooked: boolean; type: HookCustomerType; feats: HookFeats };

export type HookCell = { type: string; feature: HookFeatureKey; sent: number; hooked: number; sentWith: number; hookedWith: number; lift: number | null };
export type HookLean = HookCell & { confirm: { sent: number; hooked: number; hookedWith: number; lift: number | null } };
export type HookLearnResult = {
  records: number; hooked: number; train: number; confirm: number;
  /** 学んだ（古い半分で線を越え、新しい半分でも同じ向き） */
  leans: HookLean[];
  /** 全部の型 × 特徴（全期間・報告用） */
  cells: HookCell[];
  /** 線で落ちた物（理由つき） */
  skipped: Array<{ type: string; feature: HookFeatureKey; reason: string }>;
};

const FEATURES = HOOK_FEATURE_KEYS;
const r2 = (x: number) => Math.round(x * 100) / 100;

/** 型 × 特徴の数（records の中で） */
export function hookCells(records: ReadonlyArray<HookRecord>): HookCell[] {
  const acc = new Map<string, HookCell>();
  for (const rec of records) {
    const bits = hookFeatureBits(rec.feats, rec.type);
    for (const type of hookTypeKeys(rec.type)) {
      for (const feature of FEATURES) {
        const v = bits[feature];
        if (v == null) continue;
        const k = `${type}|${feature}`;
        const c = acc.get(k) ?? { type, feature, sent: 0, hooked: 0, sentWith: 0, hookedWith: 0, lift: null };
        c.sent++;
        if (rec.hooked) c.hooked++;
        if (v === 1) { c.sentWith++; if (rec.hooked) c.hookedWith++; }
        acc.set(k, c);
      }
    }
  }
  for (const c of acc.values()) c.lift = c.hooked && c.sentWith ? r2((c.hookedWith / c.hooked) / (c.sentWith / c.sent)) : null;
  return [...acc.values()].sort((a, b) => a.type.localeCompare(b.type) || a.feature.localeCompare(b.feature));
}

/** 時刻の古い順に並べて、古い trainFrac を学ぶ側・残りを確かめる側に */
export function splitHookRecords(records: ReadonlyArray<HookRecord>, trainFrac: number = HOOK_LEARN_CONFIG.trainFrac): { train: HookRecord[]; confirm: HookRecord[] } {
  const list = [...records].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  const k = Math.round(list.length * trainFrac);
  return { train: list.slice(0, k), confirm: list.slice(k) };
}

/** 学ぶ（決定論）。刺さった物に多い特徴だけを残す（少ない特徴を減点にはしない） */
export function learnHookLeans(records: ReadonlyArray<HookRecord>, cfg: HookLearnConfig = HOOK_LEARN_CONFIG): HookLearnResult {
  const { train, confirm } = splitHookRecords(records, cfg.trainFrac);
  const tr = hookCells(train), cf = new Map(hookCells(confirm).map((c) => [`${c.type}|${c.feature}`, c]));
  const leans: HookLean[] = [], skipped: HookLearnResult["skipped"] = [];
  for (const c of tr) {
    if (c.sent < cfg.minSent) { skipped.push({ type: c.type, feature: c.feature, reason: `送った数が少ない（${c.sent} < ${cfg.minSent}）` }); continue; }
    if (c.hookedWith < cfg.minHooked) { skipped.push({ type: c.type, feature: c.feature, reason: `刺さった数が少ない（${c.hookedWith} < ${cfg.minHooked}）` }); continue; }
    if (c.lift == null || c.lift < cfg.minLift) { skipped.push({ type: c.type, feature: c.feature, reason: `刺さった物に多くない（lift ${c.lift ?? "-"} < ${cfg.minLift}）` }); continue; }
    const k = cf.get(`${c.type}|${c.feature}`);
    const conf = { sent: k?.sent ?? 0, hooked: k?.hooked ?? 0, hookedWith: k?.hookedWith ?? 0, lift: k?.lift ?? null };
    if (conf.hookedWith < cfg.confirmHooked || conf.lift == null || conf.lift < cfg.confirmLift) {
      skipped.push({ type: c.type, feature: c.feature, reason: `新しい半分で確かめられない（刺さった ${conf.hookedWith}・lift ${conf.lift ?? "-"}）` });
      continue;
    }
    leans.push({ ...c, confirm: conf });
  }
  return { records: records.length, hooked: records.filter((r) => r.hooked).length, train: train.length, confirm: confirm.length, leans, cells: hookCells(records), skipped };
}

export function hookLeanTable(leans: ReadonlyArray<Pick<HookLean, "type" | "feature">>): HookLeanTable {
  const t: HookLeanTable = {};
  for (const l of leans) (t[l.type] ??= []).includes(l.feature) || t[l.type].push(l.feature);
  return t;
}

// ─── 採点への効き方を確かめる（スタッフが選んだ回に当てる） ─────────────────────────

/** scoring-learning.Episode と同じ形の最小（cands の chosen・feats と、点） */
export type HookEvalEpisode = { id: string; at: string; source: string; type: HookCustomerType | null; cands: Array<{ chosen: boolean; score: number; feats: HookFeats }> };
export type HookEvalMetrics = { episodes: number; top1: number; top3: number; relRank: number };

function metricsOf(eps: ReadonlyArray<HookEvalEpisode>, scoreOf: (e: HookEvalEpisode, i: number) => number): HookEvalMetrics {
  let top1 = 0, top3 = 0, rel = 0, n = 0;
  for (const e of eps) {
    if (e.cands.length < 2 || !e.cands.some((c) => c.chosen) || !e.cands.some((c) => !c.chosen)) continue;
    n++;
    const s = e.cands.map((_, i) => scoreOf(e, i));
    const max = Math.max(...s);
    const atTop = e.cands.map((c, i) => ({ c, s: s[i] })).filter((x) => x.s === max);
    top1 += atTop.filter((x) => x.c.chosen).length / atTop.length;
    let best = Infinity, relSum = 0, k = 0;
    const unchosen = s.filter((_, i) => !e.cands[i].chosen);
    e.cands.forEach((c, i) => {
      if (!c.chosen) return;
      const gt = s.filter((y, j) => j !== i && y > s[i]).length, eq = s.filter((y, j) => j !== i && y === s[i]).length;
      best = Math.min(best, 1 + gt + eq / 2);
      relSum += (unchosen.filter((y) => y > s[i]).length + unchosen.filter((y) => y === s[i]).length / 2) / unchosen.length; k++;
    });
    if (best <= 3) top3++;
    rel += relSum / k;
  }
  const N = n || 1, r4 = (x: number) => +(x / N).toFixed(4);
  return { episodes: n, top1: r4(top1), top3: r4(top3), relRank: r4(rel) };
}

export type HookEvalResult = {
  base: HookEvalMetrics; withBonus: HookEvalMetrics;
  bySource: Record<string, { base: HookEvalMetrics; withBonus: HookEvalMetrics }>;
  /** 加点が付いた候補の数・回の数 */
  touched: { cands: number; episodes: number };
  /** 片方だけ1位に当たった回（新だけ／旧だけ） */
  pairs: { newOnly: number; oldOnly: number };
  use: boolean; reason: string;
};

/**
 * 過去のスタッフの選択（🌟・送った物）に当てて、加点で 1位一致・3位以内・相対順位 がどれも下がらないか。
 *   全体と材料ごと（snapshot・pool・pickup）の両方で下がらない時だけ use。加点が1件も付かなければ use=false（効かない）
 */
export function evaluateHookBonus(eps: ReadonlyArray<HookEvalEpisode>, table: HookLeanTable, cfg: Pick<HookLearnConfig, "bonusEach" | "bonusMax" | "minGain"> = HOOK_LEARN_CONFIG, minSourceEpisodes = 10): HookEvalResult {
  const baseScore = (e: HookEvalEpisode, i: number) => e.cands[i].score;
  const bonusOf = (e: HookEvalEpisode, i: number) => (e.type ? hookLeanBonus(table, e.type, e.cands[i].feats, cfg).bonus : 0);
  const newScore = (e: HookEvalEpisode, i: number) => e.cands[i].score + bonusOf(e, i);
  let tc = 0, te = 0, newOnly = 0, oldOnly = 0;
  for (const e of eps) {
    let t = 0;
    e.cands.forEach((_, i) => { if (bonusOf(e, i) > 0) { tc++; t++; } });
    if (t) te++;
    const win = (sc: (e: HookEvalEpisode, i: number) => number) => {
      const s = e.cands.map((_, i) => sc(e, i)); const max = Math.max(...s);
      const top = e.cands.filter((_, i) => s[i] === max);
      return top.length === 1 && top[0].chosen;
    };
    if (e.cands.length >= 2) { const a = win(baseScore), b = win(newScore); if (b && !a) newOnly++; if (a && !b) oldOnly++; }
  }
  const base = metricsOf(eps, baseScore), withBonus = metricsOf(eps, newScore);
  const bySource: HookEvalResult["bySource"] = {};
  for (const src of [...new Set(eps.map((e) => e.source))].sort()) {
    const sub = eps.filter((e) => e.source === src);
    bySource[src] = { base: metricsOf(sub, baseScore), withBonus: metricsOf(sub, newScore) };
  }
  const worse = (a: HookEvalMetrics, b: HookEvalMetrics) => b.top1 < a.top1 - 1e-9 || b.top3 < a.top3 - 1e-9 || b.relRank > a.relRank + 1e-9;
  let use = false, reason: string;
  if (!tc) reason = "加点が付く候補が無い（効かない）";
  else if (worse(base, withBonus)) reason = `全体で下がる（1位 ${base.top1}→${withBonus.top1}・3位以内 ${base.top3}→${withBonus.top3}・相対順位 ${base.relRank}→${withBonus.relRank}）`;
  else {
    const bad = Object.entries(bySource).filter(([, v]) => v.base.episodes >= minSourceEpisodes && worse(v.base, v.withBonus)).map(([k]) => k);
    if (bad.length) reason = `材料ごとで下がる（${bad.join("・")}）`;
    else if (withBonus.relRank >= base.relRank && withBonus.top1 <= base.top1 && withBonus.top3 <= base.top3) reason = "変わらない（入れる意味が無い）";
    else if (+(base.relRank - withBonus.relRank).toFixed(4) < cfg.minGain && withBonus.top1 <= base.top1) reason = `良くなる量が小さい（相対順位 ${base.relRank}→${withBonus.relRank}・線 ${cfg.minGain}・1位は変わらない）`;
    else { use = true; reason = `下がらず良くなる（1位 ${base.top1}→${withBonus.top1}・相対順位 ${base.relRank}→${withBonus.relRank}）`; }
  }
  return { base, withBonus, bySource, touched: { cands: tc, episodes: te }, pairs: { newOnly, oldOnly }, use, reason };
}

/**
 * 1件ずつ特徴を落として確かめる（入れない物を決める）: 学んだ表から特徴を1つずつ外した時に良くなるなら、その特徴は下げている＝外す。
 *   決定論（表の順）。残った表と外した特徴を返す
 */
export function pruneHookTable(eps: ReadonlyArray<HookEvalEpisode>, table: HookLeanTable, cfg: Pick<HookLearnConfig, "bonusEach" | "bonusMax" | "minGain"> = HOOK_LEARN_CONFIG): { table: HookLeanTable; dropped: Array<{ type: string; feature: HookFeatureKey; reason: string }> } {
  let cur: HookLeanTable = JSON.parse(JSON.stringify(table));
  const dropped: Array<{ type: string; feature: HookFeatureKey; reason: string }> = [];
  for (const type of Object.keys(table).sort()) {
    for (const feature of [...(table[type] ?? [])]) {
      const without: HookLeanTable = { ...cur, [type]: (cur[type] ?? []).filter((f) => f !== feature) };
      const one: HookLeanTable = { [type]: [feature] };
      const solo = evaluateHookBonus(eps, one, cfg);
      const a = evaluateHookBonus(eps, cur, cfg).withBonus, b = evaluateHookBonus(eps, without, cfg).withBonus;
      const better = b.relRank < a.relRank - 1e-9 || b.top1 > a.top1 + 1e-9;
      if (!solo.use || better) {
        cur = without;
        if (!cur[type]?.length) delete cur[type];
        dropped.push({ type, feature, reason: !solo.use ? `単独で: ${solo.reason}` : "外すと良くなる" });
      }
    }
  }
  return { table: cur, dropped };
}

// ─── 新着1件の物件の事実を埋める（新しい LLM 呼び出しはしない・今ある記録を結ぶだけ） ─────────────
// 2026-10-06 前回は候補の行（recommendation_snapshots.candidates）だけを見ていて家賃が分かるのが数件だった。
//   🌟の本文の値（star_text_facts＝送った本文から読んだ物）が一番多く（家賃 488/538）、次に送った画像の読み取り（10/06 に DeepSeek で読み直した facts）。
//   先に入った値を優先（上の順）。号室が分かっていて違う物は結ばない。

export const ARRIVAL_FACT_FIELDS = ["rent", "admin_fee", "area_sqm", "building_age", "floor_plan", "station", "walk_minutes", "deposit_months", "key_money_months", "ad_months", "structure", "equipment"] as const;
export type ArrivalFactField = typeof ARRIVAL_FACT_FIELDS[number];
export type ArrivalFacts = Partial<Record<ArrivalFactField, unknown>> & { _src: Partial<Record<ArrivalFactField, string>> };
type AnyRow = Record<string, any>;

const numOf = (v: unknown): number | null => { const n = typeof v === "string" ? parseFloat(v) : v; return typeof n === "number" && Number.isFinite(n) ? n : null; };
export const normArrivalRoom = (r: unknown) => toHalf(String(r ?? "")).replace(/[^0-9A-Za-z]/g, "").replace(/^0+(?=\d)/, "");
const roomOk = (a: unknown, b: unknown) => !normArrivalRoom(a) || !normArrivalRoom(b) || normArrivalRoom(a) === normArrivalRoom(b);

function put(f: ArrivalFacts, k: ArrivalFactField, v: unknown, src: string) {
  if (f[k] != null) return;
  if (v == null || v === "" || (Array.isArray(v) && !v.length)) return;
  if (typeof v === "number" && !Number.isFinite(v)) return;
  f[k] = v; f._src[k] = src;
}
function fromFactsObj(f: ArrivalFacts, x: AnyRow | null | undefined, src: string, nowYear: number) {
  if (!x) return;
  put(f, "rent", numOf(x.rent), src);
  put(f, "admin_fee", numOf(x.admin_fee_yen ?? x.admin_fee), src);
  put(f, "area_sqm", numOf(x.area_sqm), src);
  put(f, "building_age", numOf(x.building_age), src);
  if (f.building_age == null && typeof x.built_ym === "string") { const y = parseInt(x.built_ym, 10); if (y > 1900 && y <= nowYear) put(f, "building_age", nowYear - y, src); }
  put(f, "floor_plan", x.floor_plan ?? null, src);
  put(f, "station", x.station ?? x.stations?.[0]?.station ?? null, src);
  put(f, "walk_minutes", numOf(x.walk_minutes ?? x.stations?.[0]?.walk), src);
  put(f, "deposit_months", numOf(x.deposit_months), src);
  put(f, "key_money_months", numOf(x.key_money_months), src);
  put(f, "ad_months", numOf(x.ad_months), src);
  put(f, "structure", x.structure ?? null, src);
  put(f, "equipment", Array.isArray(x.equipment) ? x.equipment : null, src);
}

/**
 * 新着1件の🌟の物件の事実を、今ある記録から埋める（純関数）。
 *   順: 🌟の本文の値 → 候補の行 → 送った画像の読み取り（候補の画像 URL・同じ会話で名前と号室が合う物。facts.room_no が行の号室と違う物は結び違いとして使わない）
 *       → 売上サポの行（同じお客様・同じ物件の terms・説明文）→ 相場の部屋（1戸1行）→ 送付の記録（家賃・AD）
 */
export function fillArrivalFacts(input: {
  name: string; room: string | null; sentAt: string;
  starTextFacts?: AnyRow | null; cand?: AnyRow | null;
  imageByUrl?: (url: string) => AnyRow | null | undefined;
  convImages?: ReadonlyArray<AnyRow>; pickups?: ReadonlyArray<AnyRow>; rentObservation?: AnyRow | null; sends?: ReadonlyArray<AnyRow>;
}): ArrivalFacts {
  const f: ArrivalFacts = { _src: {} };
  const nowYear = new Date(input.sentAt).getFullYear();
  const { name, room } = input;
  fromFactsObj(f, input.starTextFacts ?? null, "🌟の本文", nowYear);
  fromFactsObj(f, input.cand ?? null, "候補の行", nowYear);
  const imgOk = (r: AnyRow | null | undefined): r is AnyRow => !!r && !!r.facts && roomOk((r.facts as AnyRow)?.room_no, r.room_no);
  const img = input.cand?.image_url && input.imageByUrl ? input.imageByUrl(String(input.cand.image_url)) : null;
  if (imgOk(img)) fromFactsObj(f, img.facts as AnyRow, "送った画像", nowYear);
  for (const r of input.convImages ?? []) {
    if (!imgOk(r) || !sameBuildingName(String(r.property_name ?? ""), name) || !roomOk(r.room_no, room)) continue;
    fromFactsObj(f, r.facts as AnyRow, "送った画像", nowYear);
  }
  for (const p of input.pickups ?? []) {
    if (!sameBuildingName(String(p.property_name ?? ""), name) || !roomOk(p.room_no, room)) continue;
    const t = (p.terms ?? {}) as AnyRow;
    put(f, "rent", parseRentFromSummary(p.summary_text ?? null), "売上サポ");
    put(f, "area_sqm", parseAreaSqm(p.summary_text ?? null) ?? numOf(String(t.evidence?.area ?? "").match(/([\d.]+)\s*(?:m2|㎡)/)?.[1]), "売上サポ");
    put(f, "building_age", numOf(t.buildingAge), "売上サポ");
    put(f, "walk_minutes", parseWalkMinutesFromSummary(p.summary_text ?? null), "売上サポ");
    put(f, "deposit_months", numOf(t.deposit), "売上サポ");
    put(f, "key_money_months", numOf(t.keyMoney), "売上サポ");
    put(f, "structure", (p.equipment as AnyRow)?.facts?.structure?.d ?? null, "売上サポ");
  }
  const ro = input.rentObservation;
  if (ro) fromFactsObj(f, { ...ro, admin_fee_yen: ro.admin_fee, ad_months: ro.ad_yen && ro.rent ? Math.round((ro.ad_yen / ro.rent) * 100) / 100 : null }, "相場の部屋", nowYear);
  for (const r of input.sends ?? []) {
    if (!sameBuildingName(String(r.property_name ?? ""), name) || !roomOk(r.room_no, room)) continue;
    put(f, "rent", numOf(r.rent), "送付の記録");
    const rent = numOf(r.rent), ady = numOf(r.ad_yen);
    put(f, "ad_months", numOf(r.ad_months) ?? (ady && rent ? Math.round((ady / rent) * 100) / 100 : null), "送付の記録");
  }
  return f;
}

/** 埋めた事実 → 採点と同じ物差しの特徴（家賃は (家賃＋管理費)÷上限＝scoring-learning-episodes.judgeCandidate の rent_ratio） */
export function hookFeatsOfFacts(f: ArrivalFacts, rentMax: number | null | undefined): HookFeats {
  const rent = numOf(f.rent), adm = numOf(f.admin_fee) ?? 0;
  const d = numOf(f.deposit_months), k = numOf(f.key_money_months);
  return {
    rent_ratio: rent != null && rentMax ? +((rent + adm) / rentMax).toFixed(3) : null,
    area_sqm: numOf(f.area_sqm), building_age: numOf(f.building_age), walk: numOf(f.walk_minutes),
    zero_zero: d != null && k != null ? (d === 0 && k === 0 ? 1 : 0) : null,
  };
}

/** 相場の部屋の鍵（rent_observations を引く） */
export const rentObservationKey = (name: unknown, room: unknown) => `${nameKey(String(name ?? ""))}#${normArrivalRoom(room)}`;
/** 新着1件の🌟か（候補1件以下・または本文の2行目以降の先頭に「新着」）。scripts/audit-star-fit-d.ts と同じ線 */
export function isNewArrivalSnapshot(s: { candidate_count?: number | null; star_text?: string | null; star_name?: string | null; star_kind?: string | null }): boolean {
  if (!s.star_name) return false;
  // 2026-10-06 🌟の記録に束の見分け（star_kind・star-bundle.ts）がある行はそれを使う（束の中の🌟は新着1件でない）。無い過去の行は今まで通り
  if (s.star_kind === "bundle") return false;
  if (s.star_kind === "single") return true;
  return (s.candidate_count ?? 0) < 2 || /新着/.test(String(s.star_text ?? "").split("\n").slice(1).join("\n").slice(0, 120));
}
