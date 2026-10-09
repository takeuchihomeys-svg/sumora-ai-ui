// app/lib/brain-msg-window.ts — ブレインが読む会話の窓（直近 N 通）。毎回の判断・差分（incremental）の判断で同じ数。
//
// 2026-10-08 竹内さんの決定「ブレインの窓を 15→20 通にして、会話の要約（15通ごと）との間でこぼれる発言を塞ぐ」
//   会話のセーブデータ（conversation_checkpoints）は前回のセーブから15通以上増えた時に、判断の「後」で作る（brain-core.maybeCreateCheckpoint）。
//   作りが遅れると、セーブの位置から今までが15通を超え、窓（15通）とセーブの間の発言がどちらにも載らない。
//   実測（scripts/audit-brain-window.ts・9/23〜の判断 1,148件から400件）: セーブの位置からの通数 中央7・90% 14・99% 23・最大 29
//     窓15 → こぼれる判断 7.0%（28件・こぼれた通 112）／窓20 → 2.5%（10件・31通）／窓25 → 0.3%（1件・4通）
//   増える入力: 16〜20通目 平均 約380字（90% 711字）＝1回 約 +0.3〜0.4k トークン
// 戻す: BRAIN_MSG_WINDOW=15（旧）。10〜40 の整数だけ受ける（それ以外は既定の20）

export const BRAIN_MSG_WINDOW_DEFAULT = 20;

export function brainMsgWindow(env: Record<string, string | undefined> = process.env): number {
  const raw = (env.BRAIN_MSG_WINDOW ?? "").trim();
  if (!raw) return BRAIN_MSG_WINDOW_DEFAULT;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 10 && n <= 40 ? n : BRAIN_MSG_WINDOW_DEFAULT;
}
