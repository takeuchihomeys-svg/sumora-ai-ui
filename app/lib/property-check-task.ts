// app/lib/property-check-task.ts
// お客様の発言から「物件確認／物件出し」のタスク（line_tasks）を作るかの判定（純関数・DB 依存なし）。
// webhook（line-webhook-text の autoDetectTask）がここを使う。
//
// 2026-09-27 竹内さん「残っている課題も改善する」（お客様役のテストで見つけた: 「見積もりありがとうございます。内覧したいです」で
//   物件確認のタスクが自動で作られた）。決まり（2026-09-12 竹内「物件確認したもお客さんから物件確認の依頼があった場合となる」・
//   memory feedback_property_check_on_request）: 物件確認の依頼の判定は aix-scene-evidence の customerRequestedPropertyCheck **だけ**
//   （/api/line-tasks の作成はそこを通す）。ところが webhook は語の一覧（PROPERTY_CHECK_KEYWORDS）だけで直接 line_tasks に入れていて、
//   その判定を通っていなかった（「内覧したい」「見学したい」だけで作る）。
//   → 語の一覧は「候補」にだけ使い、物件確認は customerRequestedPropertyCheck も通った時だけ作る（作成の判定を1か所にそろえる）。
//   線は scripts/audit-property-check-task.ts（実送信・次にスタッフが押した AIX）で引いた。
import { customerRequestedPropertyCheck } from "@/app/lib/aix-scene-evidence";
import { CUST_WILL_SEND_SELF_PRED } from "@/app/lib/reply-context";

export const PROPERTY_CHECK_KEYWORDS = [
  "物件確認", "初期費用確認", "初期費用を確認",
  "内覧したい", "内覧させてほしい", "内覧お願い", "内覧を希望",
  "内覧できますか", "内覧は可能", "内覧申し込み",
  "見学したい", "見学させてほしい", "見学お願い",
  "空室確認",
];

export const PROPERTY_SEND_KEYWORDS = [
  "物件送って", "物件を送", "物件探して", "物件を探",
  "物件ありますか", "物件お願い", "物件出して", "物件を出して",
  "物件ください", "物件紹介してほしい", "物件を紹介", "物件ピックアップ",
];

const CONFIRM_PHRASES = ["確認してほしい", "確認してください", "確認お願い", "確認をお願い", "確認できますか"];
const CONFIRM_TARGETS = ["物件", "初期費用", "空室", "この部屋", "この物件"];

/** 語の一覧だけでの候補（旧 detectTaskType と同じ） */
export function detectTaskTypeByKeywords(text: string): "property_check" | "property_send" | null {
  // 2026-09-12 竹内（じゅにあ事例）: 「何件か気になる物件送ってもいいですか？」はお客様が自分で送る予告 → タスクは作らない
  if (CUST_WILL_SEND_SELF_PRED(text).yes) return null;
  if (PROPERTY_CHECK_KEYWORDS.some((k) => text.includes(k))) return "property_check";
  if (CONFIRM_PHRASES.some((p) => text.includes(p)) && CONFIRM_TARGETS.some((t) => text.includes(t))) return "property_check";
  if (PROPERTY_SEND_KEYWORDS.some((k) => text.includes(k))) return "property_send";
  return null;
}

/**
 * 作るタスクの種類。物件確認は customerRequestedPropertyCheck（/api/line-tasks と同じ判定）も通った時だけ。
 * @param recentMessages oldest-first・今回のお客様の発言まで（無ければ語だけで判定＝旧の動き）
 */
export function decideAutoTask(
  text: string,
  recentMessages?: ReadonlyArray<{ sender: string; text?: string | null }> | null,
): "property_check" | "property_send" | null {
  const kind = detectTaskTypeByKeywords(text);
  if (kind !== "property_check") return kind;
  if (!recentMessages || recentMessages.length === 0) return kind;
  return customerRequestedPropertyCheck({ recentMessages }) ? "property_check" : null;
}
