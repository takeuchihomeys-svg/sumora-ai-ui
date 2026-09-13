// app/lib/final-check-rules.ts
// 最終チェック（ルール照合・自動修正）に渡す会社ルール（ai_prompt_rules の注入文字列）を、上限の中で「チェックに使うべき順」に並べて選ぶ（純関数・依存なし）。
//
// 2026-09-13 竹内さん「最終チェックの会社ルールが途中で切れている所を改善する」:
//   旧: fetchPromptRules の文字列（32,281字）を先頭から 20,000字で切っていた。並びは priority → 更新日の新しい順なので、
//   切れた後ろ 106件（12,281字）は「古い方の学習ルール」— 保証料の金額を作らない・キャンペーンを作らない・審査の見通しを言わない・
//   「スタッフ一同」を使わない・SNS への言及禁止 など、最終チェックが一番見るべき「禁止」のルールだった。
//   残っていた方は新しい DIFF-POLICY の「〜を加える／〜で終える」型（構成の指示）が多く、最終チェックが「文を足せ」と
//   言う入口になる（設計知見: 文の追加を促す検査は創作の入口・禁止を促す検査は安全）。
//   新: ①永久ルールと【線引き】は必ず全部 ②「禁止」のルール ③それ以外 ④「足せ」型のルール の順に並べ、上限の中でルールの切れ目で止める。
//   返信生成に渡す文字列（全部入り）は変えない。最終チェックに渡す分だけを並べ替える

export const FINAL_CHECK_RULES_BUDGET = 24000;

export type CheckRuleTier = "core" | "prohibit" | "other" | "additive";
const TIERS: CheckRuleTier[] = ["core", "prohibit", "other", "additive"];

/** してはいけない事を書いたルール（違反を照合できる） */
export const PROHIBIT_RE = /(禁止|してはいけない|してはならない|しない(?:こと)?[。．]|使用しない|使わない|避け|NG[:：]|絶対に|一切)/;
/** 文を足す・構成を指示するルール（最終チェックでは「欠けている」指摘＝創作の入口になりやすい） */
export const ADDITIVE_RE = /(必ず.{0,30}(?:加え|追加|含め|入れ|添え|結ぶ)|を追加|を加える|で終える|で結ぶ|OK[:：])/;

const PERMANENT_HEADER = "【永久ルール（最上位・絶対厳守）】";
const LEARNED_HEADER = "【AI学習ルール（参考）】";
const HEADER_RE = /(?:^|\n)(【(?:永久ルール|AI学習ルール)[^】\n]*】)\n/g;

export function classifyCheckRule(rule: string, permanent: boolean): CheckRuleTier {
  if (permanent || rule.startsWith("【線引き】")) return "core";
  if (ADDITIVE_RE.test(rule)) return "additive";
  if (PROHIBIT_RE.test(rule)) return "prohibit";
  return "other";
}

export type CheckRulesSelection = {
  text: string;
  totalChars: number;
  kept: Record<CheckRuleTier, number>;
  dropped: Record<CheckRuleTier, number>;
  /** 永久ルール・【線引き】だけで上限を超えた（上限より優先して全部入れた） */
  coreOverBudget: boolean;
};

const zero = (): Record<CheckRuleTier, number> => ({ core: 0, prohibit: 0, other: 0, additive: 0 });

/**
 * fetchPromptRules の文字列から、最終チェック用の会社ルールを選ぶ。
 * 形式が読めない（DB 障害時の警告文など）時は従来どおり先頭から上限で切る。
 */
export function selectRulesForCheck(dbRules: string | null | undefined, budget = FINAL_CHECK_RULES_BUDGET): CheckRulesSelection {
  const src = dbRules ?? "";
  const headers = [...src.matchAll(HEADER_RE)];
  if (!headers.length) {
    return { text: src.slice(0, budget), totalChars: src.length, kept: zero(), dropped: zero(), coreOverBudget: false };
  }

  type Rule = { text: string; tier: CheckRuleTier; permanent: boolean; order: number };
  const rules: Rule[] = [];
  headers.forEach((h, i) => {
    const bodyStart = (h.index ?? 0) + h[0].length;
    const bodyEnd = i + 1 < headers.length ? (headers[i + 1].index ?? src.length) : src.length;
    const body = src.slice(bodyStart, bodyEnd).replace(/\s+$/, "");
    const permanent = h[1].startsWith("【永久ルール");
    // ルールは「・」始まりの行。本文に改行を含むルール（【線引き】の表など）があるので「改行＋・」で区切る
    ("\n" + body).split("\n・").slice(1).forEach((t) => {
      rules.push({ text: t, tier: classifyCheckRule(t, permanent), permanent, order: rules.length });
    });
  });

  const byTier = (tier: CheckRuleTier) => rules.filter((r) => r.tier === tier);
  const kept = zero();
  const dropped = zero();
  const chosen: Rule[] = [];
  let used = PERMANENT_HEADER.length + LEARNED_HEADER.length + 4;
  for (const r of byTier("core")) { chosen.push(r); kept.core++; used += r.text.length + 2; }
  const coreOverBudget = used > budget;
  let full = coreOverBudget;
  for (const tier of TIERS.slice(1)) {
    for (const r of byTier(tier)) {
      if (!full && used + r.text.length + 2 <= budget) { chosen.push(r); kept[tier]++; used += r.text.length + 2; }
      else { full = true; dropped[tier]++; }
    }
  }

  const tierRank = (t: CheckRuleTier) => TIERS.indexOf(t);
  const line = (r: Rule) => `・${r.text}`;
  const perm = chosen.filter((r) => r.permanent).sort((a, b) => a.order - b.order);
  const learned = chosen.filter((r) => !r.permanent).sort((a, b) => tierRank(a.tier) - tierRank(b.tier) || a.order - b.order);
  const sections: string[] = [];
  if (perm.length) sections.push(`${PERMANENT_HEADER}\n${perm.map(line).join("\n")}`);
  if (learned.length) sections.push(`${LEARNED_HEADER}\n${learned.map(line).join("\n")}`);
  return { text: sections.join("\n\n"), totalChars: src.length, kept, dropped, coreOverBudget };
}

/** 同じ文字列の選択を使い回す（1回の返信生成で最終チェックが何度も呼ばれるため） */
let lastKey: string | null = null;
let lastSel: CheckRulesSelection | null = null;
export function selectRulesForCheckCached(dbRules: string | null | undefined): CheckRulesSelection {
  const key = dbRules ?? "";
  if (lastSel && lastKey === key) return lastSel;
  lastSel = selectRulesForCheck(key);
  lastKey = key;
  const droppedTotal = TIERS.reduce((s, t) => s + lastSel!.dropped[t], 0);
  if (droppedTotal > 0 || lastSel.coreOverBudget) {
    // 上限で落としたルールを必ず残す（黙って切らない）
    console.warn(JSON.stringify({ tag: "final-check:rules", totalChars: lastSel.totalChars, chars: lastSel.text.length, kept: lastSel.kept, dropped: lastSel.dropped, coreOverBudget: lastSel.coreOverBudget }));
  }
  return lastSel;
}
