// scripts/audit-fit-balance.ts
// 物件の点の「お客様の希望に合う加点」と「AD（利益）」の釣り合いを、今の配点と案の配点で比べる（読むだけ・DB に書かない・LLM を呼ばない）。
//
// 2026-09-25 竹内「お客さんの希望に合っていたら点数加点する重み付けれるように一番良いバランスとする。AD のように重み付けるイメージ。
//   全部の条件当てはまっていたらさらに加点。だからといって AD 低ければ利益にならないため AD も重要。AD 1未満の場合も点数低くする」
//   追加「初期費用を抑えたいお客さんには敷金礼金0円が加点される。お客さん毎の条件によって加点も変動して変わる」
//     → 今の ZERO_ZERO_MATCH（抑えたい人 +20）／ZERO_ZERO（それ以外 +8）の形を、築年・徒歩・家賃の安さ・設備にも広げる（書いた人だけ重く）。
//
// ■ 正解は「スタッフが選んで送った事実」（memory feedback_property_selection_label）。お客様の反応は使わない。
//   材料: 🌟の時点の候補（recommendation_snapshots・is_star）／拡張の回（property_candidate_pools・72時間以内にお客様に届いた物）。
//   売上サポ（property_pickups）はスタッフの送付がまだ無い（status 全部 pending）ので、1位の入れ替わりを目で読むだけに使う。
// ■ 点は今と同じ「50＋札の点の合計」（上限 SCORE_MAX 200・必須の × は上限 20・保留の物件の AD の段は 0点）。
//   案の加点も「札」（AGE_W5・FIT_ALL 等）で表すので、実装しても 50＋合計＝点 は崩れない。外す候補・保留の決まりは変えない。
//
// 実行:
//   npx tsx --env-file=.env.local scripts/audit-fit-balance.ts                 … 例の釣り合い＋実データの前後（既定 400日）
//   npx tsx --env-file=.env.local scripts/audit-fit-balance.ts --days=120     … 期間
//   npx tsx --env-file=.env.local scripts/audit-fit-balance.ts --examples     … 例の釣り合いだけ（DB を読まない）
//   npx tsx --env-file=.env.local scripts/audit-fit-balance.ts --show=20      … 1位が入れ替わった回を何件読むか（既定 12）
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  REASON_POINTS, baseReasonPoints, buildCustomerProfile, parsePropertyFacts, SCORE_MAX, EQUIP_STRONG_NG_CAP, EQUIP_CAP_CODE, BASE_SCORE,
  type SentRowLike, type PatternRowLike, type CustomerProfile,
} from "../app/lib/property-brain";
import { parseEquipmentWants } from "../app/lib/listing-equipment";
import { buildContext, customerAt, episodeFromSnapshot, episodeFromPool, isCustomerSend, POOL_SENT_WINDOW_MS, SEGMENT_JA, segmentsOf, type ConditionHistoryRow, type JudgeContext } from "../app/lib/scoring-learning-episodes";
import type { Episode } from "../app/lib/scoring-learning";
import { groupPickupRounds } from "../app/lib/pickup-card-view";

type Row = Record<string, any>;
const D = 24 * 3600_000;
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)=(.*)$/); return m ? [m[1], m[2]] : [a.replace(/^--/, ""), "1"]; }));
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

// ═══ 1. 札の仕分け（お客様の条件に合う／利益／そのほか） ══════════════════════════

export type FitVerdict = "ok" | "wide" | "soft_ng" | "ng" | "unread";
/** 条件の札 → 希望の種類と ○／幅の内側／外れ（保留にならない）／外れ（保留）／読めない。条件でない札は null */
export function fitOf(code: string): { fam: string; v: FitVerdict } | null {
  const c = code.replace(/_HELD$/, "");
  const T: Record<string, [string, FitVerdict]> = {
    RENT_OK: ["家賃", "ok"], RENT_WIDE: ["家賃", "wide"], RENT_SLIGHTLY_OVER: ["家賃", "soft_ng"], RENT_OVER_110: ["家賃", "ng"], RENT_OVER_130: ["家賃", "ng"], RENT_UNKNOWN: ["家賃", "unread"],
    ZERO_ZERO_MATCH: ["初期費用（敷礼0）", "ok"], INITIAL_COST_NOT_ZERO: ["初期費用（敷礼0）", "ng"], INITIAL_COST_OVER_LIMIT: ["初期費用の上限", "ng"],
    FLOOR_PLAN_MATCH: ["間取り", "ok"], FLOOR_PLAN_ALT_MATCH: ["間取り", "ok"], FLOOR_PLAN_WIDE: ["間取り", "wide"], FLOOR_PLAN_NEAR: ["間取り", "wide"],
    FLOOR_PLAN_SAME_CLASS: ["間取り", "wide"], FLOOR_PLAN_LARGER: ["間取り", "wide"], FLOOR_PLAN_MISMATCH: ["間取り", "ng"],
    SQM_OK: ["広さ", "ok"], SQM_SLIGHTLY_UNDER: ["広さ", "wide"], SQM_WIDE: ["広さ", "wide"], SQM_UNDER: ["広さ", "ng"], SQM_UNKNOWN: ["広さ", "unread"],
    WALK_OK: ["徒歩", "ok"], WALK_SLIGHTLY_OVER: ["徒歩", "soft_ng"], WALK_OVER: ["徒歩", "ng"],
    BUILDING_AGE_OK: ["築年", "ok"], BUILDING_AGE_WIDE: ["築年", "wide"], BUILDING_AGE_SLIGHTLY_OVER: ["築年", "soft_ng"], BUILDING_AGE_OVER: ["築年", "ng"],
    BUILDING_AGE_TEXT_OK: ["築年", "ok"], BUILDING_AGE_TEXT_OVER: ["築年", "soft_ng"],
    AREA_STATION_MATCH: ["エリア", "ok"], AREA_WARD_MATCH: ["エリア", "ok"], AREA_LINE_MATCH: ["エリア", "ok"], AREA_REGION_MATCH: ["エリア", "ok"],
    AREA_STATION_WIDE: ["エリア", "wide"], AREA_WARD_WIDE: ["エリア", "wide"], AREA_STATION_2STOPS: ["エリア", "wide"], AREA_NEAR: ["エリア", "wide"], AREA_CLOSE: ["エリア", "wide"],
    AREA_FAR: ["エリア", "soft_ng"], AREA_DIRECTION_NG: ["エリア", "soft_ng"], AREA_EXCLUDED: ["エリア", "ng"], AREA_UNKNOWN: ["エリア", "unread"],
    COMMUTE_OK: ["通勤", "ok"], COMMUTE_SLIGHTLY_OVER: ["通勤", "wide"], COMMUTE_OVER: ["通勤", "soft_ng"], COMMUTE_UNKNOWN: ["通勤", "unread"],
    MOVE_IN_OK: ["入居時期", "ok"], MOVE_IN_LATE: ["入居時期", "ng"], MOVE_IN_UNKNOWN: ["入居時期", "unread"],
    PET_NG: ["ペット", "ng"],
  };
  if (T[c]) return { fam: T[c][0], v: T[c][1] };
  let m = c.match(/^EQUIP_(.+?)_(OK_MAX|OK|NG|NEAR|ASK|UNLISTED)$/);
  if (m) return { fam: `設備:${m[1]}`, v: m[2] === "OK" || m[2] === "OK_MAX" ? "ok" : m[2] === "NG" ? "ng" : m[2] === "NEAR" ? "wide" : "unread" };
  m = c.match(/^CONDITION_(.+?)_(OK|NG|ASK|UNLISTED)$/);
  if (m) return { fam: `入居の条件:${m[1]}`, v: m[2] === "OK" ? "ok" : m[2] === "NG" ? "ng" : "unread" };
  m = c.match(/^IMAGE_(.+?)_(OK|NG)$/);
  if (m) return { fam: `画像:${m[1]}`, v: m[2] === "OK" ? "ok" : "ng" };
  return null;
}
const isAdCode = (c: string) => /^AD_|^PROFIT_NEGATIVE$/.test(c);
const AD_TIER = /^(AD_1M|AD_1_5M|AD_HIGH|AD_2_5M|AD_VERY_HIGH)(_HELD)?$/;
const HOLD_CODES = new Set(["RENT_OVER_110", "INITIAL_COST_NOT_ZERO", "INITIAL_COST_OVER_LIMIT", "FLOOR_PLAN_MISMATCH", "WALK_OVER", "BUILDING_AGE_OVER", "PROFIT_NEGATIVE", "PET_NG",
  "MOVE_IN_LATE", "CONTRACT_FIXED", "SQM_UNDER", "AREA_EXCLUDED", "ALREADY_SENT_SAME_ROOM", "ALREADY_SENT", "RENT_OVER_130"]);
