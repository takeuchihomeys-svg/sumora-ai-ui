// app/lib/prompt-rules-format.ts
// ai_prompt_rules の行 → プロンプト注入用文字列 の整形（純関数・DB に依存しない・単体テストあり）
//
// 2026-09-17 竹内（AIX キャッシュ点検）: prompt-rules.ts から整形と条件フィルタだけを切り出した。
//   global（action_type IS NULL）と action 別を別々の文字列にする fetchPromptRulesSplit と、従来の連結版 fetchPromptRules が
//   同じ整形を使う（見出し・接頭辞・並びを揃えないと、同じルールでもキャッシュの鍵が外れる）。

import { PROMPT_RULE_CONDITION_KEYS } from "@/app/lib/prompt-rule-registry";

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

/**
 * 条件フィルタ（永久ルールにも条件は適用する）。condition_key が conditions に無いルールは落とす。
 *
 * 2026-09-18 竹内「改善おねがい」: 旧実装はどちらの場合も同じ warn を出していたので、
 *   ①この呼び出しでは渡していないだけ（他の経路では届く）
 *   ②**どの呼び出しも渡さない＝この行は永久に届かない**（設定ミス）
 * が区別できず、②が毎回のログに埋もれていた（PROP-VCC-001 は2026-07-09 以来1度も効いていなかった）。
 *   → ②は rule_key つきで「永久に届きません」と出し、点検スクリプトと同じ言葉にする。
 */
