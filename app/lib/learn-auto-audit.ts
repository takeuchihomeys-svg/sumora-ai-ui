/**
 * 自動モードの録画を「1回の検索」に畳む純関数（2026-11-15 竹内さん）
 *
 *   竹内さん「自動モードの録画で弱い部分や抜けている部分、機械的な部分、
 *     直接入力されてしまっている部分も見つけられるようにする」
 *
 * ★ なぜ畳む必要があるか（実測で踏んだ罠）
 *   `human_motion_learn` の1行は **1回の検索ではない**。
 *   録画は数秒おきに写真を撮り、**その写真1枚＝1行**になる。
 *   さらに `shot_ops` は**その run の最初から溜まった操作を毎回まるごと載せた累積**。
 *
 *   実測（2026-11-14 の自動モード）:
 *     54行のうち **50行が同じ run `mwgf1gx3`**。`shot_ops` は 1手 → 39手 と増えていくだけ。
 *     → 畳まずに数えると「54回の検索で印刷用PDFを40回押し直した」と**誤読**する（実際は1回の検索）。
 *
 * ★ もう1つの罠
 *   1回の押下が `tap`（見えるカーソル）と `click`（実際のクリック）の**2件**で記録される。
 *   実測の差は **121〜152ms**。畳まないと押した回数が2倍になる。
 *
 * ⚠ ここは**数える所**。判断（直すかどうか）は呼ぶ側がする。
 */

/** 1件の操作（`shot_ops` の形） */
export type AutoOp = {
  t?: number | null;
  k?: string | null;
  f?: string | null;
  w?: string | null;
  by?: string | null;
  why?: string | null;
};

/** 1行（写真1枚） */
export type AutoRow = {
  created_at?: string | null;
  shot_key?: string | null;
  shot_ops?: AutoOp[] | null;
  [k: string]: unknown;
};

/**
 * 写真の置き場所から run を取り出す。
 *   `2026-11-14/aix/run_mwgf1gx3_n1k5/<id>-<ms>.jpg` → `mwgf1gx3`
 *   ⚠ run が分からない写真は **1枚ずつ別物**として扱う（まとめると別の検索が混ざる）。
 */
export function runOfRow(r: AutoRow): string {
  const m = String(r?.shot_key ?? "").match(/run_([a-z0-9]+)/i);
  if (m) return m[1];
  // run が無い物は、その行だけの入れ物にする（時刻＋置き場所で一意に）
  return "single:" + String(r?.shot_key ?? r?.created_at ?? Math.random());
}

/**
 * 同じ run の写真を **「一番進んだ1枚」** に畳む（累積なので操作が多い1枚が最後）。
 *   ⚠ 操作の数が同じなら**新しい方**を採る（後から撮った物ほど正しい）。
 *   ⚠ 操作が0手の記録しか無い run でも**捨てない**（「記録できていない」も材料）。
 */
export function foldRuns<T extends AutoRow>(rows: ReadonlyArray<T>): Array<{ run: string; row: T; ops: AutoOp[]; shots: number }> {
  const byRun = new Map<string, T[]>();
  for (const r of Array.isArray(rows) ? rows : []) {
    const k = runOfRow(r);
    if (!byRun.has(k)) byRun.set(k, []);
    byRun.get(k)!.push(r);
  }
  const out: Array<{ run: string; row: T; ops: AutoOp[]; shots: number }> = [];
  for (const [run, list] of byRun) {
    const sorted = list.slice().sort((a, b) => {
      const d = (b.shot_ops?.length ?? 0) - (a.shot_ops?.length ?? 0);
      if (d !== 0) return d;
      return String(b.created_at ?? "").localeCompare(String(a.created_at ?? ""));
    });
    const best = sorted[0];
    const ops = (best?.shot_ops ?? []).filter((o) => o && (o.k || o.f));
    out.push({ run, row: best, ops, shots: list.length });
  }
  // 新しい順
  return out.sort((a, b) => String(b.row?.created_at ?? "").localeCompare(String(a.row?.created_at ?? "")));
}

/** 欄の名前をそろえる（`左の検索｜span` → `検索`） */
export function fieldName(f: unknown): string {
  return String(f == null ? "" : f)
    .replace(/^(左の|右の|上の|下の|中央の)/, "")
    .replace(/｜[^｜]*$/, "")
    .trim();
}

/**
 * `tap` → `click` の対を1回に畳む。
 *   ⚠ 同じ欄・`withinMs`（既定300ms）以内の `tap` と `click` だけ。
 *     離れている物は**押し直し**として残す（実測の対は 121〜152ms）。
 */