const isHold = (c: string) => HOLD_CODES.has(c) || /^(?:IMAGE|EQUIP|CONDITION)_.*_NG$/.test(c);

// ═══ 2. お客様が「書いた」条件の読み方（条件欄・自由文） ════════════════════════════

export type Strength = "strong" | "normal" | "soft";
export type Wants = {
  /** 築年: column＝築年の列／text＝自由文の「築浅・新築・新しめ・築N年以内」／null＝書いていない */
  age: { src: "column" | "text" | null; years: number | null; strength: Strength };
  /** 徒歩: text＝自由文の「駅近・駅チカ・徒歩N分以内」（列より重い）／column＝徒歩の列だけ／null */
  walk: { src: "column" | "text" | null; max: number | null; strength: Strength };
  /** 家賃の安さ: 自由文に「家賃は低い方が良い・安く・抑えたい」 */
  rentCheap: { on: boolean; strength: Strength };
  /** 敷礼0: form＝条件欄・自由文に書いた／history＝送ってきた物から推した（書いていない）／none */
  lowInit: "form" | "history" | "none";
  /** 設備の希望（EQUIP_ の KEY → 強さ）。書いた物だけ（設備欄の照合はもともと書いた希望だけ） */
  equip: Map<string, Strength>;
};
const STRONG_RE = /必須|絶対|マスト/;
const SOFT_RE = /できれば|出来れば|あれば|理想|なお可|だと嬉しい|だとうれしい|優先度(?:は)?低|こだわらない/;
function clauseOf(text: string, re: RegExp): string | null {
  for (const cl of text.split(/[、。,，\n／/・]/)) if (re.test(cl)) return cl;
  return null;
}
const strengthOf = (cl: string | null): Strength => (!cl ? "normal" : STRONG_RE.test(cl) ? "strong" : SOFT_RE.test(cl) ? "soft" : "normal");
export const WALK_TEXT_RE = /駅近|駅チカ|駅ちか|駅から近|駅まで近|駅(?:から|まで)?徒歩\s*\d{1,2}\s*分以内|徒歩\s*\d{1,2}\s*分以内/;
// 2026-09-25 全お客様 303人の文で確かめた: 「初期費用はできるだけ安い方が良い」（初期費用の話）・「家賃の値下げ交渉」「家賃と間取りを下げると初期費用が〜」
//   「場所を変えると家賃や初期費用〜」（相談）は家賃の安さの希望ではない → 同じ節に「初期・交渉・相談」がある時は読まない。家賃の語が無い「安い方が良い」も読まない
export const RENT_CHEAP_RE = /(?:家賃|賃料|月々|毎月)[^、。,\n]{0,12}(?:低い|低め|安い|安め|安く|抑え|おさえ|下げ)/;
const RENT_CHEAP_NEG_RE = /初期|交渉|相談|高くても|こだわらない|気にしない/;
function freeText(c: Row): string {
  return [c.preferences, c.other_requests, c.additional_conditions].filter(Boolean).map((s) => String(s).normalize("NFKC")).join("\n");
}
export function readWants(cust: Row, prof: CustomerProfile): Wants {
  const t = freeText(cust);
  const ageCl = clauseOf(t, /新築|築浅|新しめ|新しい|築\s*\d{1,2}\s*年/);
  const walkCl = clauseOf(t, WALK_TEXT_RE);
  const walkN = walkCl?.match(/徒歩\s*(\d{1,2})\s*分/);
  const cheapCl = t.split(/[、。,，\n／/]/).find((cl) => RENT_CHEAP_RE.test(cl) && !RENT_CHEAP_NEG_RE.test(cl)) ?? null;
  const equip = new Map<string, Strength>();
  try {
    for (const w of parseEquipmentWants(cust as never).wants) {
      const K = String(w.key).toUpperCase() + (w.mode === "ng" ? "_NOT" : "");
      equip.set(K, w.strong ? "strong" : w.soft ? "soft" : "normal");
    }
  } catch { /* 読めない時は書いていない扱い */ }
  return {
    age: prof.buildingAgeMax != null ? { src: "column", years: prof.buildingAgeMax, strength: "normal" }
      : prof.ageTextMax ? { src: "text", years: prof.ageTextMax.years, strength: strengthOf(ageCl) } : { src: null, years: null, strength: "normal" },
    walk: walkCl ? { src: "text", max: prof.walkMax ?? (walkN ? parseInt(walkN[1], 10) : 10), strength: strengthOf(walkCl) }
      : prof.walkMax != null ? { src: "column", max: prof.walkMax, strength: "normal" } : { src: null, max: null, strength: "normal" },
    rentCheap: { on: !!cheapCl && prof.rentMax != null, strength: strengthOf(cheapCl) },
    lowInit: prof.wantsLowInitialCost ? (prof.lowInitialCostSource === "history" ? "history" : "form") : "none",
    equip,
  };
}

// ═══ 3. 案の配点 ════════════════════════════════════════════════════════════════