export function promptRuleMatchesConditions(r: PromptRuleRow, conditions: PromptRuleConditions, warn: (msg: string) => void = (m) => console.warn(m)): boolean {
  if (!r.condition_key || r.condition_value === null) return true;
  const actual = conditions[r.condition_key];
  if (actual === undefined) {
    warn(
      PROMPT_RULE_CONDITION_KEYS.has(r.condition_key)
        ? `[fetchPromptRules] この呼び出しは condition_key "${r.condition_key}" を渡していないため ${r.rule_key} は落ちました（他の経路では届きます）`
        : `[fetchPromptRules] 設定ミス: condition_key "${r.condition_key}"（${r.rule_key}）を渡す呼び出しが1つもありません — この行は永久に届きません。prompt-rule-registry.ts の表に足すか、条件を外してください`,
    );
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
export function formatPromptRuleSections(permanent: PromptRuleRow[], others: PromptRuleRow[], opts: { safetyTop?: boolean } = {}): string {
  if (!permanent.length && !others.length) return "";
  const line = (r: PromptRuleRow) => `・${r.rule_key.startsWith("BOUNDARY-") ? "【線引き】" : ""}${r.rule_text}`;
  const sections: string[] = [];
  if (opts.safetyTop) {
    // 2026-10-08 竹内さん Q12「永久ルールの最上位の札は安全の線だけ」＋Q1「本質（ブレインの turn-contract）を勝たせる」:
    //   永久ルールのうち安全の線（SAFETY_PERMANENT_RULE_KEYS）だけ最上位の節に置き、書き方の決まりは形だけの節（見出しは【AI学習ルール…】＝final-check-rules では core にならない）に、
    //   学習ルールは「形の参考・中身はこの番の本質に従う」と札を替える。is_permanent の列は変えない（変えると 90日の減衰で届かなくなる）。
    //   ⚠ 見出しの中に【】を入れない（final-check-rules の HEADER_RE が [^】]* で読む）
    const top = permanent.filter((r) => SAFETY_PERMANENT_RULE_KEYS.has(r.rule_key));
    const form = permanent.filter((r) => !SAFETY_PERMANENT_RULE_KEYS.has(r.rule_key));
    if (top.length > 0) sections.push(`【永久ルール（安全の線・最上位・絶対厳守）】\n${top.map(line).join("\n")}`);
    if (form.length > 0) sections.push(`【AI学習ルール（書き方の決まり・形だけ・中身はこの番の本質に従う）】\n${form.map(line).join("\n")}`);
    if (others.length > 0) sections.push(`【AI学習ルール（形の参考・中身はこの番の本質に従う。本質とぶつかる時は本質）】\n${others.map(line).join("\n")}`);
    return "\n\n" + sections.join("\n\n");
  }
  if (permanent.length > 0) sections.push(`【永久ルール（最上位・絶対厳守）】\n${permanent.map(line).join("\n")}`);
  if (others.length > 0) sections.push(`【AI学習ルール（参考）】\n${others.map(line).join("\n")}`);
  return "\n\n" + sections.join("\n\n");
}

/**
 * 2026-10-08 竹内さん Q12: 永久ルールのうち「安全の線」（金額・日付・空き・AIX の線・事実）として最上位に残す物。それ以外の永久ルールは書き方の決まり（形だけ）。
 *   7eb0ff87 物件が無い時に見積の語を使わない（AIX の線）／c98d9a80 条件の追加と物件の質問（約束の線）／4f2474ee 仲介手数料の事実／
 *   fecaf9f5 資料にある事は答える・無い事は確認（AIX の線）／6c6380d9 これ以上安くならないと断言しない（金額の線）／99eeb95e 日割家賃の事実
 *   書き方に下げた7本: 12924481（割引の一文の条件）・278492cd（初回の挨拶）・1fad83a6／6e47bed0（謝罪しない）・c81a55f2（少々お待ち）・7c600c23（承認の一言）・6e12f06f（交渉の言い方）
 */
export const SAFETY_PERMANENT_RULE_KEYS: ReadonlySet<string> = new Set([
  "hearing-condition-only-no-estimate",
  "condition-addition-vs-property-check-distinction",
  "PERM-AGENCY-FEE-001",
  "FEEDBACK-04789491-1064-4b20-87f2-dede592618c3-2",
  "FEEDBACK-1b7d2d2d-97db-46c0-a892-d00c2a75b104-1",
  "FEEDBACK-d77b3ba1-621f-4a84-8df4-1fc2e11b5ec4-1",
]);
/** 返信生成（generate_reply）だけ安全の線を最上位にする。戻す PROMPT_RULES_SAFETY_TOP=off */
export function promptRulesSafetyTop(actionType: string | null, env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return actionType === "generate_reply" && (env.PROMPT_RULES_SAFETY_TOP ?? "").toLowerCase() !== "off" && (env.TURN_CONTRACT ?? "").toLowerCase() !== "off";
}

/** exclude（rule_key の接頭辞・完全一致）をコード側で適用する。global の行はキャッシュ済み（exclude なしで取得）なので、経路ごとの exclude はここで掛ける */
export function promptRuleNotExcluded(r: PromptRuleRow, exclude: { keyPrefixes?: string[]; keys?: string[] } = {}): boolean {
  if ((exclude.keyPrefixes ?? []).some((p) => r.rule_key.startsWith(p))) return false;
  if ((exclude.keys ?? []).includes(r.rule_key)) return false;
  return true;
}

// ── 6巡目（2026-10-07 竹内さん「２最善のみなおしをする」）: 上限200で何が切られるかの並び ─────────────────────
// 旧（v1）: priority 降順 → 更新の新しい順 → 上限 200。generate_reply＋global は p9 17本＋p8 192本＝209本で、毎日 analyze-diffs が
//   足す自動の学習（DIFF-POLICY-*・WEEKLY-*・p8）が、竹内さんの指摘から作った古い FEEDBACK-*（同じ p8・7/19〜7/24）を上限の外へ押し出していた
//   （「必ず文頭で顧客名を呼びかける」・他社からの乗り換え・GLOB-TIKTOK-001 等。無効化で枠が空くと順に戻ってくる＝何が届くかが日々変わる）。
// 新（v2）: ①AIX の振り分けを書いた FEEDBACK-*-gr（p7・148本・ブレインが AIX を決めるので返信生成には渡さない・今も1本も届いていない）は入れない
//   ②同じ priority の中は「人の決め（FEEDBACK・BOUNDARY・GLOB・PROP 等）」→「自動の学習（DIFF-POLICY・WEEKLY）」の順・それぞれ更新の新しい順
//   ＝自動の学習が増えても人の決めは押し出されない（押し出されるのは一番古い自動の学習）
//   ③priority 8 以上だけ（p7・p6 は AIX の振り分け・UI の実装メモ・古い週次の学習で、無効化で枠が空くたびに下から入り込んでいた＝届く物が決まらない）。
//   見直しの後は p8 以上が上限より少なく、上限で切れる物は無い（scripts/audit-prompt-rules-review.ts で数える）。戻す: PROMPT_RULES_ORDER=v1
export type PromptRuleOrigin = "human" | "auto" | "routing";
/** ルールの出どころ（rule_key の形で決める） */
export function ruleOrigin(ruleKey: string): PromptRuleOrigin {
  const k = String(ruleKey ?? "");
  if (/^(?:DIFF-POLICY-|WEEKLY-)/.test(k)) return "auto";
  if (/^FEEDBACK-.*-gr$/.test(k)) return "routing";
  return "human";
}
/** v2 で入れる非永久ルールの priority の下限 */
export const PROMPT_RULE_V2_MIN_PRIORITY = 8;
/** 注入する非永久ルールの並びと上限（v2）。下限・振り分けの除外・並び・上限はここで決める */
export function orderRulesForInjection<T extends PromptRuleRow & { updated_at?: string | null }>(rows: ReadonlyArray<T>, opts: { limit: number; includeRouting?: boolean; minPriority?: number }): T[] {
  const ts = (r: T) => { const t = Date.parse(r.updated_at ?? ""); return Number.isFinite(t) ? t : 0; };
  const rank = (o: PromptRuleOrigin) => (o === "human" ? 0 : o === "auto" ? 1 : 2);
  return rows
    .filter((r) => (opts.includeRouting || ruleOrigin(r.rule_key) !== "routing") && (r.priority ?? 0) >= (opts.minPriority ?? PROMPT_RULE_V2_MIN_PRIORITY))
    .slice()
    .sort((a, b) => (b.priority - a.priority) || (rank(ruleOrigin(a.rule_key)) - rank(ruleOrigin(b.rule_key))) || (ts(b) - ts(a)) || a.rule_key.localeCompare(b.rule_key))
    .slice(0, opts.limit);
}
/** v2 の並びを使うか（既定 v2・PROMPT_RULES_ORDER=v1 で旧に戻す） */
export function promptRulesOrderV2(env: Record<string, string | undefined> = (typeof process !== "undefined" ? process.env : {})): boolean {
  return (env.PROMPT_RULES_ORDER ?? "").toLowerCase() !== "v1";
}
