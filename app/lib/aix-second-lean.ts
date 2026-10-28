// app/lib/aix-second-lean.ts — 物件オススメの直後の2通目（✨ aix-template-generate）に、返信用のナレッジ（似た文の学習ルール・営業パターン・フレーズ）を渡さないか
//
// 2026-10-28 作業員5（竹内さん 10/28「AIX ツールのブレインがちゃんと機能すれば、もっと費用を抑えられる。質を高めて節約する部分があるか確認」）:
//   2通目の入力（試験の要求・平均 約1.5万字）を見出しごとに数えると、物件オススメの2通目に【参照すべき重要ルール】【スモラの営業パターン・原則】【スモラのフレーズ】
//   （約1.2千字）として見積書の書き方の規則が入っていた。見積書の直後の2通目は 10/01 から渡していない（同じ理由）。
//   試験（exam-aix-text --snap・物件オススメの2通目6問×2巡・DeepSeek）: 合格 3→3・3→3、平均 79.8→76.8・74.8→79.2（揺れの内）。
//   【過去の成約パターン】も外す案は2巡とも合格 3→2（物件名を書かない形に寄った）＝残す。
//   入れる AIX_SECOND_LEAN=on（既定 off）。
export function aixSecondLeanOn(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.AIX_SECOND_LEAN ?? "").trim().toLowerCase() === "on";
}