export type Plan = {
  name: string;
  label: string;
  /** 書いた条件の重み（false＝今の配点のまま） */
  written: boolean;
  /** 築年の段（書いた人）: 5年以内・10年以内・15年以内・15年超 */
  ageW: [number, number, number, number];
  /** 築年の段（書いていない人・軽く） */
  ageN: [number, number];
  /** 駅近を書いた人の上乗せ: 徒歩5分以内・7分以内 */
  walkNearW: [number, number];
  /** 駅近を書いた人で徒歩の列が無い時の外れ（保留にしない）: 15分以内・超 */
  walkTextMiss: [number, number];
  /** 書いていない人の駅近（徒歩5分以内） */
  walkNearN: number;
  /** 家賃を低くしたい人の安さ: 上限の 0.8 以下・0.9 以下・0.95 以下 */
  rentCheapW: [number, number, number];
  /** 敷礼0: 書いた人・推した人・書いていない人 */
  zz: [number, number, number];
  /** 設備 ○: 必須・普通・できれば／合計の上限 */
  equipOk: [number, number, number];
  equipCap: number;
  /** 強さの倍率（築年・徒歩・家賃の安さの書いた加点に掛ける）: 必須・できれば */
  strongMul: number;
  softMul: number;
  /** 全部合う・1つだけ外れ（保留でない外れ）・幅の内側を外れ 0.5 と数える時の「半分だけ外れ」 */
  fitAll: number;
  fitOne: number;
  fitHalf: number;
  /** 幅の内側（隣の駅・家賃の幅・LDK→DK 等）を外れとして数える重さ（0＝数えない） */
  wideMiss: number;
  /** 全部合うを数える最低の条件の数（これ未満は半分・1つ以下は 0） */
  fitMinN: number;
  /** AD: なし・1ヶ月未満 */
  adNone: number;
  adUnder1: number;
};
const CURRENT: Plan = {
  name: "今", label: "今の配点（REASON_POINTS）", written: false, ageW: [0, 0, 0, 0], ageN: [0, 0], walkNearW: [0, 0], walkTextMiss: [0, 0], walkNearN: 0,
  rentCheapW: [0, 0, 0], zz: [20, 20, 8], equipOk: [3, 3, 3], equipCap: 15, strongMul: 1, softMul: 1, fitAll: 0, fitOne: 0, fitHalf: 0, wideMiss: 0, fitMinN: 3,
  adNone: REASON_POINTS.AD_NONE, adUnder1: 0,
};
const PLAN_A: Plan = {
  name: "A", label: "案A 書いた条件だけ重く＋AD 1未満の減点（全部合うボーナスなし）", written: true,
  ageW: [12, 8, 3, -3], ageN: [3, 1], walkNearW: [5, 2], walkTextMiss: [-3, -8], walkNearN: 2, rentCheapW: [8, 5, 2], zz: [20, 14, 8],
  equipOk: [5, 3, 2], equipCap: 15, strongMul: 1.3, softMul: 0.6, fitAll: 0, fitOne: 0, fitHalf: 0, wideMiss: 0, fitMinN: 3, adNone: -10, adUnder1: -8,
};
const PLAN_B: Plan = { ...PLAN_A, name: "B", label: "案B 案A＋全部合う +15・1つだけ外れ +5（幅の内側は外れに数えない）", fitAll: 15, fitOne: 5 };
const PLAN_C: Plan = {
  ...PLAN_A, name: "C", label: "案C 強め（書いた条件 ×1.25・全部合う +25・1つ外れ +8・幅の内側は外れ 0.5）",
  ageW: [15, 10, 4, -5], walkNearW: [7, 3], rentCheapW: [10, 6, 3], zz: [20, 12, 5], equipOk: [6, 4, 2], equipCap: 20,
  fitAll: 25, fitOne: 8, fitHalf: 15, wideMiss: 0.5,
};
const PLANS = [CURRENT, PLAN_A, PLAN_B, PLAN_C];

export type Cand = { key: string; chosen: boolean; codes: string[]; age: number | null; walk: number | null; rentRatio: number | null; adMonths: number | null };

const mul = (v: number, s: Strength, p: Plan) => Math.round(v * (s === "strong" ? p.strongMul : s === "soft" ? p.softMul : 1));

/** 案の札と点。点は 50＋札の点（上限 200・必須の × は上限 20）。札は今の札＋案の札（今の札の点を案で上書きする物は pts に入る） */
export function scorePlan(c: Cand, w: Wants, p: Plan): { score: number; parts: Array<[string, number]> } {
  const parts: Array<[string, number]> = [];
  const held = c.codes.some(isHold);
  let eqOk = 0;
  for (const code of c.codes) {
    let pts = baseReasonPoints(code);
    if (p.written) {
      if (code === "ZERO_ZERO_MATCH") pts = w.lowInit === "history" ? p.zz[1] : p.zz[0];
      else if (code === "ZERO_ZERO") pts = p.zz[2];
      else if (code === "BUILDING_AGE_TEXT_OK" || code === "BUILDING_AGE_TEXT_OVER") pts = 0; // 下の段で数える
      else if (code === "BUILDING_AGE_OK") pts = 0; // 下の段で数える（最低 +5）
      else if (/^EQUIP_.*_(OK|OK_MAX)$/.test(code)) {
        const K = code.replace(/^EQUIP_/, "").replace(/_(OK|OK_MAX)$/, "");
        const s = w.equip.get(K) ?? "normal";
        const v = s === "strong" ? p.equipOk[0] : s === "soft" ? p.equipOk[2] : p.equipOk[1];
        pts = Math.max(0, Math.min(v, p.equipCap - eqOk)); eqOk += pts;
      } else if (code === "AD_NONE") pts = p.adNone;
    } else if (code === "AD_NONE") pts = p.adNone;
    parts.push([code, pts]);
  }
  // AD 1ヶ月未満（0 より大きく 1 未満）。AD の段・不明・なしの札が無く、AD が読めている時
  const adKnown = c.codes.includes("AD_COVERS_DISCOUNT") || c.codes.includes("PROFIT_NEGATIVE") || (c.adMonths != null && c.adMonths > 0);
  const under1 = !c.codes.some((x) => AD_TIER.test(x) || x === "AD_UNKNOWN" || x === "AD_NONE") && adKnown && !(c.adMonths != null && (c.adMonths >= 0.99 || c.adMonths <= 0));
  if (under1 && p.adUnder1 && !c.codes.includes("PROFIT_NEGATIVE")) parts.push(["AD_UNDER_1M", p.adUnder1]);

  // 書いた条件の重み（築年の段・駅近・家賃の安さ）
  let ageVerdict: FitVerdict | null = null, walkVerdict: FitVerdict | null = null;
  if (p.written) {
    const a = c.age;
    if (w.age.src && a != null) {
      const tier = a <= 5 ? 0 : a <= 10 ? 1 : a <= 15 ? 2 : 3;
      const code = ["AGE_W5", "AGE_W10", "AGE_W15", "AGE_W_OLD"][tier];
      if (w.age.src === "column") {
        if (c.codes.includes("BUILDING_AGE_OK")) parts.push([code, Math.max(5, mul(p.ageW[tier], w.age.strength, p))]);
      } else {
        parts.push([code, tier === 3 ? p.ageW[3] : mul(p.ageW[tier], w.age.strength, p)]);
        ageVerdict = a <= (w.age.years ?? 10) ? "ok" : "soft_ng";
      }
    } else if (!w.age.src && a != null) {
      if (a <= 5) parts.push(["AGE_N5", p.ageN[0]]); else if (a <= 10) parts.push(["AGE_N10", p.ageN[1]]);
    }
    const wk = c.walk;
    if (w.walk.src === "text" && wk != null) {
      if (wk <= 5) parts.push(["WALK_NEAR_W5", mul(p.walkNearW[0], w.walk.strength, p)]);
      else if (wk <= 7) parts.push(["WALK_NEAR_W7", mul(p.walkNearW[1], w.walk.strength, p)]);
      // 徒歩の列が無く自由文だけ（駅近）の人: 列の札が無いので ○／外れをここで付ける
      if (!c.codes.some((x) => /^WALK_/.test(x))) {
        if (wk <= (w.walk.max ?? 10)) { parts.push(["WALK_TEXT_OK", REASON_POINTS.WALK_OK]); walkVerdict = "ok"; }
        else { parts.push(["WALK_TEXT_OVER", wk <= 15 ? p.walkTextMiss[0] : p.walkTextMiss[1]]); walkVerdict = "soft_ng"; }
      }
    } else if (!w.walk.src && wk != null && wk <= 5) parts.push(["WALK_NEAR_N", p.walkNearN]);
    if (w.rentCheap.on && c.rentRatio != null && c.rentRatio <= 1) {
      const r = c.rentRatio;
      const v = r <= 0.8 ? p.rentCheapW[0] : r <= 0.9 ? p.rentCheapW[1] : r <= 0.95 ? p.rentCheapW[2] : 0;
      if (v) parts.push([r <= 0.8 ? "RENT_CHEAP_W80" : r <= 0.9 ? "RENT_CHEAP_W90" : "RENT_CHEAP_W95", mul(v, w.rentCheap.strength, p)]);
    }
  }

  // 全部合う・1つだけ外れ（お客様が書いた条件のうち読めた物。読めない・要確認は数えない）
  if (p.fitAll || p.fitOne) {
    const fam = new Map<string, FitVerdict>();
    const rankV: Record<FitVerdict, number> = { ok: 4, wide: 3, soft_ng: 2, ng: 1, unread: 0 };
    for (const code of c.codes) {
      const f = fitOf(code);
      if (!f) continue;
      if (f.fam === "初期費用（敷礼0）" && w.lowInit !== "form") continue; // 推しただけ（書いていない）は数えない
      if (f.fam === "築年" && w.age.src === "text" && ageVerdict) continue;
      const prev = fam.get(f.fam);
      if (!prev || rankV[f.v] > rankV[prev]) fam.set(f.fam, f.v);
    }
    if (ageVerdict) fam.set("築年", ageVerdict);
    if (walkVerdict) fam.set("徒歩", walkVerdict);
    const judged = [...fam.values()].filter((v) => v !== "unread");
    const n = judged.length;
    const miss = judged.reduce((s, v) => s + (v === "wide" ? p.wideMiss : v === "soft_ng" || v === "ng" ? 1 : 0), 0);
    const scale = n >= p.fitMinN ? 1 : n === p.fitMinN - 1 ? 0.5 : 0;
    if (!held && scale) {
      if (miss === 0) parts.push(["FIT_ALL", Math.round(p.fitAll * scale)]);
      else if (miss <= 0.5 && p.fitHalf) parts.push(["FIT_ALL_WIDE", Math.round(p.fitHalf * scale)]);
      else if (miss <= 1 && p.fitOne) parts.push(["FIT_ONE_MISS", Math.round(p.fitOne * scale)]);
    }
  }
  let score = BASE_SCORE + parts.reduce((s, [, v]) => s + v, 0);
  score = Math.max(0, Math.min(SCORE_MAX, score));
  if (c.codes.includes(EQUIP_CAP_CODE)) score = Math.min(score, EQUIP_STRONG_NG_CAP);
  return { score, parts };
}
const scoreCurrent = (c: Cand, w: Wants) => scorePlan(c, w, CURRENT).score;

