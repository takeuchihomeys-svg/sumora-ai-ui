// app/lib/old-building-age.ts（純関数・画面とサーバーで共用・DB/LLM なし）
// 築年数が古すぎる物件は刺さりにくい — オススメの点（👑）の減点。
//
// 2026-10-06 竹内さん「築年数古すぎる物件はそもそもお客さんにささりにくい　結局は築年数の浅い物件でお客さん刺さることが多い」
//   （質問: 初期費用重視の方に築30年以上の新着が 0/43 しか刺さらなかった）
//
// ■ データ（scripts/audit-old-building-age.ts・400日・読むだけ）
//   刺さった新着（基準 v2 の strong）を築年の帯×お客様の型で数えた（値は監査の出力をそのまま書く・下の OLD_AGE_RULE の注記）
//   スタッフの選び方（🌟・送った物）は築年で差が小さい＝束に入れる段（判定の点）には入れない。👑（束の中の一番＝新着1件にもなる）だけで効かせる
//
// ■ 決めたこと
//   ・効かせるのは「初期費用重視の型」（starSituation.zero＝初期費用・敷礼0の希望）だけ。初期費用を言っていない型は古い物件でも刺さっている
//   ・リノベ済み（listing-renovation・terms.renovated・物件名）は例外＝減点しない
//   ・お客様が築年を気にしない・古くても良いと言った時（条件欄・自由文）は効かせない
//   ・築年の列を書いたお客様は判定の札（BUILDING_AGE_OK/OVER）で既に見ているので効かせない（二重に数えない）
//   ・築年が分からない物件は減点しない
//   ・スイッチ: OLD_AGE_MODE=off で止める（呼ぶ側 pickup-best が process.env を読まない画面でも動くよう、mode は引数で渡す）

export type OldAgeRule = {
  /** この築年数以上を「古すぎる」とする */
  minAge: number;
  /** 減点（負の数） */
  points: number;
};

/**
 * 2026-10-06 監査の結果で決めた線と点（scripts/audit-old-building-age.ts）。
 *   線・点を変えたら版（OLD_AGE_RULE_TAG）を上げる
 */
export const OLD_AGE_RULE: Readonly<OldAgeRule> = { minAge: 31, points: -15 };
export const OLD_AGE_RULE_TAG = "old-age@2026-10-06";

/** 「築年数は気にしない」「古くても大丈夫」「築年不問」「新築じゃなくても」等（否定の言い方を含めて1か所で読む） */
const AGE_INDIFFERENT_RE = /(?:新築|築浅)(?:じゃ|で)?(?:なくても|[はに]?こだわ(?:らない|りません|りなし)|でなくても)|古く(?:ても|て(?:も)?(?:大丈夫|いい|良い|OK|可))|古い(?:物件|建物|お部屋|部屋)?(?:でも|も)(?:大丈夫|いい|良い|OK|可)|築年数?(?:は|も)?(?:特に)?(?:気にしない|気にしません|こだわらない|こだわりません|こだわりなし|問わない|問いません|不問|何年でも|古くても)|築(?:年数?)?\s*(?:不問|問わず)/;

export function ageIndifferentText(text: string | null | undefined): boolean {
  const t = String(text ?? "").normalize("NFKC");
  if (!t.trim()) return false;
  return AGE_INDIFFERENT_RE.test(t.replace(/\s+/g, ""));
}

/** 条件欄のうち築年に関わる欄（starSituationFromConditions に渡る物の部分集合） */
export type OldAgeConditions = {
  building_age?: unknown;
  preferences?: unknown;
  ng_points?: unknown;
  other_requests?: unknown;
  additional_conditions?: unknown;
  raw_format_text?: unknown;
} | null | undefined;

/**
 * このお客様に「古すぎる物件の減点」を効かせてよいか（型は呼ぶ側で見る＝初期費用重視だけ）。
 *   築年の列を書いた人（判定の札で既に見ている）・築年を気にしないと言った人は false
 */
export function oldAgeApplies(cond: OldAgeConditions, extraTexts: readonly string[] = []): boolean {
  if (!cond) return false;
  const col = Number(String(cond.building_age ?? "").normalize("NFKC").replace(/[^0-9.]/g, ""));
  if (Number.isFinite(col) && col > 0) return false;
  const text = [cond.preferences, cond.ng_points, cond.other_requests, cond.additional_conditions, cond.raw_format_text, ...extraTexts].map((x) => String(x ?? "")).join("\n");
  return !ageIndifferentText(text);
}

/**
 * 1件の減点。古すぎる（築 minAge 年以上）・リノベ済みでない・築年が分かる時だけ。それ以外は null
 */
export function oldAgePenalty(
  c: { buildingAge?: number | null; renovated?: boolean | null },
  rule: Readonly<OldAgeRule> = OLD_AGE_RULE,
): { points: number; label: string } | null {
  const a = c.buildingAge;
  if (a == null || !Number.isFinite(a) || a < rule.minAge) return null;
  if (c.renovated === true) return null;
  if (!rule.points) return null;
  return { points: rule.points, label: `築${rule.minAge}年以上（初期費用重視の方には刺さりにくい）` };
}

export type OldAgeMode = "on" | "off";
export function oldAgeModeOf(v: string | null | undefined): OldAgeMode {
  return String(v ?? "").trim().toLowerCase() === "off" ? "off" : "on";
}
