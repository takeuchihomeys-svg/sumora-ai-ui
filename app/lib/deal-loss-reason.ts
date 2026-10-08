// app/lib/deal-loss-reason.ts — 失注の理由を DeepSeek で読む時の決まり（純関数・プロンプトと読み取り）。計画 段4（2026-10-08）
//   ⚠ 竹内さんの決定①: 失注の理由は**弱い参考**。お客様は他の不動産屋と並行していることが多く、理由にとらわれると質が落ちる。
//     → ここで読んだ理由は deal_outcomes.lost_reason（lost_reason_source='deepseek'）に件数の集計用に残すだけ。ブレイン・学習・返信の材料に渡さない。
//   読むのは型が「他で決めた・辞退」「引越し中止・延期」の時だけ（他の型は型で理由が決まる＝ruleLossReason）。
//   渡すのは申込前（deepseek_cutoff_at の線より前）のお客様の最後の発言 3〜5通だけ・名前は伏せる（呼ぶ側 scripts/outcome-loss-reason.ts）。
import { LOSS_REASONS, type LossReason } from "./deal-outcome";

export const LOSS_REASON_SYSTEM = [
  "あなたは賃貸仲介の会話から、お客様がお部屋探しをやめた・他で決めた理由を1つ選ぶ係です。",
  "選べる理由（英語の鍵で答える）:",
  ...Object.entries(LOSS_REASONS).map(([k, v]) => `- ${k}: ${v}`),
  "文に理由が書いていなければ unknown。推測しない。",
  '答えは JSON だけ: {"reason":"<鍵>","quote":"<根拠の言葉を文から15字以内でそのまま。無ければ空>"}',
].join("\n");

export function buildLossReasonUserText(maskedCustomerTexts: ReadonlyArray<string>): string {
  return `お客様の最後の発言（古い順）:\n${maskedCustomerTexts.map((t, i) => `${i + 1}. ${t.replace(/\s+/g, " ").slice(0, 400)}`).join("\n")}`;
}

export function parseLossReason(text: string): { reason: LossReason; quote: string } | null {
  try {
    const body = String(text ?? "").match(/\{[\s\S]*\}/)?.[0] ?? "";
    const j = JSON.parse(body) as { reason?: unknown; quote?: unknown };
    const r = String(j.reason ?? "").trim();
    if (!(r in LOSS_REASONS)) return null;
    return { reason: r as LossReason, quote: String(j.quote ?? "").slice(0, 30) };
  } catch { return null; }
}