// ═══ 4. 例の釣り合い ═════════════════════════════════════════════════════════════

function adCodes(m: number | null): string[] {
  if (m == null) return ["AD_UNKNOWN"];
  if (m <= 0) return ["AD_NONE"];
  const o = ["AD_COVERS_DISCOUNT"];
  if (m >= 1 && m < 2) o.push("AD_1M");
  if (m >= 1.5 && m < 2) o.push("AD_1_5M");
  if (m >= 2) o.push("AD_HIGH");
  if (m >= 2.5) o.push("AD_2_5M");
  if (m >= 3) o.push("AD_VERY_HIGH");
  return o;
}
function mk(key: string, fit: string[], ad: number | null, x: Partial<Cand> = {}): Cand {
  const codes = [...fit, ...adCodes(ad)];
  const held = codes.some(isHold);
  return { key, chosen: false, codes: held ? codes.map((c) => (AD_TIER.test(c) && !c.endsWith("_HELD") ? `${c}_HELD` : c)) : codes, age: 7, walk: 6, rentRatio: 0.92, adMonths: ad, ...x };
}
/** お客様（例）: 家賃・間取り・徒歩の列・敷礼0（書いた）・築浅（自由文 10年）・希望の駅・バストイレ別（普通）・入居時期 */
const W_FULL: Wants = {
  age: { src: "text", years: 10, strength: "normal" }, walk: { src: "column", max: 10, strength: "normal" }, rentCheap: { on: false, strength: "normal" },
  lowInit: "form", equip: new Map([["BATH_TOILET", "normal"], ["AUTOLOCK", "strong"]]),
};
const W_PLAIN: Wants = { age: { src: null, years: null, strength: "normal" }, walk: { src: "column", max: 10, strength: "normal" }, rentCheap: { on: false, strength: "normal" }, lowInit: "none", equip: new Map() };
const W_CHEAP: Wants = { ...W_FULL, rentCheap: { on: true, strength: "normal" } };
const W_EKICHIKA: Wants = { ...W_FULL, walk: { src: "text", max: 10, strength: "normal" } };
const FULL = ["RENT_OK", "ZERO_ZERO_MATCH", "FLOOR_PLAN_MATCH", "WALK_OK", "BUILDING_AGE_TEXT_OK", "AREA_STATION_MATCH", "EQUIP_BATH_TOILET_OK", "MOVE_IN_OK"];
const swap = (from: string, to: string) => FULL.map((c) => (c === from ? to : c));