export function foldTapClick(ops: ReadonlyArray<AutoOp>, opt: { withinMs?: number } = {}): AutoOp[] {
  const within = opt.withinMs ?? 300;
  const out: AutoOp[] = [];
  for (const o of Array.isArray(ops) ? ops : []) {
    if (!o) continue;
    const prev = out.length ? out[out.length - 1] : null;
    if (prev) {
      const dt = Math.abs((Number(o.t) || 0) - (Number(prev.t) || 0));
      const sameField = fieldName(prev.f) === fieldName(o.f) && fieldName(o.f) !== "";
      const isPair =
        sameField && dt <= within &&
        ((prev.k === "tap" && o.k === "click") || (prev.k === "click" && o.k === "tap"));
      if (isPair) {
        // 後の方の印（`by:"auto"` は click に付く）と時刻を残す
        if (!prev.by && o.by) prev.by = o.by;
        prev.t = o.t;
        continue;
      }
    }
    out.push({ ...o });
  }
  return out;
}

/**
 * 「押さずに値だけ変わった欄」＝**選ばずに値を入れた**疑いを数える。
 *   ⚠ 人がプルダウンを選ぶ時は `click`（開く）→ `change`（決まる）の順になる。
 *     `change` だけある欄は、拡張が値を直接書いた疑い。
 */
export function countChangedWithoutClick(ops: ReadonlyArray<AutoOp>): Record<string, number> {
  const clicked = new Set<string>();
  for (const o of Array.isArray(ops) ? ops : []) {
    if (o && (o.k === "click" || o.k === "tap")) {
      const f = fieldName(o.f);
      if (f) clicked.add(f);
    }
  }
  const out: Record<string, number> = {};
  for (const o of Array.isArray(ops) ? ops : []) {
    if (!o || o.k !== "change") continue;
    const f = fieldName(o.f);
    if (!f || clicked.has(f)) continue;
    out[f] = (out[f] || 0) + 1;
  }
  return out;
}

/**
 * 直入力の疑いを数える（`k:"key"` ＝文字を打っている）。
 *   ⚠ 「選ぶ所」（条件・駅・所在地）で `key` が出ていたら疑いが濃い。
 *     文字の欄（賃料の下限など）は人が打つ事もあるので、同じく数えるが印を分ける。
 */
export function countDirectTyping(ops: ReadonlyArray<AutoOp>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const o of Array.isArray(ops) ? ops : []) {
    if (!o || o.k !== "key") continue;
    const f = fieldName(o.f);
    if (!f) continue;
    out[f] = (out[f] || 0) + 1;
  }
  return out;
}

/**
 * 操作の間（ms）を集める（同じ run の中で、前の操作からの差）。
 *   ⚠ 60000ms 以上は「離れすぎ」＝別の場面なので入れない（平均を壊す）。
 */
export function collectGaps(ops: ReadonlyArray<AutoOp>): number[] {
  const out: number[] = [];
  const list = Array.isArray(ops) ? ops : [];
  for (let i = 1; i < list.length; i++) {
    const d = (Number(list[i].t) || 0) - (Number(list[i - 1].t) || 0);
    if (d > 0 && d < 60000) out.push(d);
  }
  return out;
}

/**
 * 機械的な動きの度合いを見る。
 *   ⚠ 人が押す間隔は**ばらつく**（実測の手本は 4,000ms 前後で種類がほぼ全部違う）。
 *     一定（同じ値が多い）・速すぎる（200ms 未満）は機械の疑い。
 */
export function judgeMechanical(gaps: ReadonlyArray<number>): {
  n: number;
  median: number;
  tooFast: number;
  kinds: number;
  flat: boolean;
} {
  const g = (Array.isArray(gaps) ? gaps : []).filter((x) => typeof x === "number" && x > 0);
  if (!g.length) return { n: 0, median: 0, tooFast: 0, kinds: 0, flat: false };
  const s = g.slice().sort((a, b) => a - b);
  const median = s[Math.floor(s.length / 2)];
  const tooFast = g.filter((x) => x < 200).length;
  const kinds = new Set(g).size;
  // 6個以上あって、種類が3割未満＝ほぼ一定
  const flat = g.length >= 6 && kinds / g.length < 0.3;
  return { n: g.length, median, tooFast, kinds, flat };
}

/**
 * **一覧の行ごとに押す物**（物件1件ごとに1回押す＝何度出ても押し直しではない）。
 *   ⚠ ここを除かないと、実測のように
 *     「印刷用PDF が1回の検索で17回出た」を**押し直し17回と誤読**する
 *     （実際は17件の物件それぞれに1回ずつ押している）。
 *   増やす時は**実データの名前**を見て足す（推測で増やさない）。
 */
const PER_ROW_FIELD = /^(印刷用PDF|印刷|PDF|次へ|次のページ|ページ送り|詳細|資料|チェック|選択)$/;
/** 2026-11-18: shot_ops 内の監査ステップノート・台帳文字は「押す対象欄」ではないため課題抽出から除外 */
const NON_FIELD_STEP_RE = /^(理解台帳|流れ台帳|流れ地図|未完了:|完了済:|細分化強化が要る|今の客|間取り場面|ボタン台帳|切替把握)/;

