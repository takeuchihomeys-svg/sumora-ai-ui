// app/lib/condition-classify-jev.ts
// お客様の発言が「条件のメッセージか」の分類（line-webhook-text の classifyConditionMessage＝Claude Haiku・4択）を
// Jev（TypeSafe AI・System One）に**同じ入力で**聞いて、答えを並べて記録する影の運用の部品（純関数＋呼び出し）。
//
// 2026-09-29 竹内さんの方針「質を落とさずにできる所」＝決まった選択肢から選ぶ・正解の記録がある・今の判定が言葉の一覧か LLM の分類。
//   ここは 4 つの決まった選択肢（formal_format／condition_change／condition_add／not_condition）から選ぶ問題なので Jev の choice そのもの。
//   ⚠ 前提の確認（llm_usage_logs 実測）: 「action=classify・DeepSeek・週345回」は**手元のテスト用の切り替え（env=local:deepseek-all）**の行で、
//     本番の分類は Claude Haiku（7日で120回・中央値 660ms・sys_head「お客さんのLINEメッセージを以下の4種類に分類」）。影はこの本番の経路に付ける。
//
// ── 原則 ──
//   ・本番の動きは変えない（Haiku の答えで今までどおり進み、Jev の答えは jev_shadow_logs.kind='classify_condition' に並べるだけ）
//   ・失敗しても止めない（fail-open・鍵が無ければ何もしない）。応答を待たせない（waitUntil）
//   ・state は**仮名化した後**の文だけ（呼び出し側が pii-pseudonym の createMasker で伏せる）。申込以降の会話は渡さない
//   ・正解の記録: ①決定論（isFilledSumoraForm が確定させた回＝brain_source='deterministic'）は硬い正解 ②Haiku の答え（brain_source='haiku'）は
//     「今の判定との一致」で、食い違いは人が目で読む（scripts/audit-jev-shadow.ts）
import { CONDITION_FORMAT_TEMPLATE } from "./condition-format";
import { jevSystemOne, type JevAnswer, type JevQuestion, type JevResult } from "./jev-client";

export const CONDITION_CLASSES = ["formal_format", "condition_change", "condition_add", "not_condition"] as const;
export type ConditionClass = (typeof CONDITION_CLASSES)[number];

/** Jev の選択肢（説明は Haiku のプロンプト CLASSIFY_CONDITION_SYSTEM_PROMPT の分類ルールと同じ意味） */
export const JEV_CONDITION_CLASS_OPTIONS: Record<ConditionClass, string> = {
  formal_format:    "正式フォーマット: our_condition_format に沿った条件一覧。①〜の番号付き条件項目が3つ以上含まれる（空欄・飾り・⑧の質問が付いていても正式フォーマット）",
  condition_change: "条件の変更: 特定の条件を変えたい表現（「エリアを〜に変えたい」「やっぱり〜で」「〜にしてほしい」等）",
  condition_add:    "条件の追加: 条件を足したい表現（「〜も追加で」「〜もOKです」「〜も良いです」等）",
  not_condition:    "条件ではない: 挨拶・感謝・質問・申込書類の番号付きリスト・内覧の日程調整・物件への感想・プロフィール送付・会話と無関係な番号付きリスト",
};

export type ConditionClassifyStateInput = {
  /** 仮名化済みの直近の会話（古い→新しい）。sender は "staff"／"customer" */
  recentContext: ReadonlyArray<{ sender: string; text: string }>;
  /** 仮名化済みの今回のお客様の発言 */
  customerText: string;
};

/** Jev に渡す state（Haiku の userContent と同じ材料: 直近の会話 150字×件・今回の発言 500字） */
export function buildConditionClassifyState(input: ConditionClassifyStateInput): Record<string, unknown> {
  const recent = input.recentContext
    .map((m) => ({ who: m.sender === "staff" ? "スタッフ" : "お客さん", text: String(m.text ?? "").replace(/\s+/g, " ").trim().slice(0, 150) }))
    .filter((m) => m.text.length > 0);
  return {
    our_condition_format: CONDITION_FORMAT_TEMPLATE.trim(),
    recent_conversation: recent,
    customer_message: String(input.customerText ?? "").trim().slice(0, 500),
  };
}

export function buildConditionClassifyQuestion(): JevQuestion {
  return {
    type: "choice",
    instructions: "customer_message（今回のお客さんの LINE メッセージ）は、recent_conversation の流れの中で 4 種類のどれか",
    criteria: JEV_CONDITION_CLASS_OPTIONS,
  };
}

export type ConditionClassifyDecision = {
  type: ConditionClass;
  prob: number;
  confidence: number | null;
  probabilities: Record<string, number>;
};