type Ex = { id: string; say: string; w: Wants; hi: Cand; lo: Cand; want: ">" | ">=" | "~<=" };
const EXAMPLES: Ex[] = [
  { id: "a1", say: "(a) 全条件一致・AD 1ヶ月 ＞ 築浅の希望だけ外れ（築18年）・AD 2ヶ月", w: W_FULL, hi: mk("全一致 AD1", FULL, 1), lo: mk("築18 AD2", swap("BUILDING_AGE_TEXT_OK", "BUILDING_AGE_TEXT_OVER"), 2, { age: 18 }), want: ">" },
  { id: "a2", say: "(a) 全条件一致・AD 1ヶ月 ＞ 徒歩だけ少し超え（14分）・AD 2ヶ月", w: W_FULL, hi: mk("全一致 AD1", FULL, 1), lo: mk("徒歩14 AD2", swap("WALK_OK", "WALK_SLIGHTLY_OVER"), 2, { walk: 14 }), want: ">" },
  { id: "a3", say: "(a) 全条件一致・AD 1ヶ月 ＞ エリアだけ離れ（4km超）・AD 2ヶ月", w: W_FULL, hi: mk("全一致 AD1", FULL, 1), lo: mk("エリア外れ AD2", swap("AREA_STATION_MATCH", "AREA_FAR"), 2), want: ">" },
  { id: "a4", say: "(a) 全条件一致・AD 1ヶ月 ＞ 家賃だけ少し超え（上限＋1万円以内・幅の外）・AD 2ヶ月", w: W_FULL, hi: mk("全一致 AD1", FULL, 1), lo: mk("家賃少し超え AD2", swap("RENT_OK", "RENT_SLIGHTLY_OVER"), 2, { rentRatio: 1.08 }), want: ">" },
  { id: "a5", say: "(a) 全条件一致・AD 1ヶ月 ＞ 築浅外れ・AD 3ヶ月＋フリーレント（野口さんの形）", w: W_FULL, hi: mk("全一致 AD1", FULL, 1), lo: mk("築18 AD3 FR", [...swap("BUILDING_AGE_TEXT_OK", "BUILDING_AGE_TEXT_OVER"), "FREE_RENT_MATCH"], 3, { age: 18 }), want: ">" },
  { id: "b", say: "(b) 全条件一致・AD 2ヶ月 ＞ 全条件一致・AD 1ヶ月（利益）", w: W_FULL, hi: mk("全一致 AD2", FULL, 2), lo: mk("全一致 AD1", FULL, 1), want: ">" },
  { id: "b2", say: "(b) 全条件一致・AD 1.5ヶ月 ＞ 全条件一致・AD 1ヶ月", w: W_FULL, hi: mk("全一致 AD1.5", FULL, 1.5), lo: mk("全一致 AD1", FULL, 1), want: ">" },
  { id: "c1", say: "(c) 築浅だけ外れ・AD 1ヶ月 ≧ 全条件一致・AD 0.5ヶ月（同じくらいか下）", w: W_FULL, hi: mk("築18 AD1", swap("BUILDING_AGE_TEXT_OK", "BUILDING_AGE_TEXT_OVER"), 1, { age: 18 }), lo: mk("全一致 AD0.5", FULL, 0.5), want: "~<=" },
  { id: "c2", say: "(c) 徒歩だけ少し超え・AD 1ヶ月 ≧ 全条件一致・AD 0.5ヶ月（同じくらいか下）", w: W_FULL, hi: mk("徒歩14 AD1", swap("WALK_OK", "WALK_SLIGHTLY_OVER"), 1, { walk: 14 }), lo: mk("全一致 AD0.5", FULL, 0.5), want: "~<=" },
  { id: "c3", say: "(c) 隣の駅（幅の内側）・AD 1ヶ月 ≧ 全条件一致・AD 0.5ヶ月", w: W_FULL, hi: mk("隣の駅 AD1", swap("AREA_STATION_MATCH", "AREA_STATION_WIDE"), 1), lo: mk("全一致 AD0.5", FULL, 0.5), want: "~<=" },
  { id: "d", say: "(d) 必須のオートロック × ・AD 3ヶ月 は 全条件一致・AD なし より下", w: W_FULL, hi: mk("全一致 ADなし", FULL, 0), lo: mk("必須× AD3", [...FULL, "EQUIP_AUTOLOCK_NG", EQUIP_CAP_CODE], 3), want: ">" },
  { id: "d2", say: "(d) 家賃1割超え（保留）・AD 3ヶ月 は 全条件一致・AD 1未満 より下", w: W_FULL, hi: mk("全一致 AD0.5", FULL, 0.5), lo: mk("家賃超え AD3", swap("RENT_OK", "RENT_OVER_110"), 3), want: ">" },
  { id: "e", say: "(e) AD 順: AD 1ヶ月未満 ＞ AD なし（同じ物件）", w: W_FULL, hi: mk("AD0.5", FULL, 0.5), lo: mk("ADなし", FULL, 0), want: ">=" },
  { id: "e2", say: "(e) AD 順: AD 1ヶ月 ＞ AD 1ヶ月未満（同じ物件）", w: W_FULL, hi: mk("AD1", FULL, 1), lo: mk("AD0.5", FULL, 0.5), want: ">" },
  { id: "e3", say: "(e) AD 不明（読めない）は下げない: AD 不明 ＞ AD 1ヶ月未満", w: W_FULL, hi: mk("AD不明", FULL, null), lo: mk("AD0.5", FULL, 0.5), want: ">" },
  { id: "f1", say: "(f) 築浅を書いた人: 築5年・AD 1ヶ月 ＞ 築9年・AD 1.5ヶ月（段で新しい方）", w: W_FULL, hi: mk("築5 AD1", FULL, 1, { age: 5 }), lo: mk("築9 AD1.5", FULL, 1.5, { age: 9 }), want: ">" },
  { id: "f2", say: "(f) 築年を書いていない人: 築18年・AD 2ヶ月 ＞ 築5年・AD 1ヶ月（書いていない条件で AD を覆さない）", w: W_PLAIN, hi: mk("築18 AD2", ["RENT_OK", "FLOOR_PLAN_MATCH", "WALK_OK"], 2, { age: 18 }), lo: mk("築5 AD1", ["RENT_OK", "FLOOR_PLAN_MATCH", "WALK_OK"], 1, { age: 5 }), want: ">" },
  { id: "g1", say: "(g) 家賃を低くしたい人: 上限の0.8・AD 1ヶ月 ＞ 上限の0.98・AD 1.5ヶ月", w: W_CHEAP, hi: mk("0.8 AD1", FULL, 1, { rentRatio: 0.8 }), lo: mk("0.98 AD1.5", FULL, 1.5, { rentRatio: 0.98 }), want: ">" },
  { id: "g2", say: "(g) 家賃を書いていない人: 上限の0.98・AD 1.5ヶ月 ＞ 上限の0.8・AD 1ヶ月", w: W_FULL, hi: mk("0.98 AD1.5", FULL, 1.5, { rentRatio: 0.98 }), lo: mk("0.8 AD1", FULL, 1, { rentRatio: 0.8 }), want: ">" },
  { id: "h1", say: "(h) 敷礼0を書いた人: 敷礼0・AD 1ヶ月 ＞ 敷礼あり（保留）・AD 2ヶ月", w: W_FULL, hi: mk("敷礼0 AD1", FULL, 1), lo: mk("敷礼あり AD2", swap("ZERO_ZERO_MATCH", "INITIAL_COST_NOT_ZERO"), 2), want: ">" },
  { id: "h2", say: "(h) 敷礼0を書いていない人: 敷礼あり・AD 2ヶ月 ≧ 敷礼0・AD 1ヶ月（AD の差が勝つか同じくらい）", w: W_PLAIN, hi: mk("敷礼あり AD2", ["RENT_OK", "FLOOR_PLAN_MATCH", "WALK_OK"], 2), lo: mk("敷礼0 AD1", ["RENT_OK", "FLOOR_PLAN_MATCH", "WALK_OK", "ZERO_ZERO"], 1), want: "~<=" },
  { id: "i", say: "(i) 駅近を書いた人: 徒歩3分・AD 1ヶ月 ＞ 徒歩9分・AD 1.5ヶ月", w: W_EKICHIKA, hi: mk("徒歩3 AD1", FULL, 1, { walk: 3 }), lo: mk("徒歩9 AD1.5", FULL, 1.5, { walk: 9 }), want: ">" },
  { id: "i2", say: "(i) 駅近を書いていない人: 徒歩9分・AD 1.5ヶ月 ＞ 徒歩3分・AD 1ヶ月", w: W_FULL, hi: mk("徒歩9 AD1.5", FULL, 1.5, { walk: 9 }), lo: mk("徒歩3 AD1", FULL, 1, { walk: 3 }), want: ">" },
  { id: "j", say: "(j) 設備: 必須の設備○・AD 1ヶ月 と できればの設備○・AD 1ヶ月 → 必須の方が上", w: W_FULL, hi: mk("必須○", [...FULL, "EQUIP_AUTOLOCK_OK"], 1), lo: mk("普通○のみ", FULL, 1), want: ">" },
  { id: "k", say: "(k) 隣の駅だから大幅に下げない: 希望の駅・AD 1ヶ月 と 隣の駅・AD 1ヶ月 の差が 5点以内", w: W_FULL, hi: mk("希望の駅 AD1", FULL, 1), lo: mk("隣の駅 AD1", swap("AREA_STATION_MATCH", "AREA_STATION_WIDE"), 1), want: "~<=" },
];

