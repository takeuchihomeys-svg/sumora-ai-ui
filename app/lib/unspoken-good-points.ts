// app/lib/unspoken-good-points.ts — お客様が言っていなくても竹内さんが推す「良い点」を、物件の事実から決まった計算で AIX の推す点に持たせる（純関数・既定 off）
//
// 2026-11-21 作業員K2（台帳 #479・統括役の頼み）。判定の札（reason_codes）は、お客様が言った条件にしか付かない（ZERO_ZERO_MATCH は初期費用を抑えたい人だけ 等）。
//   竹内さん本人の物件オススメ（30日・42件のうち売上サポか画像の読みに合わせた 40件・scripts/audit-appeal-vs-codes.ts --strict）で、文に書いたのに札に無い推しどころは
//   初期費用・敷礼0 が 11（両方 11）、リノベ・室内きれい が 9（両方 0）。広さ・駅徒歩・入居日は「物件の基本の行」（㎡・徒歩N分）として書いているだけで、
//   推す言葉（広い・駅近・即入居）で数え直すと 文だけ 2・0・1＝穴ではない（物件の事実は 100% 持っている）。
//   → 足すのは2つ: 敷金・礼金がどちらも0（資料で決まった値）／リノベーション済み（資料の文字の読み terms.renovated）。点は付けない（並びは変えない＝言っていない条件で選ばない）・推す点の札だけ。
// ■ スイッチ UNSPOKEN_GOOD_POINTS: 既定 off／on（PICKUP_WHY_TO_BRAIN の「合う点」に出す）
// テスト: app/lib/__tests__/unspoken-good-points.test.ts
import { parsePropertyFacts } from "./property-brain";

type Env = Record<string, string | undefined>;
export function unspokenGoodPointsOn(env: Env = typeof process !== "undefined" ? process.env : {}): boolean {
  return String(env.UNSPOKEN_GOOD_POINTS ?? "").trim().toLowerCase() === "on";
}

export type GoodPointRow = { summary_text?: string | null; reason_codes?: string[] | null; terms?: { deposit?: number | null; keyMoney?: number | null; renovated?: boolean | null } | null };
export const GOOD_POINT_JA: Record<string, string> = {
  GOOD_ZERO_ZERO: "敷金・礼金0（お客様は言っていない良い点）",
  GOOD_RENOVATED: "リノベーション済み（お客様は言っていない良い点）",
};
/** 物件の事実 → 言っていない良い点の札（もう同じ意味の札がある時は足さない） */
export function unspokenGoodPoints(row: GoodPointRow): string[] {
  const codes = new Set(row.reason_codes ?? []);
  const out: string[] = [];
  let dep = row.terms?.deposit ?? null, key = row.terms?.keyMoney ?? null;
  if (dep == null || key == null) { try { const f = parsePropertyFacts(String(row.summary_text ?? "")); dep ??= f.depositMonths; key ??= f.keyMoneyMonths; } catch { /* 読めない */ } }
  if (dep === 0 && key === 0 && !codes.has("ZERO_ZERO_MATCH")) out.push("GOOD_ZERO_ZERO");
  if (row.terms?.renovated === true && ![...codes].some((c) => /RENOVATED/.test(c))) out.push("GOOD_RENOVATED");
  return out;
}
