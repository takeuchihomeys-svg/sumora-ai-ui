// app/lib/learn-from-images.ts
//
// 2026-11-14 竹内さん「いままでの画像から統括がまなぶことできないのか」
//
// なぜ要るか:
//   操作の記録（`shot_ops`）が 12% しか無い（拡張の読み込み順の問題）。
//   だが **写真は 4318枚ある**。
//   → **写真だけで「画面が変わった瞬間」を学ぶ**。
//
// 何を学ぶか（操作の記録が無くても分かる事）:
//   ① 画面が大きく変わった時刻（＝人が何かを押した／ページが変わった）
//   ② 変わった回数（＝1回の検索で何段あるか）
//   ③ 変わらずに長く止まった時間（＝人が考えている／待っている）
//   ④ 同じ画面が続く長さの中央値（＝次の操作までの間）
//
// ⚠ 写真の中身（文字・物件名）は**読まない**。見るのは**画面全体の明るさの並び**だけ
//   （個人情報も物件情報も入らない・費用0）。
// ⚠ Vision AI は使わない（費用を勝手にかけない）。
import sharp from "sharp";

/** 写真から作る「画面の指紋」（純関数に近い・画像だけ見る） */
export type FrameHash = {
  /** 画面を 16x9 に縮めた明るさの並び（0〜255・144個） */
  sig: number[];
  /** 全体の明るさ（0〜255） */
  bright: number;
};

/** 写真（JPEG/PNG のバイト列）から指紋を作る */
export async function hashImage(buf: Buffer): Promise<FrameHash | null> {
  try {
    const raw = await sharp(buf)
      .resize(16, 9, { fit: "fill" })
      .greyscale()
      .raw()
      .toBuffer();
    const sig: number[] = [];
    for (let i = 0; i < raw.length; i++) sig.push(raw[i]);
    const bright = sig.length ? Math.round(sig.reduce((s, v) => s + v, 0) / sig.length) : 0;
    return { sig, bright };
  } catch {
    return null;
  }
}

/**
 * 2枚の画面が「大きく変わったか」（純関数）。
 *   ・16x9 の明るさの**平均の差**で見る（0〜255）
 *   ・しきい値（既定 18）を超えたら「変わった」
 *   ⚠ 小さな変化（カーソルが動いた・光った）は拾わない＝**段が変わった時だけ**。
 */
export function framesDiffer(a: FrameHash | null, b: FrameHash | null, threshold = 18): boolean {
  if (!a || !b || !Array.isArray(a.sig) || !Array.isArray(b.sig)) return false;
  const n = Math.min(a.sig.length, b.sig.length);
  if (!n) return false;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += Math.abs(a.sig[i] - b.sig[i]);
  return sum / n >= threshold;
}

/** 1枚ぶんの入力（時系列に並べる） */
export type ShotFrame = {
  at: string | null;
  hash?: FrameHash | null;
  /** 既に指紋があればそれを使う（無ければ画像から作る） */
  buf?: Buffer | null;
};

/**
 * 写真の並びから「画面が変わった所」を学ぶ（純関数）。
 *
 * @param frames 時刻順に並べた写真
 * @returns 変化の数・間隔・止まった時間など
 */
export function learnFromFrames(frames: ReadonlyArray<{ at: string | null; hash: FrameHash | null }>): {
  n: number;
  /** 画面が変わった回数 */
  changes: number;
  /** 変化のあった時刻（ISO）と、その直前から何秒たっていたか */
  changeAt: Array<{ at: string; after_ms: number }>;
  /** 変化の無い時間（人が見ている・待っている）の中央値（ms） */
  hold_ms: number | null;
  /** 変化から変化までの間隔の中央値（ms）＝1段にかかる時間 */
  step_ms: number | null;
  /** 写真の間隔の中央値（ms） */
  shot_gap_ms: number | null;
  /** 1枚も無ければ null 以外は 0 */
  top_note: string | null;
} {
  const list = Array.isArray(frames) ? frames.filter((f) => f && f.at) : [];
  const n = list.length;
  const out = { n, changes: 0, changeAt: [] as Array<{ at: string; after_ms: number }>, hold_ms: null as number | null, step_ms: null as number | null, shot_gap_ms: null as number | null, top_note: null as string | null };
  if (n < 2) return out;

  const t = (x: { at: string | null }) => {
    const v = x.at ? Date.parse(String(x.at)) : NaN;
    return Number.isFinite(v) ? v : null;
  };
  const gaps: number[] = [];
  const steps: number[] = [];
  const holds: number[] = [];
  let lastChangeAt: number | null = null;

  for (let i = 1; i < n; i++) {
    const a = list[i - 1], b = list[i];
    const ta = t(a), tb = t(b);
    if (ta != null && tb != null) {
      const d = tb - ta;
      if (d > 0) gaps.push(d);
    }
    if (framesDiffer(a.hash, b.hash)) {
      out.changes++;
      const after = (ta != null && tb != null) ? Math.max(0, tb - ta) : 0;
      if (b.at) out.changeAt.push({ at: b.at, after_ms: after });
      // 変化の無い時間（前の変化から今の変化まで）
      if (lastChangeAt != null && tb != null) {
        const d = tb - lastChangeAt;
        if (d > 0) holds.push(d);
      }
      if (lastChangeAt != null && ta != null) {
        const d = ta - lastChangeAt;
        if (d > 0) steps.push(d);
      }
      lastChangeAt = tb;
    }
  }

  const med = (arr: number[]): number | null => {
    if (!arr.length) return null;
    const s = arr.slice().sort((x, y) => x - y);
    const m = Math.floor(s.length / 2);
    return Math.round(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2);
  };
  out.hold_ms = med(holds);
  out.step_ms = med(steps);
  out.shot_gap_ms = med(gaps);
  /**
   * 人が読める1文（統括に渡す）:
   *   ⚠ 「変化が多すぎる」は**押し直し・迷い**の疑い、「少なすぎる」は**止まっている**疑い。
   */
  if (n >= 10) {
    const perMin = out.changes / Math.max(1, (n * (out.shot_gap_ms ?? 500)) / 60000);
    if (perMin > 10) out.top_note = `1分あたり ${Math.round(perMin)}回も画面が変わっています（押し直し・迷いの疑い）`;
    else if (out.changes === 0) out.top_note = `${n}枚の写真で画面が一度も変わっていません（止まっている疑い）`;
    else out.top_note = `${n}枚で ${out.changes}回 画面が変わりました（1段 約${Math.round((out.step_ms ?? 0) / 1000)}秒）`;
  }
  return out;
}
