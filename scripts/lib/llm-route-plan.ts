// scripts/lib/llm-route-plan.ts — 係（action）ごとにどのモデルへ振るかの案（純関数・台帳 #670・2026-11-25 作業員L）
//   統括役の決め（11/24 夜）: 書き手は Claude に戻すか DeepSeek に回すかの2択（OpenAI の Sol は書き手の試験で DeepSeek より下＝外す）。
//   OpenAI は文の質に直接出ない係（brain-sweep のブレイン・分類・判定・学び）で使う。竹内さんの枠: Claude 月 $200・OpenAI 月 $100。
export type Target = "claude" | "deepseek" | "gpt-6.2-sol" | "gpt-6.1-terra" | "gpt-6-luna";
export type PlanName = "A" | "B";
/** 書き手（お客様に届く文を書く係）。案 A＝Claude のまま・案 B＝DeepSeek */
export const WRITER_ACTIONS = new Set(["reply_generate_claude_writer", "aix_template", "final_check_revision", "property_recommendation", "property_check_result", "property_send", "reply_generate", "-"]);
/** 画像を読む係は OpenAI・DeepSeek に送らない（個人情報の歯止めと読みの差を確かめていない） */
const KEEP_CLAUDE = /vision|image/;
/** 判定・分類・学び（文の質に直接出ない） */
const JUDGE_LIKE = /^(final_check_(context_check|rule_check|anomaly_scan|recheck|verify)|conductor_intake|aix_desk_(consult|command)|reply_example_learn|learn_|knowledge_bulk_judge|extract_estimate|resolve_area|classify_|aix_usage_gap_learn)/;

/** 1つの係の行をどこへ振るか（route・action・今のモデル）。理由も返す */
export function targetOf(plan: PlanName, route: string, action: string, model: string): { to: Target; why: string } {
  const a = action || "-";
  if (KEEP_CLAUDE.test(a)) return { to: "claude", why: "画像の読み＝Claude のまま" };
  if (/warm/.test(a)) return { to: "claude", why: "本番のキャッシュを温める呼び出し＝Claude のまま（振った係の分は後で外せる）" };
  if (WRITER_ACTIONS.has(a)) return plan === "B" ? { to: "deepseek", why: "書き手＝案 B は DeepSeek" } : { to: "claude", why: "書き手＝案 A は Claude（文の質）" };
  if (/brain-sweep/.test(route) && /^brain_/.test(a)) return { to: "gpt-6.2-sol", why: "brain-sweep のブレイン（お客様を待たせない裏の読み直し）＝OpenAI Sol" };
  if (JUDGE_LIKE.test(a)) return /haiku/.test(model) ? { to: "gpt-6-luna", why: "判定・分類（今 Haiku）＝Luna" } : { to: "gpt-6.1-terra", why: "判定・分類・学び（今 Sonnet・Opus）＝Terra" };
  return { to: "claude", why: "本番のブレイン・そのほか＝Claude のまま" };
}