/** 一覧の行ごとに押す物か（押し直しとして数えない） */
export function isPerRowField(f: unknown): boolean {
  return PER_ROW_FIELD.test(fieldName(f));
}

export function isNonFieldStepNote(f: unknown): boolean {
  const s = fieldName(f);
  return !s || NON_FIELD_STEP_RE.test(s);
}

/**
 * 「同じ欄を2回以上押した」＝押し直し・迷いを数える（run をまたいで数える）。
 *   ⚠ 畳んだ後の操作で数える（`tap`/`click` の対を押し直しと数えないため）。
 *   ⚠ **一覧の行ごとに押す物は除く**（`isPerRowField`）。物件の件数だけ出てしまうため。
 *   ⚠ **監査ステップノート（`o.w === "step"` や台帳文字）は除く**（課題欄のゴミ混入を防ぐ）。
 */
export function countRetries(
  runs: ReadonlyArray<ReadonlyArray<AutoOp>>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const ops of Array.isArray(runs) ? runs : []) {
    const c: Record<string, number> = {};
    for (const o of Array.isArray(ops) ? ops : []) {
      if (o?.w === "step") continue;
      const f = fieldName(o?.f);
      if (!f || isPerRowField(f) || isNonFieldStepNote(f)) continue;
      c[f] = (c[f] || 0) + 1;
    }
    for (const [f, k] of Object.entries(c)) if (k >= 2) out[f] = (out[f] || 0) + 1;
  }
  return out;
}

/**
 * **明らかな押し直し**＝同じ欄を続けて2回（間に何も挟まない）。
 *   ⚠ 人がプルダウンを開き直す・チェックを付け直す時だけ起きる。機械が二重に押した疑い。
 */
export function countAdjacentRepresses(ops: ReadonlyArray<AutoOp>): Record<string, number> {
  const out: Record<string, number> = {};
  const list = (Array.isArray(ops) ? ops : []).filter((o) => o && (o.k === "click" || o.k === "tap") && fieldName(o.f));
  for (let i = 1; i < list.length; i++) {
    const f = fieldName(list[i].f);
    if (f && f === fieldName(list[i - 1].f) && !isPerRowField(f)) out[f] = (out[f] || 0) + 1;
  }
  return out;
}

/**
 * 一覧の行ごとの押下を数える（`印刷用PDF` など）。**押し直しではない**が
 * 「この検索で何件の物件を扱ったか」が分かる（`presses`）。
 *   ⚠ ここが 0 なら「一覧の行を押せていない」＝自動モードが物件まで進んでいない。
 */
export function countPerRowPresses(ops: ReadonlyArray<AutoOp>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const o of Array.isArray(ops) ? ops : []) {
    if (!o || (o.k !== "click" && o.k !== "tap")) continue;
    const f = fieldName(o.f);
    if (!f || !isPerRowField(f)) continue;
    out[f] = (out[f] || 0) + 1;
  }
  return out;
}

/**
 * ★ 2026-11-15 竹内さん「直接入力されてしまっている部分も見つけられるようにする」
 *
 *   **記録の経路そのものが壊れていないか**を、2つの数を見比べて確かめる。
 *   `kinds`（その回に打った・押した・選んだ回数）と `shot_ops`（操作1件ずつの並び）は
 *   **同じ操作を別の所で数えた物**なので、大きく食い違ったら**記録の経路が欠けている**。
 *
 *   実測（v2.7.75 より前）: `kinds.key` は 36回なのに `shot_ops` の `key` は **0件**。
 *     ＝ 打ち込みが記録に載っていない（受け口が click/change だけだった）。
 *     → 「直接入力が0件」を**『していない』と読み違える**所だった（実際は『見えていない』）。
 *
 *   @returns 打ち込み・選び直しの**欠け**（0 なら経路は健全）
 */
export function kindsKeyVsOpsKey(
  rows: ReadonlyArray<AutoRow>,
  opsOf: (r: AutoRow) => ReadonlyArray<AutoOp>,
): { kindsKey: number; opsKey: number; gap: number; broken: boolean } {
  let kindsKey = 0;
  let opsKey = 0;
  for (const r of Array.isArray(rows) ? rows : []) {
    const k = r?.kinds as Record<string, unknown> | null | undefined;
    if (k && typeof k === "object") kindsKey += Math.max(0, Number(k.key) || 0);
    for (const o of opsOf(r)) if (String(o?.k) === "key") opsKey++;
  }
  // ⚠ 間引き（1.2秒に1回）があるので数は完全には一致しない。
  //    「打ったのに1件も載っていない」時だけ壊れていると見る（誤報を出さない）。
  const broken = kindsKey >= 3 && opsKey === 0;
  return { kindsKey, opsKey, gap: kindsKey - opsKey, broken };
}
