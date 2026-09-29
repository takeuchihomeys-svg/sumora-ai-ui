// app/lib/suggest-next-action-prompt.ts
// 次の一手の予想（/api/suggest-next-action・Haiku）の固定の前置き（純関数・DB なし）
//
// 2026-09-29 竹内「クロードの部分、キャッシュを営業時間中温める」:
//   本番7日の実測（llm_usage_logs・Haiku 419回）: 鍵（sys_key_full）が9種類あり、**1日ごとに替わっていた**（JST 18:00 頃）。
//   出所は ai_prompts.aix_flow_guide（analyze-aix-flow の cron が毎日 09:00 UTC に書き直す）が固定ブロックの末尾に入っていたため、
//   ガイドが替わると絶対ルール＋AIX ロジック＋線引きルール（≈5.7k）ごと作り直しになっていた。さらに aix_logic_* の取得に ORDER BY が無く
//   並びの揺れで鍵が割れる余地があった（実測では日内は1種類）。
//   直し: ①system[0]=絶対ルール＋AIX ロジック（key 順で並べる）＋線引きルール（1h）②system[1]=フロー運用ガイド（1h・毎日替わるのはここだけ ≈0.4k）
//   ③route と温め（prefix-warm）がこの同じ関数で作る。文面は同じ（並びと切れ目だけ。Haiku の最低長 4,096 は system[0] だけで超える）
export const SUGGEST_NEXT_ACTION_MODEL = "claude-haiku-4-5-20251001";

export type PromptBlock = { type: "text"; text: string; cache_control?: { type: "ephemeral"; ttl?: "5m" | "1h" } };
const CC_1H = { type: "ephemeral" as const, ttl: "1h" as const };

export type SuggestNextActionPrefixInputs = {
  /** ai_prompts key LIKE 'aix_logic_%'（key で並べ直す） */
  aixLogicRows: Array<{ key: string; content: string | null }>;
  /** ai_prompt_rules rule_key LIKE 'BOUNDARY-%'・is_active（updated_at 降順で渡す） */
  boundaryRuleRows: Array<{ rule_key: string; action_type: string | null; rule_text: string | null }>;
  /** ai_prompts key='aix_flow_guide' の content（無ければ ""） */
  aixFlowGuide: string;
};

// ── 旧 route.ts の staticSystem の先頭（文面は同じ）──
const HEAD = `あなたは不動産営業AIのアドバイザーです。

## 絶対ルール（必ず最初に確認すること）
以下のパターンに該当する場合は、他の情報より優先してそのアクションを返すこと。

- application_push確定条件：顧客メッセージに「申し込み」「申込」「決めます」「決めたい」「こちらで申」「入居申込」のいずれかを含む
- viewing_invite確定条件：「内覧」「内見」「見学したい」「見学希望」「現地確認」「見に行」「みに行」のいずれかを含む。ただし「退去予定」「退去後」「空き予定」が同居する場合はproperty_check_resultを優先
- property_check_result確定条件：物件URL（suumo/athome/homes/chintai等）が含まれる、または「まだありますか」「空いていますか」「空室ですか」「まだ残って」等の空室確認、または「保証会社」「保証料」「審査」「ペット可」「駐車場」「礼金交渉」等の物件固有条件の質問
- estimate_sheet確定条件：「費用」「初期費用」「いくら」「スモ割」「割引」のいずれかを含む。ただし物件固有条件（保証会社・ペット等）と同居する場合はproperty_check_resultを優先
- meeting_place確定条件：日付時刻（月曜/3月5日/午後/AM/PM等）と確定表現（伺います/で大丈夫/でお願い/確定/行けます）が同時に含まれる
- applyingステータス時：会話ステータスが"applying" → application_push確定

---

不動産賃貸営業の基本フロー: ヒアリング → 物件提案 → 内覧 → 見積 → 申込 の順で顧客を次のステップへ進める。

`;

/** f-3: 確定済み線引きルール（BOUNDARY-*）を整形（-aix を優先し rule_text で重複排除・最大20行）。旧 route.ts と同じ手順 */
export function buildBoundarySection(rows: SuggestNextActionPrefixInputs["boundaryRuleRows"]): string {
  const boundaryRules = rows
    .filter((r) => (r.rule_text ?? "").trim())
    .sort((a, b) => Number(b.rule_key.endsWith("-aix")) - Number(a.rule_key.endsWith("-aix")));
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const r of boundaryRules) {
    const text = (r.rule_text as string).trim();
    if (seen.has(text)) continue;
    seen.add(text);
    const label = r.action_type && r.action_type !== "generate_reply" ? `[${r.action_type}]` : "[通常返信]";
    lines.push(`- ${label} ${text.slice(0, 200)}`);
    if (lines.length >= 20) break;
  }
  return lines.length
    ? `### 確定済みの役割分担ルール（AIXと通常返信の線引き・竹内さん確認済み・最優先で遵守）\n${lines.join("\n")}`
    : "";
}

/**
 * system ブロック（固定の前置き）。[0]=絶対ルール＋各AIXボタンの発動条件（aix_logic を key 順＋線引き）・[1]=AIXフロー運用ガイド（あれば）。どちらも 1h。
 * 毎分変わる現在時刻・会話固有の情報は user 側（route）に置く
 */
export function buildSuggestNextActionSystemBlocks(i: SuggestNextActionPrefixInputs): PromptBlock[] {
  const aixLogicSection = [...i.aixLogicRows]
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((r) => (r.content ?? ""))
    .filter(Boolean)
    .join("\n\n---\n\n");
  const boundarySection = buildBoundarySection(i.boundaryRuleRows);
  const aixLogicGuide = (aixLogicSection || boundarySection)
    ? `## 各AIXボタンの発動条件（管理UIで設定済み）\n${[aixLogicSection, boundarySection].filter(Boolean).join("\n\n---\n\n")}\n\n`
    : "";
  const aixFlowGuide = (i.aixFlowGuide ?? "").trim();
  // 改善15: analyze-aix-flow の出力上限（800字指示・max_tokens 1000）と整合させて末尾切れを防ぐ／中6: 未学習（空）なら省略
  const flowGuideSection = aixFlowGuide ? `## AIXフロー運用ガイド（学習済み）\n${aixFlowGuide.slice(0, 1000)}` : "";
  const blocks: PromptBlock[] = [{ type: "text", text: `${HEAD}${aixLogicGuide}`.trim(), cache_control: CC_1H }];
  if (flowGuideSection) blocks.push({ type: "text", text: flowGuideSection, cache_control: CC_1H });
  return blocks;
}

/** 温め用の body（本物は Anthropic SDK が model・max_tokens 100・同じ system ブロック・user で送る。thinking は本物も付けない） */
export function buildSuggestNextActionWarmBody(blocks: PromptBlock[]) {
  return { model: SUGGEST_NEXT_ACTION_MODEL, max_tokens: 1, system: blocks, messages: [{ role: "user" as const, content: "." }] };
}
