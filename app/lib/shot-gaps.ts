/**
 * 学習の「抜け」を数えて統括に渡す（2026-11-15 竹内さん）
 *
 *   竹内さん「ここの抜けていた部分もちゃんと統括は把握できるように」
 *   「更新は常に許可する」
 *
 * ★ なぜ要るか（実測）
 *   今日 102枚を読んで欄 3,284個を学んだが、**まだ374枚（大きい写真）が未学習**だった。
 *   ⚠ 統括は「何枚読んだか」しか知らされていなかったので、
 *     「まだ374枚残っている」と言えなかった（＝抜けが見えない）。
 *
 * ★ 何を「抜け」と呼ぶか
 *   ① **未学習の写真**（大きい＝読めるのに読んでいない）… 費用をかければ学べる
 *   ② **読めなかった写真**（大きいのに欄が0）… 読み方を変える必要がある
 *   ③ **小さい写真しか無い**（480px だけ）… 撮り直しが要る
 *
 * ⚠ 入れるのは**数だけ**（写真の置き場所・中身は入れない）。
 */

/** 1枚の写真の状態 */
export type ShotState = {
  /** 長辺（px） */
  w: number;
  /** 写真があるか */
  hasKey: boolean;
  /** 学習済みか */
  learned: boolean;
  /** 学習済みのうち、欄が0個だったか */
  fields?: number;
};

/** 抜けのまとめ */
export type ShotGaps = {
  /** 全部の写真 */
  total: number;
  /** 大きい（800px以上）で未学習 … 読めるのに読んでいない */
  unlearnedBig: number;
  /** 小さい（800px未満）で未学習 … 撮り直しが要る */
  unlearnedSmall: number;
  /** 学習済みだが欄が0個 … 読み方を変える */
  learnedButEmpty: number;
  /** 学習済みで欄がある */
  learnedOk: number;
  /** 読むべき残り（大きい未学習＋欄0） */
  todo: number;
  /** 人が読む1行 */
  line: string;
};

/**
 * 写真の状態から「抜け」を数える（純関数）。
 *   ⚠ 悪い所だけを言う（良ければ「抜けなし」）。
 */
export function summarizeShotGaps(rows: ReadonlyArray<ShotState>): ShotGaps {
  const list = (Array.isArray(rows) ? rows : []).filter((r) => r && typeof r === "object" && r.hasKey);
  let unlearnedBig = 0, unlearnedSmall = 0, learnedButEmpty = 0, learnedOk = 0;
  for (const r of list) {
    const w = Number(r.w) || 0;
    if (!r.learned) {
      if (w >= 800) unlearnedBig++;
      else unlearnedSmall++;
    } else if ((Number(r.fields) || 0) === 0) {
      learnedButEmpty++;
    } else {
      learnedOk++;
    }
  }
  const todo = unlearnedBig + learnedButEmpty;
  const parts: string[] = [];
  parts.push(`写真 ${list.length}枚（学べた ${learnedOk}枚）`);
  if (todo > 0) parts.push(`⚠ まだ読める ${todo}枚（未学習${unlearnedBig}・欄0が${learnedButEmpty}）`);
  if (unlearnedSmall > 0) parts.push(`小さいので読めない ${unlearnedSmall}枚（撮り直しが要る）`);
  if (!todo && !unlearnedSmall) parts.push("抜けなし");
  return { total: list.length, unlearnedBig, unlearnedSmall, learnedButEmpty, learnedOk, todo, line: parts.join("／") };
}

/**
 * 抜けから「次にやる事」を出す（統括が決めるため）。
 *   ⚠ 費用がかかる物は**枚数の上限**と概算を付ける（1枚 約0.17円・実測）。
 */
export function shotGapTasks(g: ShotGaps): Array<{ what: string; why: string; next: string; cost: string }> {
  const out: Array<{ what: string; why: string; next: string; cost: string }> = [];
  if (g.unlearnedBig > 0) {
    out.push({
      what: "まだ読んでいない大きな写真がある",
      why: `${g.unlearnedBig}枚（読める大きさなのに未学習）`,
      next: "写真から学ぶを回す（同じ画面は1枚に絞る）",
      cost: `約${Math.max(1, Math.round(g.unlearnedBig * 0.17))}円（${g.unlearnedBig}枚・1枚0.17円）`,
    });
  }
  if (g.learnedButEmpty > 0) {
    out.push({
      what: "読んだのに欄が1つも取れなかった写真がある",
      why: `${g.learnedButEmpty}枚`,
      next: "読み方を変える（max_tokens を上げる・画面全体を読む）",
      cost: `約${Math.max(1, Math.round(g.learnedButEmpty * 0.17))}円（読み直す場合）`,
    });
  }
  if (g.unlearnedSmall > 0 && g.unlearnedBig === 0) {
    out.push({
      what: "小さい写真しか残っていない",
      why: `${g.unlearnedSmall}枚（480px では欄が読めない・実測）`,
      next: "今の版（2.7.78）で録画し直す",
      cost: "0円（録画し直すだけ）",
    });
  }
  return out;
}
