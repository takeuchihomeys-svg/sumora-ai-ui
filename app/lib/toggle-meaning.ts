/**
 * 押した操作が「選んだ」のか「外した」のかを区別する（2026-11-15 竹内さん）
 *
 *   竹内さん「3組目の悠さんは駅での検索なので、前に残っていた
 *     泉大津市・西成区・住之江区・浪速区を外すために押している。
 *     選択しているのではなくて押すことで前に残っている部分をはずしている」
 *     「統括はこのこと理解するために必要な土台作り細部まで理解できるようにする」
 *
 * ★ なぜ要るか（**私は2回続けて同じ誤読をした**）
 *   記録には「押した欄の名前」しか無かったので、
 *   同じ `click` が「**選んだ**」のか「**前に残っていたのを外した**」のか区別できなかった。
 *   私は「泉大津市を選んでいる」と読み、実際は「前のお客さんの泉大津市を外していた」。
 *
 *   ⚠ この違いは**意味が正反対**:
 *     選んだ   → その条件で検索したい
 *     外した   → その条件は**いらない**（前のお客さんの残り）
 *   取り違えると「条件を足す」べき所で「条件を消す」、またはその逆をやってしまう。
 *
 * ★ どう区別するか
 *   記録に `was`（押す前の checked）と `now`（押した後の checked）を残す（v2.7.78〜）。
 *   ・was=false → now=true … **選んだ（on）**
 *   ・was=true  → now=false … **外した（off）**
 *   ・was=now ……………… 変わらなかった（別の意味のクリック・失敗）
 *   ・was が無い ………… 旧版の記録（区別できない）
 *
 * ⚠ 入れるのは**真偽だけ**。区の名前・入力した中身は入れない（名前は今まで通り欄の名前のみ）。
 */

/** 1件の操作（`shot_ops` の形） */
export type ToggleOp = {
  t?: number | null;
  k?: string | null;
  f?: string | null;
  w?: string | null;
  by?: string | null;
  /** 押す前の checked（true=チェック済み） */
  was?: boolean | null;
  /** 押した後の checked */
  now?: boolean | null;
};

/** 1回の操作の意味 */
export type ToggleMeaning = "on" | "off" | "same" | "unknown";

/**
 * 1件の操作が「選んだ」のか「外した」のかを決める（純関数）。
 *   ⚠ `was` が無い（旧版の記録）は `unknown`。**推測で on/off を決めない**。
 */
export function toggleMeaning(op: ToggleOp | null | undefined): ToggleMeaning {
  if (!op || typeof op !== "object") return "unknown";
  const was = typeof op.was === "boolean" ? op.was : null;
  const now = typeof op.now === "boolean" ? op.now : null;
  if (was === null || now === null) return "unknown";
  if (was === now) return "same";
  return now ? "on" : "off";
}

/** 人が読める日本語 */
export function toggleJa(m: ToggleMeaning): string {
  return m === "on" ? "選んだ" : m === "off" ? "前に残っていたのを外した" : m === "same" ? "変わらなかった" : "区別できない（旧版の記録）";
}

/**
 * 1回の検索（run）の中で「外した物」と「選んだ物」を分ける（純関数）。
 *   ⚠ これが統括の材料になる: 「この回は**前のお客さんの条件を4つ外して**、
 *     **悠さんの駅を3つ選んだ**」と言えるようになる。
 */
export function splitToggles(ops: ReadonlyArray<ToggleOp>): {
  on: string[];
  off: string[];
  same: string[];
  unknown: string[];
} {
  const on: string[] = [], off: string[] = [], same: string[] = [], unknown: string[] = [];
  for (const op of Array.isArray(ops) ? ops : []) {
    if (!op || typeof op !== "object") continue;
    const f = String(op.f ?? "").trim();
    if (!f) continue;
    const m = toggleMeaning(op);
    if (m === "on") { if (on.indexOf(f) < 0) on.push(f); }
    else if (m === "off") { if (off.indexOf(f) < 0) off.push(f); }
    else if (m === "same") { if (same.indexOf(f) < 0) same.push(f); }
    else { if (unknown.indexOf(f) < 0) unknown.push(f); }
  }
  return { on, off, same, unknown };
}

/**
 * 統括に渡す1行（何を外して何を選んだか）。
 *   ⚠ 旧版の記録（`was` が無い）は「区別できない」と**正直に**書く（推測で埋めない）。
 */
export function describeToggles(ops: ReadonlyArray<ToggleOp>): string {
  const s = splitToggles(ops);
  const parts: string[] = [];
  if (s.off.length) parts.push(`前に残っていたのを外した ${s.off.length}件（${s.off.slice(0, 4).join("・")}）`);
  if (s.on.length) parts.push(`選んだ ${s.on.length}件（${s.on.slice(0, 4).join("・")}）`);
  if (s.same.length) parts.push(`変わらなかった ${s.same.length}件`);
  if (s.unknown.length && !s.off.length && !s.on.length) {
    return `区別できません（旧版の記録・押す前の状態が無い）: ${s.unknown.slice(0, 6).join("・")}`;
  }
  return parts.length ? parts.join("／") : "押した操作なし";
}

/**
 * ★ 2026-11-15 統括が「この回は前のお客さんの条件を外している」と理解するための材料。
 *
 *   ⚠ 「外した」が**多い**回は、**前のお客さんの条件が残っていた**証拠。
 *     統括がこれを見れば「前の条件が残っている」と正しく言える
 *     （私は名前だけ見て「選んでいる」と誤読した）。
 */
export function summarizeToggleWork(ops: ReadonlyArray<ToggleOp>): {
  offN: number;
  onN: number;
  /** 前のお客さんの条件を外す仕事があったか */
  hadPrevWork: boolean;
  /** 統括に渡す1行 */
  line: string;
} {
  const s = splitToggles(ops);
  return {
    offN: s.off.length,
    onN: s.on.length,
    hadPrevWork: s.off.length > 0,
    line: describeToggles(ops),
  };
}