function runExamples(): void {
  console.log("\n■ 例の釣り合い（左 hi が右 lo より上か。~<= は「差 5点以内の下か同点・または上」を合格＝同じくらいか下）");
  const head = ["例", ...PLANS.map((p) => p.name)];
  console.log(head.join(" | "));
  const fails: Record<string, string[]> = {};
  for (const ex of EXAMPLES) {
    const cells = PLANS.map((p) => {
      const a = scorePlan(ex.hi, ex.w, p).score, b = scorePlan(ex.lo, ex.w, p).score;
      let ok: boolean;
      if (ex.want === ">") ok = a > b;
      else if (ex.want === ">=") ok = a >= b;
      else ok = ex.id === "k" ? a - b <= 5 : a >= b - 5; // (c)(h2): 上 hi が lo と同じくらい（−5 まで）か上
      if (!ok) (fails[p.name] ??= []).push(ex.id);
      return `${a} vs ${b} ${ok ? "○" : "×"}`;
    });
    console.log(`${ex.say}\n    ${cells.map((c, i) => `${PLANS[i].name}: ${c}`).join(" ／ ")}`);
  }
  console.log("  → 合格しなかった例: " + PLANS.map((p) => `${p.name} ${fails[p.name]?.join(",") || "なし"}`).join(" ／ "));
  // 内訳（案B の全一致 AD1 と 築18 AD2）
  for (const p of [PLAN_B]) {
    for (const c of [EXAMPLES[0].hi, EXAMPLES[0].lo]) console.log(`  内訳 ${p.name} ${c.key}: ${scorePlan(c, W_FULL, p).parts.filter(([, v]) => v).map(([k, v]) => `${k}${v > 0 ? "+" : ""}${v}`).join(" ")}`);
  }
}

// ═══ 5. 実データ ═════════════════════════════════════════════════════════════════

type Ep = { id: string; at: string; source: string; segments: string[]; wants: Wants; wantTags: string[]; cands: Cand[] };

async function all(build: (from: number, to: number) => PromiseLike<{ data: Row[] | null; error: { message: string } | null }>, page = 1000, maxPages = 60): Promise<Row[]> {
  let out: Row[] = [];
  for (let p = 0; p < maxPages; p++) {
    const { data, error } = await build(p * page, p * page + page - 1);
    if (error) throw new Error(error.message);
    if (!data?.length) break;
    out = out.concat(data);
    if (data.length < page) break;
  }
  return out;
}
const chunks = <T,>(xs: T[], n: number) => { const o: T[][] = []; for (let i = 0; i < xs.length; i += n) o.push(xs.slice(i, i + n)); return o; };
function groupBy<T extends Row>(xs: T[], key: string): Map<string, T[]> { const m = new Map<string, T[]>(); for (const x of xs) { const k = x[key]; if (!k) continue; if (!m.has(k)) m.set(k, []); m.get(k)!.push(x); } return m; }
const CUST_COLS = "id, rent_max, max_rent, rent_min, floor_plan, layout, walk_minutes, building_age, initial_cost_limit, preferences, ng_points, other_requests, additional_conditions, pet, move_in_time, created_at, floor_area_min, raw_format_text, desired_area, commute_station, commute_minutes, structure_types";

function wantTagsOf(w: Wants): string[] {
  const t: string[] = [];
  if (w.age.src === "text") t.push("築浅を書いた"); if (w.age.src === "column") t.push("築年の列");
  if (w.walk.src === "text") t.push("駅近を書いた");
  if (w.rentCheap.on) t.push("家賃を低くしたい");
  if (w.lowInit === "form") t.push("敷礼0を書いた"); if (w.lowInit === "history") t.push("敷礼0（推した）");
  if (w.equip.size) t.push("設備を書いた");
  if ([...w.equip.values()].includes("strong")) t.push("必須の設備");
  return t;
}

async function loadEps(sb: SupabaseClient, days: number): Promise<{ eps: Ep[]; counts: Record<string, number> }> {
  const until = Date.now();
  const sinceIso = new Date(until - days * D).toISOString();
  const counts: Record<string, number> = {};
  const snaps = (await all((a, b) => sb.from("recommendation_snapshots").select("id, conversation_id, property_customer_id, sent_at, star_in_candidates, candidate_count, candidates")
    .gte("sent_at", sinceIso).gte("candidate_count", 2).order("id").range(a, b) as never, 300)).filter((s) => s.conversation_id !== YUMA && s.property_customer_id);
  const pools = await all((a, b) => sb.from("property_candidate_pools").select("id, property_customer_id, site, candidates, sent_at").gte("sent_at", sinceIso).order("sent_at").range(a, b) as never, 300);
  counts.snapshot_rows = snaps.length; counts.pool_rows = pools.length;
  const yuma = new Set<string>();
  { const { data } = await sb.from("conversations").select("property_customer_id").eq("id", YUMA).maybeSingle(); if (data?.property_customer_id) yuma.add(String(data.property_customer_id)); }
  const ids = [...new Set([...snaps, ...pools].map((r) => r.property_customer_id as string).filter((x) => x && !yuma.has(x)))];
  const custs = new Map<string, Row>(); const hist: Row[] = [], sents: Row[] = [], pats: Row[] = [];
  const sentSince = new Date(until - (days + 200) * D).toISOString();
  for (const c of chunks(ids, 80)) {
    const { data, error } = await sb.from("property_customers").select(CUST_COLS).in("id", c);
    if (error) throw new Error(error.message);
    for (const r of (data ?? []) as Row[]) custs.set(r.id, r);
    hist.push(...await all((a, b) => sb.from("property_condition_history").select("property_customer_id, changed_field, old_value, created_at").in("property_customer_id", c).range(a, b) as never));
    sents.push(...await all((a, b) => sb.from("sent_properties").select("property_customer_id, property_name, room_no, rent, delivery, source, sent_at").in("property_customer_id", c).gte("sent_at", sentSince).range(a, b) as never));
    pats.push(...await all((a, b) => sb.from("property_selection_patterns").select("property_customer_id, selling_points, selection_label, created_at").in("property_customer_id", c).range(a, b) as never));
  }
  const histOf = groupBy(hist, "property_customer_id"), sentOf = groupBy(sents, "property_customer_id"), patOf = groupBy(pats, "property_customer_id");
  const ctxAt = (pc: string, at: string, beforeMs: number): JudgeContext | null => {
    const base = custs.get(pc); if (!base) return null;
    const { c } = customerAt(base, (histOf.get(pc) ?? []) as ConditionHistoryRow[], at);
    const before = (sentOf.get(pc) ?? []).filter((s) => Date.parse(s.sent_at) < beforeMs && isCustomerSend(s)) as SentRowLike[];
    const pt = (patOf.get(pc) ?? []).filter((p) => Date.parse(p.created_at) < Date.parse(at)) as PatternRowLike[];
    return buildContext(c, before, pt, at);
  };
  const toEp = (e: Episode | null, ctx: JudgeContext): Ep | null => {
    if (!e) return null;
    const wants = readWants(ctx.customer, ctx.profile);
    return {
      id: e.id, at: e.at, source: e.source, segments: e.segments, wants, wantTags: wantTagsOf(wants),
      cands: e.cands.map((c) => ({ key: c.key, chosen: c.chosen, codes: c.codes, age: c.feats.building_age ?? null, walk: c.feats.walk ?? null, rentRatio: c.feats.rent_ratio ?? null, adMonths: c.feats.ad_months ?? null })),
    };
  };
  const eps: Ep[] = [];
  for (const s of snaps) {
    const pc = String(s.property_customer_id); if (yuma.has(pc)) continue;
    const cands = (typeof s.candidates === "string" ? JSON.parse(s.candidates) : s.candidates) as Row[];
    const first = Math.min(...(cands ?? []).map((c) => Date.parse(String(c.sent_at ?? ""))).filter(Number.isFinite), Date.parse(s.sent_at));
    const ctx = ctxAt(pc, s.sent_at, first - 60_000); if (!ctx) continue;
    try { const e = toEp(episodeFromSnapshot(s, ctx), ctx); if (e) eps.push(e); } catch { counts.snapshot_errors = (counts.snapshot_errors ?? 0) + 1; }
  }
  for (const p of pools) {
    const pc = String(p.property_customer_id ?? ""); if (!pc || yuma.has(pc)) continue;
    const ctx = ctxAt(pc, p.sent_at, Date.parse(p.sent_at) - 10 * 60_000); if (!ctx) continue;
    try { const e = toEp(episodeFromPool(p, sentOf.get(pc) ?? [], ctx), ctx); if (e) eps.push(e); } catch { counts.pool_errors = (counts.pool_errors ?? 0) + 1; }
  }
  counts.episodes_snapshot = eps.filter((e) => e.source === "snapshot").length;
  counts.episodes_pool = eps.filter((e) => e.source === "pool").length;
  void POOL_SENT_WINDOW_MS;
  return { eps, counts };
}

