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

// ── 2026-11-13 作業員1（点検役「会話の流れの読み」・見張り 12370）: 窓を「文の通の数」で数え、AIX の物件の画像の束は1つに数える ──
//   旧: 新しい順に20通。AIX【物件ピックアップした】の画像1枚も1通に数え、ピックアップ1回で10通前後を占めて数日前のお客様の事情が窓から落ちていた
//   （12370 は前8通のうち画像5通）。既定 off（BRAIN_MSG_WINDOW_UNITS=on の時だけ・読む上限は窓の3倍・60通まで）
export function brainMsgWindowUnitsOn(env: Record<string, string | undefined> = process.env): boolean {
  return (env.BRAIN_MSG_WINDOW_UNITS ?? "").trim().toLowerCase() === "on";
}
export type WinMsg = { sender: string; text: string | null; is_aix_generated?: boolean | null; created_at: string };
/** AIX で送った物件の画像（こちら・AIX・本文が画像だけ） */
export function isAixImageMsg(m: WinMsg): boolean {
  return m.sender !== "customer" && !!m.is_aix_generated && /^\s*\[(?:画像|動画)\]/.test(m.text ?? "") && (m.text ?? "").replace(/\[(?:画像|動画)\][^\n]*/g, "").trim().length < 200;
}
/** 新しい順の通から、窓 n 単位ぶんを取る（AIX の画像が続く束は1単位） */
export function trimByUnits<T extends WinMsg>(newestFirst: ReadonlyArray<T>, n: number): T[] {
  const out: T[] = [];
  let units = 0;
  for (let i = 0; i < newestFirst.length; i++) {
    const m = newestFirst[i];
    const prev = i > 0 ? newestFirst[i - 1] : null;
    const sameBurst = !!prev && isAixImageMsg(prev) && isAixImageMsg(m);
    if (!sameBurst) { if (units >= n) break; units++; }
    out.push(m);
  }
  return out;
}
/** 古い順の履歴の行の配列で、AIX の画像の束（同じ送り手の続き）を1行にまとめる。label は束の頭の行の送り手と時刻（例 "[AIX:property_send 11/08 10:12]"） */
export function collapseAixImageBursts<T extends WinMsg>(oldestFirst: ReadonlyArray<T>, lineOf: (m: T) => string, headOf: (m: T) => string): string[] {
  const out: string[] = [];
  for (let i = 0; i < oldestFirst.length; i++) {
    const m = oldestFirst[i];
    if (!isAixImageMsg(m)) { out.push(lineOf(m)); continue; }
    let j = i;
    while (j + 1 < oldestFirst.length && isAixImageMsg(oldestFirst[j + 1])) j++;
    const n = j - i + 1;
    out.push(n === 1 ? lineOf(m) : `${headOf(m)} 物件の画像 ${n}枚（AIX の束を1行にまとめた）`);
    i = j;
  }
  return out;
}
