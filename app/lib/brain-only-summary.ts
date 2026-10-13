// お客様の要約はブレインの戦略の層だけが書く（2026-10-13 竹内さん「1〜6 順に行う。確認事項は全部おすすめで」・要約をブレインだけにする＝はい）
//
// 旧: 送信の後（page.tsx の送信の後・log-aix-usage の AIX の後）に毎回 /api/customer-summary（Sonnet・30日 約970回 $15）を呼び、
//   ブレインの戦略の層（brain-core consolidateStrategy・お客様の発言10件ごとか72時間で作り直し＝brain-layers decideStrategyRefresh）と
//   同じ property_customers.ai_summary / ai_summary_json を交互に上書きしていた（設計知見 P0 9eb6aa9c「判断はすべてブレイン基準」）。
// 新: 送信の後の要約の呼び出しをやめ、戦略の層が書く。要約の側にしか無かった物を戦略の層に移す:
//   ① 人間性が似た成約事例の RAG（match_reply_knowledge の成約パターン・当たった予測）→ 戦略の材料に（summary-winning-patterns.ts）
//   ② 予測の記録（next_action_logs・winning_pattern_logs）→ 答え合わせ（log-aix-usage のギャップ分析・週の eval-winning-pattern）が続くように
//   ③ AIX の記録が足す our_actions・内覧の印（inspection・estimate）は戦略の層が出さない → 上書きで消さない
// 戻す: BRAIN_ONLY_SUMMARY=off（サーバ）／NEXT_PUBLIC_BRAIN_ONLY_SUMMARY=off（画面）。aix_meta_patch は AIX_META_PATCH=on で戻す。

type Env = Record<string, string | undefined>;

/** 送信の後に /api/customer-summary を呼ばない（既定 on） */
export function brainOnlySummaryEnabled(env: Env = process.env): boolean {
  return (env.BRAIN_ONLY_SUMMARY ?? "").trim().toLowerCase() !== "off";
}

/**
 * AIX の後の Haiku によるブレインの判断の書き換え（aix_meta_patch）。既定 off（10/13）。
 *   送った AIX は aix_usage_logs → 行動台帳（action-ledger）でブレインが次の判断で読む＝事実は台帳に任せる。AIX_META_PATCH=on で戻す
 */
export function aixMetaPatchEnabled(env: Env = process.env): boolean {
  return (env.AIX_META_PATCH ?? "").trim().toLowerCase() === "on";
}

/** 戦略の層に成約パターン（要約側の RAG）を渡す（既定 on・STRATEGY_SUMMARY_PATTERNS=off で止める） */
export function strategySummaryPatternsEnabled(env: Env = process.env): boolean {
  return (env.STRATEGY_SUMMARY_PATTERNS ?? "").trim().toLowerCase() !== "off";
}

/** 戦略の層が出さない（AIX の記録・内覧前の挨拶が書く）欄。上書きで消さない */
export const SUMMARY_JSON_KEEP_FIELDS = ["our_actions", "inspection", "estimate"] as const;

/**
 * 戦略の層の ai_summary_json を保存する形にする。前の JSON の our_actions・inspection・estimate は、新しい JSON に無ければ残す。
 *   新しい JSON が null なら null（保存しない）
 */
export function mergeStrategySummaryJson(existing: unknown, next: unknown): Record<string, unknown> | null {
  if (!next || typeof next !== "object" || Array.isArray(next)) return null;
  const out: Record<string, unknown> = { ...(next as Record<string, unknown>) };
  if (existing && typeof existing === "object" && !Array.isArray(existing)) {
    const ex = existing as Record<string, unknown>;
    for (const k of SUMMARY_JSON_KEEP_FIELDS) {
      const cur = out[k];
      const empty = cur == null || (Array.isArray(cur) && cur.length === 0);
      if (empty && ex[k] != null) out[k] = ex[k];
    }
  }
  return out;
}

/**
 * 要約の予測の記録（next_action_logs・winning_pattern_logs）の行。テストの会話は入れない（呼ぶ側が isTest を渡す）。
 *   旧は /api/customer-summary が書いていた（log-aix-usage のギャップ分析・eval-winning-pattern の答え合わせの基準点）
 */
export function summaryPredictionRows(i: {
  customerId: string | null;
  conversationId: string | null;
  summaryJson: Record<string, unknown> | null;
  isTest: boolean;
}): {
  nextAction: { customer_id: string; conversation_id: string | null; predicted_action: string } | null;
  winningPattern: { conversation_id: string; customer_id: string; predicted_pattern: string; personality_profile: string | null; actual_outcome: null; was_correct: null } | null;
} {
  if (i.isTest || !i.customerId || !i.summaryJson) return { nextAction: null, winningPattern: null };
  const s = i.summaryJson;
  const str = (v: unknown) => (typeof v === "string" && v.trim() && v.trim() !== "null" ? v.trim() : null);
  const na = str(s.next_action);
  const wp = str(s.winning_pattern);
  return {
    nextAction: na ? { customer_id: i.customerId, conversation_id: i.conversationId, predicted_action: na } : null,
    winningPattern: wp && i.conversationId
      ? { conversation_id: i.conversationId, customer_id: i.customerId, predicted_pattern: wp, personality_profile: str(s.personality_profile), actual_outcome: null, was_correct: null }
      : null,
  };
}

/** 要約側の成約パターン（fetchWinningPatterns の結果）を戦略の材料の行にする。match_winning_patterns の行と重ねない・1件 160字・4件まで */
export function formatSummaryPatternsForStrategy(rows: Array<{ content: string }>, alreadyText: string, max = 4): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of rows) {
    const t = (r.content ?? "").replace(/\s+/g, " ").trim();
    if (!t) continue;
    const key = t.slice(0, 40);
    if (seen.has(key) || (alreadyText && alreadyText.includes(key))) continue;
    seen.add(key);
    out.push(`- ${t.slice(0, 160)}`);
    if (out.length >= max) break;
  }
  return out.join("\n");
}
