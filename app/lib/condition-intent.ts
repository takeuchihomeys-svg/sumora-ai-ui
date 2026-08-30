import Anthropic from "@anthropic-ai/sdk";

export type ConditionIntent = "FORMAL" | "ADD" | "REPLACE" | "EXCLUDE";

export type IntentResult = {
  intent: ConditionIntent;
  excludeTargets?: string[]; // EXCLUDE時: 除外すべきエリア名リスト
  confidence: "keyword" | "ai";
};

// ── キーワードで即判定（AIコスト0） ─────────────────────────────────────────
export function classifyByKeywords(text: string, existingArea?: string | null): IntentResult | null {
  // 丸数字2個以上 → 正式フォーマット
  const circled = (text.match(/[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮]/g) ?? []).length;
  if (circled >= 2) return { intent: "FORMAL", confidence: "keyword" };

  // EXCLUDE: 除外意図キーワード
  const excludePatterns = ["は無し", "はなし", "以外", "やめ", "NG", "除外", "抜い", "外して", "キャンセル"];
  if (excludePatterns.some((k) => text.includes(k))) {
    const targets = extractExcludeTargets(text, existingArea);
    return { intent: "EXCLUDE", excludeTargets: targets, confidence: "keyword" };
  }

  // ADD: 追加意図キーワード
  const addPatterns = ["追加", "も見たい", "も含め", "も検討", "プラス", "も良い", "もOK", "も可", "もあり", "もお願い", "もいいです", "も希望"];
  if (addPatterns.some((k) => text.includes(k))) return { intent: "ADD", confidence: "keyword" };

  // REPLACE: 差し替え意図キーワード
  const replacePatterns = ["じゃなくて", "ではなく", "に変えて", "に変更", "やっぱり", "にしてほしい"];
  if (replacePatterns.some((k) => text.includes(k))) return { intent: "REPLACE", confidence: "keyword" };

  return null; // 判定不能 → AI分類へ
}

function extractExcludeTargets(text: string, existingArea: string | null | undefined): string[] {
  if (!existingArea) return [];
  // 既存エリアを区切り文字で分割し、テキストに含まれるものを除外対象とする
  const areas = existingArea.split(/[・、,\s]+/).filter(Boolean);
  return areas.filter((a) => text.includes(a));
}

// ── 判定不能時: Claude Haikuで分類（max_tokens: 10 で激安） ─────────────────
export async function classifyByAI(
  anthropic: Anthropic,
  text: string,
  existingArea?: string | null,
): Promise<IntentResult> {
  const prompt = `お客さんからの物件条件メッセージの意図を判定してください。
現在設定中のエリア: ${existingArea ?? "（未設定）"}
メッセージ: 「${text}」

以下の1単語のみで回答（他の文字は一切不要）:
- ADD（既存条件に追加する）
- REPLACE（既存条件の一部を差し替える）
- EXCLUDE（既存条件の一部を除外・NG化する）`;

  try {
    const res = await anthropic.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 10,
      messages: [{ role: "user", content: prompt }],
    });
    const raw =
      (res.content?.[0] as { type: string; text?: string })?.text?.trim().toUpperCase() ?? "";
    if (raw.includes("ADD")) return { intent: "ADD", confidence: "ai" };
    if (raw.includes("EXCLUDE")) {
      const targets = extractExcludeTargets(text, existingArea);
      return { intent: "EXCLUDE", excludeTargets: targets, confidence: "ai" };
    }
    return { intent: "REPLACE", confidence: "ai" };
  } catch {
    // フォールバック: REPLACEは最も安全（既存条件を過剰に上書きしない）
    return { intent: "REPLACE", confidence: "ai" };
  }
}