type Metrics = { n: number; top1: number; top3: number; rel: number; rand1: number; tied: number; atCap: number; cands: number };
function metrics(eps: Ep[], p: Plan): Metrics {
  let top1 = 0, top3 = 0, rel = 0, r1 = 0, tied = 0, atCap = 0, cands = 0;
  for (const e of eps) {
    const s = e.cands.map((c) => ({ c, s: scorePlan(c, e.wants, p).score }));
    cands += s.length; atCap += s.filter((x) => x.s >= SCORE_MAX).length;
    const max = Math.max(...s.map((x) => x.s));
    const top = s.filter((x) => x.s === max);
    top1 += top.filter((x) => x.c.chosen).length / top.length;
    if (top.length === s.length) tied++;
    const un = s.filter((x) => !x.c.chosen);
    let best = Infinity, rs = 0, k = 0;
    for (const x of s.filter((y) => y.c.chosen)) {
      const gt = s.filter((y) => y !== x && y.s > x.s).length, eq = s.filter((y) => y !== x && y.s === x.s).length;
      best = Math.min(best, 1 + gt + eq / 2);
      rs += (un.filter((y) => y.s > x.s).length + un.filter((y) => y.s === x.s).length / 2) / un.length; k++;
    }
    if (best <= 3) top3++;
    rel += rs / k;
    r1 += (s.length - un.length) / s.length;
  }
  const N = eps.length || 1;
  return { n: eps.length, top1: top1 / N, top3: top3 / N, rel: rel / N, rand1: r1 / N, tied, atCap, cands };
}
const fmtM = (m: Metrics) => `${m.n}回 1位 ${pct(m.top1)}（でたらめ ${pct(m.rand1)}）・3位以内 ${pct(m.top3)}・相対順位 ${m.rel.toFixed(3)}・全部同点 ${m.tied}・200点に張り付き ${m.atCap}/${m.cands}`;

/** 選んだ物と選ばなかった物で案の点が動く回（今と案で1位が変わる・選んだ物の順位が動く） */
function diffs(eps: Ep[], p: Plan) {
  const out: Array<{ e: Ep; beforeTop: Cand; afterTop: Cand; chosenBefore: number; chosenAfter: number }> = [];
  for (const e of eps) {
    const bs = e.cands.map((c) => ({ c, s: scoreCurrent(c, e.wants) })), as = e.cands.map((c) => ({ c, s: scorePlan(c, e.wants, p).score }));
    const top = (xs: typeof bs) => xs.slice().sort((a, b) => b.s - a.s)[0];
    const pos = (xs: typeof bs) => { const ch = xs.filter((x) => x.c.chosen); return Math.min(...ch.map((x) => 1 + xs.filter((y) => y.s > x.s).length)); };
    const bt = top(bs), at = top(as);
    if (bt.c.key !== at.c.key && bt.s !== at.s) out.push({ e, beforeTop: bt.c, afterTop: at.c, chosenBefore: pos(bs), chosenAfter: pos(as) });
  }
  return out;
}

function brief(c: Cand, w: Wants, p: Plan): string {
  const r = scorePlan(c, w, p);
  const ad = c.codes.find((x) => /^AD_(VERY_HIGH|2_5M|HIGH|1_5M|1M)(_HELD)?$/.test(x)) ?? c.codes.find((x) => /^AD_(NONE|UNKNOWN)$/.test(x)) ?? (r.parts.some(([k]) => k === "AD_UNDER_1M") ? "AD<1" : "AD?");
  const fit = c.codes.map(fitOf).filter(Boolean).map((f) => `${f!.fam.replace(/^設備:/, "")}${f!.v === "ok" ? "○" : f!.v === "wide" ? "△" : f!.v === "unread" ? "?" : "×"}`).join(" ");
  const extra = r.parts.filter(([k, v]) => v && /^(AGE_|WALK_NEAR|WALK_TEXT|RENT_CHEAP|FIT_|AD_UNDER)/.test(k)).map(([k, v]) => `${k}${v > 0 ? "+" : ""}${v}`).join(" ");
  return `${c.chosen ? "★" : "  "}${c.key.slice(0, 22)} 今${scoreCurrent(c, w)}→${p.name}${r.score} [${ad}] 築${c.age ?? "?"} 徒歩${c.walk ?? "?"} 家賃比${c.rentRatio ?? "?"} | ${fit}${extra ? ` | ${extra}` : ""}`;
}

// ═══ 6. 売上サポの回（目で読む・野口さんの回を含む） ═══════════════════════════════

async function pickupRounds(sb: SupabaseClient, show: Plan[]): Promise<void> {
  const rows = await all((a, b) => sb.from("property_pickups").select("id, batch_id, property_customer_id, conversation_id, created_at, site, rank, property_name, room_no, summary_text, pdf_text, score, verdict, reason_codes, recommended, status, complete_group_id").order("id").range(a, b) as never);
  console.log(`\n■ 売上サポ（property_pickups ${rows.length}行・スタッフの送付 ${rows.filter((r) => r.status === "sent").length}行＝正解の材料にならない。1位の入れ替わりを目で読む）`);
  const byCust = groupBy(rows.filter((r) => r.conversation_id !== YUMA && r.property_customer_id), "property_customer_id");
  for (const [pc, rs] of byCust) {
    const { data: cust } = await sb.from("property_customers").select(CUST_COLS).eq("id", pc).maybeSingle();
    if (!cust) continue;
    const prof = buildCustomerProfile(cust as never, [], [], null, { today: rs[0].created_at });
    const w = readWants(cust, prof);
    const batches = [...groupBy(rs, "batch_id").entries()].map(([batch_id, b]) => ({ batch_id, created_at: b[0].created_at as string, site: b[0].site as string, round_id: b[0].complete_group_id as string | null, rows: b }));
    for (const round of groupPickupRounds(batches)) {
      const rr = round.batches.flatMap((b) => b.rows);
      if (rr.length < 2) continue;
      const cands: Cand[] = rr.map((r) => {
        const f = parsePropertyFacts(r.summary_text);
        const y = String(r.pdf_text ?? "").normalize("NFKC").match(/築年(?:月)?\s*(\d{4})\s*年\s*(\d{1,2})?/);
        const age = y ? Math.max(0, Math.floor((Date.parse(r.created_at) - Date.UTC(+y[1], (y[2] ? +y[2] : 1) - 1, 1)) / (365.25 * D))) : f.buildingAge;
        const total = f.rentYen != null ? f.rentYen + (f.adminFeeYen ?? 0) : null;
        return {
          key: `${r.id} ${String(r.property_name ?? "").slice(0, 16)}`, chosen: r.recommended === 2, codes: (r.reason_codes ?? []) as string[], age,
          walk: f.walkMinutes, rentRatio: total != null && prof.rentMax ? +(total / prof.rentMax).toFixed(3) : null, adMonths: f.adMonths,
        };
      });
      console.log(`\n  ◆ お客様 ${pc.slice(0, 8)}・回 ${round.created_at.slice(0, 16)}（${rr.length}件）・書いた条件: ${wantTagsOf(w).join("・") || "なし"}（★＝DeepSeek の🌟★・正解ではない）`);
      for (const p of show) {
        const sorted = cands.slice().sort((a, b) => scorePlan(b, w, p).score - scorePlan(a, w, p).score);
        console.log(`   [${p.name}] 上位: ${sorted.slice(0, 4).map((c) => `${c.key.split(" ")[0]}(${scorePlan(c, w, p).score})`).join(" > ")}`);
      }
      const recP = show[show.length - 1];
      for (const c of cands.slice().sort((a, b) => scorePlan(b, w, recP).score - scorePlan(a, w, recP).score).slice(0, 6)) console.log(`     ${brief(c, w, recP)}`);
    }
  }
}

