// app/lib/brain-fast-slow-priors.ts — 返信の場面（reply-scene・お客様の文だけで決まる）ごとの「下書きがそのまま送られた」前例の表（自動で書く・手で直さない）
// 書く: npx tsx --env-file=.env.local scripts/audit-fast-slow.ts --write-priors（2026-10-21・1198番）
// 中身は場面の名前と件数だけ（会話・お客様の情報は入らない）
export const BRAIN_FAST_SLOW_PRIOR_BASE = 0.331;
export const BRAIN_FAST_SLOW_SCENE_PRIORS: Readonly<Record<string, { n: number; asIs: number }>> = {
  "ack": { n: 140, asIs: 36 },
  "apply": { n: 57, asIs: 10 },
  "conditions": { n: 273, asIs: 139 },
  "considering": { n: 61, asIs: 16 },
  "cost": { n: 135, asIs: 35 },
  "other": { n: 174, asIs: 56 },
  "property_share": { n: 118, asIs: 54 },
  "question": { n: 155, asIs: 34 },
  "viewing": { n: 85, asIs: 16 },
};
