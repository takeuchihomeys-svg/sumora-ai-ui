// app/lib/prompt-rules-format.ts
// ai_prompt_rules の行 → プロンプト注入用文字列 の整形（純関数・DB に依存しない・単体テストあり）
//
// 2026-09-17 竹内（AIX キャッシュ点検）: prompt-rules.ts から整形と条件フィルタだけを切り出した。
//   global（action_type IS NULL）と action 別を別々の文字列にする fetchPromptRulesSplit と、従来の連結版 fetchPromptRules が
//   同じ整形を使う（見出し・接頭辞・並びを揃えないと、同じルールでもキャッシュの鍵が外れる）。

export interface PromptRuleRow {
  rule_key: string;
  rule_text: string;
  condition_key: string | null;
  condition_value: string | null;
  priority: number;
  is_permanent?: boolean;
  action_type?: string | null;
}

export type PromptRuleConditions = Record<string, string | boolean | null | undefined>;

/** 条件フィルタ（永久ルールにも条件は適用する）。condition_key が conditions に無いルールは警告して落とす */
export function promptRuleMatchesConditions(r: PromptRuleRow, conditions: PromptRuleConditions, warn: (msg: string) => void = (m) => console.warn(m)): boolean {
  if (!r.condition_key || r.condition_value === null) return true;
  const actual = conditions[r.condition_key];
  if (actual === undefined) {
    warn(`[fetchPromptRules] unknown condition_key "${r.condition_key}" in rule — rule skipped`);
    return false;
  }
  if (actual === null) return false;
  return String(actual) === r.condition_value;
}

/** rule_text で重複排除（priority 降順ソート済みの前提で最初の出現を残す）。seen を渡すと別の一覧（global）に既にある文も落とす */
export function dedupePromptRules(rows: PromptRuleRow[], seen: Set<string> = new Set()): PromptRuleRow[] {
  return rows.filter((r) => {
    if (seen.has(r.rule_text)) return false;
    seen.add(r.rule_text);
    return true;
  });
}

/**
 * 【永久ルール】【AI学習ルール】の2節に整形する。どちらも空なら ""。
 * BOUNDARY-* ルールは【線引き】プレフィックスを付けて final-check が AIX_BOUNDARY_DB として識別できるようにする。
 */
export function formatPromptRuleSections(permanent: PromptRuleRow[], others: PromptRuleRow[]): string {
  if (!permanent.length && !others.length) return "";
  const line = (r: PromptRuleRow) => `・${r.rule_key.startsWith("BOUNDARY-") ? "【線引き】" : ""}${r.rule_text}`;
  const sections: string[] = [];
  if (permanent.length > 0) sections.push(`【永久ルール（最上位・絶対厳守）】\n${permanent.map(line).join("\n")}`);
  if (others.length > 0) sections.push(`【AI学習ルール（参考）】\n${others.map(line).join("\n")}`);
  return "\n\n" + sections.join("\n\n");
}

/** exclude（rule_key の接頭辞・完全一致）をコード側で適用する。global の行はキャッシュ済み（exclude なしで取得）なので、経路ごとの exclude はここで掛ける */
export function promptRuleNotExcluded(r: PromptRuleRow, exclude: { keyPrefixes?: string[]; keys?: string[] } = {}): boolean {
  if ((exclude.keyPrefixes ?? []).some((p) => r.rule_key.startsWith(p))) return false;
  if ((exclude.keys ?? []).includes(r.rule_key)) return false;
  return true;
}