// ═══ 7. 今の重みの表 ═══════════════════════════════════════════════════════════════

function currentTable(): void {
  console.log("■ 今の札（REASON_POINTS）を「お客様の条件に合う」「利益（AD）」「そのほか」に分けた表");
  const fams = new Map<string, Array<[string, number, FitVerdict]>>();
  const ad: Array<[string, number]> = [], other: Array<[string, number]> = [];
  for (const [code, pts] of Object.entries(REASON_POINTS)) {
    const f = fitOf(code);
    if (f) { if (!fams.has(f.fam)) fams.set(f.fam, []); fams.get(f.fam)!.push([code, pts, f.v]); }
    else if (isAdCode(code)) ad.push([code, pts]);
    else other.push([code, pts]);
  }
  for (const [fam, xs] of fams) console.log(`  条件:${fam}  ` + xs.map(([c, p, v]) => `${c}(${v}) ${p > 0 ? "+" : ""}${p}`).join("／"));
  console.log("  条件:設備（EQUIP_*）  ○ +3（合計 +15 まで）／× −10 保留／必須の × は上限20点／記載なし・相談 0");
  console.log("  条件:入居の条件（CONDITION_*）  ○ +3／不可 −10 保留／相談・記載なし 0 ・画像（IMAGE_*）○ +5／× −10 保留");
  console.log("  利益:AD  " + ad.map(([c, p]) => `${c} ${p > 0 ? "+" : ""}${p}`).join("／"));
  console.log("  そのほか  " + other.map(([c, p]) => `${c} ${p > 0 ? "+" : ""}${p}`).join("／"));
}

// ═══ main ═════════════════════════════════════════════════════════════════════════

async function main() {
  currentTable();
  console.log("\n■ 案"); for (const p of PLANS.slice(1)) console.log(`  ${p.name}: ${p.label}`);
  runExamples();
  if (args.examples) return;
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
  const days = args.days ? parseInt(String(args.days), 10) : 400;
  const { eps, counts } = await loadEps(sb, days);
  console.log(`\n■ 実データ（${days}日・正解＝スタッフが選んで送った物）`, counts);
  const groups: Array<[string, Ep[]]> = [
    ["全体", eps], ["🌟の時点（snapshot）", eps.filter((e) => e.source === "snapshot")], ["拡張の回（pool）", eps.filter((e) => e.source === "pool")],
    ["築浅を書いた人", eps.filter((e) => e.wants.age.src === "text")], ["築年の列がある人", eps.filter((e) => e.wants.age.src === "column")],
    ["駅近を書いた人", eps.filter((e) => e.wants.walk.src === "text")], ["家賃を低くしたい人", eps.filter((e) => e.wants.rentCheap.on)],
    ["敷礼0を書いた人", eps.filter((e) => e.wants.lowInit === "form")], ["設備を書いた人", eps.filter((e) => e.wants.equip.size > 0)],
    ["何も書いていない人（上の5つ無し）", eps.filter((e) => !e.wants.age.src && e.wants.walk.src !== "text" && !e.wants.rentCheap.on && e.wants.lowInit !== "form" && !e.wants.equip.size)],
    ["材料の厚い回（築年か徒歩か家賃比が半分以上の候補にある）", eps.filter((e) => e.cands.filter((c) => c.age != null || c.walk != null || c.rentRatio != null).length * 2 >= e.cands.length)],
    ["AD の分かる候補が2件以上ある回", eps.filter((e) => e.cands.filter((c) => c.adMonths != null || c.codes.some((x) => AD_TIER.test(x) || x === "AD_NONE")).length >= 2)],
  ];
  for (const [label, g] of groups) {
    if (!g.length) { console.log(`  ${label}: 0回`); continue; }
    console.log(`  ${label}`);
    for (const p of PLANS) console.log(`    ${p.name}: ${fmtM(metrics(g, p))}`);
  }
  // 候補の材料の厚さ
  const cs = eps.flatMap((e) => e.cands);
  const has = (f: (c: Cand) => boolean) => pct(cs.filter(f).length / (cs.length || 1));
  console.log(`  候補の材料: ${cs.length}件 築年 ${has((c) => c.age != null)}・徒歩 ${has((c) => c.walk != null)}・家賃比 ${has((c) => c.rentRatio != null)}・AD ${has((c) => c.adMonths != null)}・AD 1未満 ${has((c) => c.adMonths != null && c.adMonths > 0 && c.adMonths < 1)}・AD なし ${has((c) => c.codes.includes("AD_NONE"))}`);
  console.log(`  書いた条件の人（回）: ` + ["築浅を書いた", "築年の列", "駅近を書いた", "家賃を低くしたい", "敷礼0を書いた", "敷礼0（推した）", "設備を書いた", "必須の設備"].map((t) => `${t} ${eps.filter((e) => e.wantTags.includes(t)).length}`).join("・"));

  const show = args.show ? parseInt(String(args.show), 10) : 12;
  for (const p of [PLAN_B]) {
    const d = diffs(eps, p);
    const better = d.filter((x) => x.chosenAfter < x.chosenBefore).length, worse = d.filter((x) => x.chosenAfter > x.chosenBefore).length;
    console.log(`\n■ 案${p.name}で1位が入れ替わった回: ${d.length}/${eps.length}（選んだ物の順位が上がった ${better}・下がった ${worse}・同じ ${d.length - better - worse}）`);
    const pick = [...d.filter((x) => x.chosenAfter > x.chosenBefore).slice(0, Math.ceil(show / 2)), ...d.filter((x) => x.chosenAfter <= x.chosenBefore).slice(0, Math.floor(show / 2))];
    for (const x of pick) {
      console.log(`  ◇ ${x.e.id}（${x.e.at.slice(0, 10)}・書いた条件: ${x.e.wantTags.join("・") || "なし"}）選んだ物の順位 ${x.chosenBefore}位→${x.chosenAfter}位`);
      for (const c of x.e.cands.slice().sort((a, b) => scorePlan(b, x.e.wants, p).score - scorePlan(a, x.e.wants, p).score).slice(0, 4)) console.log(`     ${brief(c, x.e.wants, p)}`);
    }
  }
  void SEGMENT_JA; void segmentsOf;
  await pickupRounds(sb, [CURRENT, PLAN_A, PLAN_B, PLAN_C]);
}
main().catch((e) => { console.error(e); process.exit(1); });