export function parseConditionClassifyAnswer(answer: JevAnswer | undefined): ConditionClassifyDecision | null {
  if (!answer || answer.type !== "choice" || typeof answer.choice !== "string") return null;
  if (!(CONDITION_CLASSES as ReadonlyArray<string>).includes(answer.choice)) return null;   // 知らない選択肢は使わない
  const probabilities = answer.probabilities ?? {};
  const prob = typeof probabilities[answer.choice] === "number" ? probabilities[answer.choice] : 1;
  return { type: answer.choice as ConditionClass, prob, confidence: typeof answer.confidence === "number" ? answer.confidence : null, probabilities };
}

/**
 * Jev に分類を聞く。鍵が無い・失敗は null（本番は Haiku の答えで今までどおり）。
 * ⚠ recentContext・customerText は仮名化済みで渡す。申込以降の会話は呼ばない（呼び出し側で status を見る）。
 */
export async function evaluateConditionClassifyWithJev(
  input: ConditionClassifyStateInput & { conversationId?: string | null; timeoutMs?: number; env?: Record<string, string | undefined>; fetchImpl?: typeof fetch },
): Promise<{ decision: ConditionClassifyDecision; raw: JevResult } | null> {
  const raw = await jevSystemOne({
    state: buildConditionClassifyState(input), questions: { condition_class: buildConditionClassifyQuestion() },
    action: "classify:condition", conversationId: input.conversationId ?? null, timeoutMs: input.timeoutMs, env: input.env, fetchImpl: input.fetchImpl,
  });
  if (!raw) return null;
  const decision = parseConditionClassifyAnswer(raw.answers.condition_class);
  return decision ? { decision, raw } : null;
}

/** 今の判定（本番が実際に使った答え）。deterministic＝isFilledSumoraForm が確定させた回（硬い正解）／haiku＝Claude Haiku の分類 */
export type CurrentConditionJudgement = { type: ConditionClass; confidence: number | null; source: "haiku" | "deterministic" };

/** 影の運用の1行（jev_shadow_logs・kind='classify_condition'）。列は既存の表に合わせる（brain_*＝今の判定・jev_picker*＝Jev の答え） */
export type ConditionClassifyShadowRow = {
  kind: "classify_condition";
  conversation_id: string;
  customer_msg_at: string | null;
  brain_action: ConditionClass;        // 今の判定（Haiku／決定論）の分類
  brain_prob: number | null;           // 今の判定の confidence（決定論は 1）
  brain_source: "haiku" | "deterministic";
  jev_picker_field: "condition_class";
  jev_picker: ConditionClass;          // Jev の分類
  jev_picker_value: ConditionClass;
  jev_picker_prob: number;
  jev_confidence: number | null;
  jev_model: string;
  jev_ms: number;
  answers: Record<string, unknown>;
};

export function toConditionClassifyShadowRow(
  conversationId: string, customerMsgAt: string | null,
  current: CurrentConditionJudgement,
  ev: { decision: ConditionClassifyDecision; raw: JevResult },
): ConditionClassifyShadowRow {
  return {
    kind: "classify_condition", conversation_id: conversationId, customer_msg_at: customerMsgAt,
    brain_action: current.type, brain_prob: current.source === "deterministic" ? 1 : current.confidence, brain_source: current.source,
    jev_picker_field: "condition_class", jev_picker: ev.decision.type, jev_picker_value: ev.decision.type, jev_picker_prob: ev.decision.prob,
    jev_confidence: ev.decision.confidence, jev_model: ev.raw.model, jev_ms: ev.raw.ms, answers: ev.raw.answers as Record<string, unknown>,
  };
}

// ─── 答え合わせ（scripts/audit-jev-shadow.ts が使う純関数）────────────────────
/**
 * 本番の入口が「条件として扱ったか」（type が not_condition でなく confidence 0.6 以上＝line-webhook-text の線）。
 * 4択の一致だけでなく、この**入口の判断**（通す／落とす）が同じかが実際の影響。
 */
export function passesConditionGate(type: ConditionClass, confidence: number | null): boolean {
  return type !== "not_condition" && (confidence ?? 0.5) >= 0.6;
}

export type ConditionAgreement = {
  sameClass: boolean;       // 4択が同じ
  sameGate: boolean;        // 入口の判断（通す／落とす）が同じ
  hardTruth: boolean;       // 今の判定が決定論（＝正解が硬い）
  jevRightOnHard: boolean | null;   // 硬い正解の時だけ: Jev が当てたか
};

export function compareConditionClassify(row: { brain_action: string; brain_prob: number | null; brain_source: string; jev_picker: string; jev_picker_prob: number | null }): ConditionAgreement {
  const cur = row.brain_action as ConditionClass;
  const jev = row.jev_picker as ConditionClass;
  const hardTruth = row.brain_source === "deterministic";
  return {
    sameClass: cur === jev,
    sameGate: passesConditionGate(cur, row.brain_prob) === passesConditionGate(jev, row.jev_picker_prob),
    hardTruth,
    jevRightOnHard: hardTruth ? cur === jev : null,
  };
}
