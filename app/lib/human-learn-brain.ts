// app/lib/human-learn-brain.ts
// 「人の動きから学ぶ」担当のブレイン（純関数・DB を触らない）。
//
// 2026-11-13 竹内さん「ちゃんと学習担当のブレインをつくってより効率的に学習できるようにする
//   データベースを有効活用する」
//
// なぜ要るか:
//   これまで学習は**溜めるだけ**だった（`human_motion_learn`）。貯まった物を
//   「押す順番」「押す場所」「動きの速さ」「どの画面で何を押すか」に**まとめ直す担当**が無く、
//   拡張は毎回バラバラの記録を読んでいた（無駄が多く、学習が進むほど重くなる）。
//   → ここで**1回だけ**まとめて、拡張が読む形（小さい・決まった形）にする。
//
// 何を作るか（この関数が返す物 = 拡張が読む「学習の束」）:
//   ① next       … 直前の操作 → 次に押す物（押す順番）。写真の `shot_ops` から学ぶ
//   ② points     … 要素ごとの押した位置（横・縦の割合）と回数
//   ③ motion     … マウスの速さ・曲がり・押し位置の中心・スクロール量
//   ④ buttons    … 押された回数の多いボタン（＝大事な操作）
//   ⑤ site_flow  … サイトごとの手順（例: 所在地絞り込み＋ → 区 → 確定してリストへ）
//   ⑥ gaps       … 操作と操作の間（人が待つ長さ）
//
// ⚠ 入れるのは**欄の名前・操作の種類・時刻・位置の割合だけ**。
//   入力した中身（文字・数字）・お客様の名前・電話・住所は一切入れない（今までの決まりと同じ）。
//
// 使い方:
//   npx tsx --env-file=.env.local scripts/human-learn-brain.ts            # 集計して表示（記録しない）
//   npx tsx --env-file=.env.local scripts/human-learn-brain.ts --apply    # DB の human_learn_profile に書く
//   /api/cron/human-learn-brain が毎晩まとめる（Vercel Cron）

import { reconcilePoints, findWeakPoints, learnFromShots, guessKindFromName, planLearnFromWeak, learnSequenceFromShots, isLearnableName } from "./shot-learn";
import { superviseLearn, type SupervisorAdvice, type SupervisorInput } from "./learn-supervisor";

export type MotionRow = {
  created_at?: string | null;
  site?: string | null;
  mode?: string | null;
  ext_version?: string | null;
  ops?: number | null;
  moves_n?: number | null;
  move_speed_px_s?: number | null;
  move_curve?: number | string | null;
  move_ms?: number | null;
  /**
   * 2026-11-13 竹内さん「ほかに抜けている箇所はあるのか」:
   *   `gap_ms` は**操作と操作の間**（人が次を押すまで待つ時間）。
   *   ⚠ 旧は `move_ms`（マウス移動の時間）を「操作の間」として使っていた（別物）。
   */
  gap_ms?: number | null;
  move_dist?: number | null;
  points_n?: number | null;
  point_x?: number | string | null;
  point_y?: number | string | null;
  point_fields?: unknown;
  scrolls_n?: number | null;
  scroll_dy?: number | null;
  kinds?: unknown;
  fields?: unknown;
  field_order?: unknown;
  shot_ops?: unknown;
  /** 2026-11-14: 押したら何が開いたか（欄ごと）／その内訳 */
  opens?: unknown;
  open_kinds?: unknown;
  /**
   * 2026-11-13 竹内さん「録画した画像もみて押し方や仕組みなども学習おねがい」:
   *   写真が撮れた画面の URL（`display=building` なら結果・`method=estate` なら入力）。
   *   **画面の種類を判定する**のに使う（写真そのものは見ない）。
   */
  url?: string | null;
  /**
   * 2026-11-13 竹内さん「画面の写真から判断できる。そこの部分強化するようにする」:
   *   写真から読んだ**欄の種類**（プルダウン／直接入力／チェック）と**画面の種類**。
   *   `shot_learn` が入っている行だけ使う（無ければ今まで通り数値だけで学ぶ）。
   */
  shot_learn?: unknown;
};

/** 押した位置（要素ごと） */
export type PointStat = {
  x: number; y: number; n: number;
  /** 要素の種類（select/checkbox/text/button/link/other） */
  w?: string;
  /**
   * 2026-11-13 竹内さん「今弱い部分学習する」:
   *   種類を**どこから**得たか（`photo`＝写真から読んだ／`name`＝名前から推した）。
   *   ⚠ 名前から推した物は**推測**なので、確かさ（w_conf）も残す（写真の物と区別する）。
   */
  w_src?: "photo" | "name";
  w_conf?: number;
};
/** 次に押す物 */
export type NextStat = { next: string; n: number; total: number };
/** 動きの癖 */
export type MotionStat = {
  speed_px_s: number | null;
  curve: number | null;
  aim: { x: number; y: number } | null;
  scroll_dy: number | null;
  moves: number;
  points: number;
  scrolls: number;
};

export type HumanLearnBundle = {
  v: 1;
  generated_at: string;
  /** 元にした記録の数・期間 */
  source: {
    rows: number; from: string | null; to: string | null; sites: string[];
    /**
     * 2026-11-14 竹内さん「DBにあって反映できていないものはあるか」:
     *   `ext_version` は**読むだけで束に入れていなかった**（版ごとの学びを分けられない）。
     *   実測: 直近200件が**全部 2.7.29**（＝新しい版の学習が現場に入っていない事に気づけない）。
     *   → 版の内訳を束に載せ、古い版が学びを薄めている時に**言えるようにする**。
     */
    versions?: Record<string, number>;
    /** 材料（操作の並び）が揃っている記録の数＝「順番」を学べる記録 */
    with_ops?: number;
    /**
     * 2026-11-14 竹内さん「通常モードでの学習で自動モード改善するように」:
     *   **人が押した操作**と**拡張が押した操作**の数（手本にできるのは人の動き）。
     */
    human_ops?: number;
    auto_ops?: number;
  };
  /** ① 直前の操作 → 次に押す物（押す順番） */
  next: Record<string, NextStat>;
  /** ② 要素ごとの押した位置 */
  points: Record<string, PointStat>;
  /** ③ 動きの癖 */
  motion: MotionStat;
  /** ④ 押された回数の多いボタン（上位） */
  buttons: Array<{ name: string; n: number }>;
  /** ⑤ サイトごとの手順（上位の流れ） */
  site_flow: Record<string, Array<{ from: string; to: string; n: number }>>;
  /**
   * 2026-11-14 竹内さん「ボタンなのかプルダウンなのか、どこで展開されるのかも意識して学習して改善する」:
   *   **押したら何が開くか**（欄ごと）。
   *   modal＝小窓が開く／options＝プルダウンの一覧が開く／form＝欄が変わる／
   *   result＝結果に変わる／modal_close＝小窓が閉じる／none＝変化なし。
   */
  opens?: Record<string, { opens: string; n: number; stage?: string; guessed?: boolean }>;
  /** ⑥ 操作と操作の間（中央値 ms） */
  gaps: { median_ms: number | null; samples: number };
  /**
   * 2026-11-14 竹内さん「学習の統括の部分判断できるようにちゃんと強化していく」:
   *   **統括の判断**（1つの結論・次にやる事・数字の良し悪し）。
   *   ⚠ `learn_plan` は「弱い所の一覧」で判断ではなかった。ここが**判断**。
   */
  supervisor?: SupervisorAdvice;
  /** サイト別の判断（リアプロ／itandi） */
  supervisor_by_site?: Record<string, SupervisorAdvice>;
  /**
   * 2026-11-14 竹内さん「いま通常と自動のところで自動で強化必要な部分強化するのと、
   *   できていない部分もちゃんとデータベースに理解させて強化していく形とする」:
   *   **モード別**（normal／staff／aix／brain …）の学び。
   *   ⚠ 統括が「**自動の時に足りない物**」と「**通常の時に足りない物**」を分けて判断できるようにする。
   *   各モードに: 記録数・押す順番・画面ごとの手順・弱い所・動きの速さ。
   */
  by_mode?: Record<string, {
    rows: number;
    next: Record<string, NextStat>;
    screen_flow: Record<string, { n: number; steps: Array<{ from: string; to: string; n: number }> }>;
    gaps: { median_ms: number | null; samples: number };
    points_n: number;
  }>;
  /** どのモードの記録が何件あったか（順位づけの材料） */
  mode_counts?: Record<string, number>;
  /**
   * 2026-11-14 竹内さん「画面録画したのみたら一連の動き学習できるからいまみてみて」:
   *   録画から作った**一連の動きの型**（押す順番を1本の鎖にした物・意味のあるまとまり）。
   *   ⚠ 入れるのは欄の名前と順番だけ（入力した中身は入れない）。
   */
  sequence_flow?: {
    /** 実際に押された順番（回数の多い組でつないだ鎖） */
    sequence: string[];
    /** 意味のあるまとまり（地域／駅／条件／検索） */
    groups: Array<{ name: string; steps: string[]; n: number }>;
    /** 組ごとの回数（上位） */
    edges: Array<{ from: string; to: string; n: number }>;
    /** 何本の並びから作ったか */
    samples: number;
  };
  /**
   * 2026-11-13 竹内さん「弱い部分等は学習の統括が判断して学習を繰り返していく」:
   *   **弱い所**（同じ欄で種類が割れている・種類が分からない・写真と数値が食い違う・押せない欄を押した）。
   *   統括がこれを読んで「次に何を学ぶか」を決める。
   */
  weak?: Array<{ kind: string; name: string; why: string; next: string }>;
  /**
   * 2026-11-13 竹内さん「録画した画像もみて押し方や仕組みなども学習おねがい」
   *   「抜けている部分徹底的に学習できるように」:
   *   **写真から学んだ画面ごとの仕組み**（どの画面で何を押し、次に何へ進むか）。
   *   `modal`（地域・駅の小窓）・`form`（条件の入力）・`result`（結果の一覧）ごと。
   *   ⚠ 入れるのは画面の種類・欄の名前・順番だけ（入力した中身は入れない）。
   */
  screen_flow?: Record<string, {
    n: number;
    lastPressed: Array<{ name: string; n: number }>;
    steps: Array<{ from: string; to: string; n: number }>;
    fields: Array<{ name: string; kind: string; n: number }>;
  }>;
  /** 写真を何枚見たか・そのうち操作が付いていた枚数 */
  shots?: { total: number; with_ops: number };
  /**
   * 2026-11-13 竹内さん「学習の統括が強化されるように、その点も徹底する」:
   *   **次に何を学ぶか**（統括の判断）。弱い所を優先度順の「やる事」に変えた物。
   *   写真が1枚も無くても、名前から推して埋めた分と残りが分かる。
   */
  learn_plan?: {
    items: Array<{ priority: number; kind: string; name: string; action: string; why: string }>;
    counts: Record<string, number>;
    filled: number;
    summary: string;
    /** 2026-11-14: モードごとの判断（通常／スタッフ／AIX）。足りない物と次にやる事。 */
    mode_plan?: Array<{ mode: string; rows: number; verdict: string; action: string }>;
    /** 2026-11-14: 整理（ゴミの扱い）＝統括の判断。除く・畳む・直す。 */
    cleanup?: Array<{ kind: string; n: number; verdict: string; action: string }>;
  };
  /** 何を学んだか（人が読む1行ずつ） */
  lines: string[];
};

const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};
/** 0〜1に丸める（おかしな値で壊れないように） */
const frac = (v: unknown): number | null => {
  const n = num(v);
  if (n == null) return null;
  return Math.max(0, Math.min(1, Math.round(n * 100) / 100));
};
const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const a = xs.slice().sort((p, q) => p - q);
  const m = Math.floor(a.length / 2);
  // ⚠ 2026-11-13: 小数（曲がり 1.2・押した位置 0.42 など）を丸めないこと。
  //   旧は Math.round で整数にしていたので、曲がり 1.2 → 1・位置 0.42 → 0 になっていた（学んだ値が消える）。
  const v = a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  return Math.round(v * 1000) / 1000;
};

/** 操作の並び（写真ごと）を取り出す。壊れた形は捨てる */
/**
 * 操作の並び（写真ごと）を取り出す。壊れた形は捨てる
 *
 * 2026-11-14 竹内さん「実際の通常モードでの検索のデータと比べてのギャップを強化」:
 *   ⚠ 旧は `shot_ops`（写真に付く操作）だけを使っていた。
 *     だが通常モードは**写真が少ない**ので、`shot_ops` が空の記録が大半。
 *     そのため `by_mode.normal` が **34件あるのに「押す順番0」** になっていた。
 *   → **`field_order`（押した順番・写真が無くても残る）も並びとして使う**。
 *     ⚠ どちらもある時は `shot_ops` を優先（時刻・種類が付いているので正確）。
 */
export function sequencesOf(row: MotionRow): Array<Array<{ t: number | null; k: string | null; f: string }>> {
  const raw = row.shot_ops;
  if (Array.isArray(raw)) {
    const seq: Array<{ t: number | null; k: string | null; f: string }> = [];
    /**
     * 2026-11-14 竹内さん「通常モードで行っているのはスタッフ等人間が実際の動きをしているので
     *   そこを理解して学習する」:
     *
     *   ⚠ `by`（人が押したか拡張が押したか）を**見ていなかった**ので、
     *     「人の手本」と「機械の動き」が混ざった順番を学んでいた。
     *   → **`by` がある時は「人」だけを手本にする**（`by` が無い旧記録は今まで通り使う）。
     *     ⚠ 全部が auto の行は手本にしない（機械の癖を学ばない）。
     */
    const hasBy = (raw as unknown[]).some((o) => o && typeof o === "object" && ((o as Record<string, unknown>).by === "human" || (o as Record<string, unknown>).by === "auto"));
    for (const o of raw as unknown[]) {
      if (!o || typeof o !== "object") continue;
      const r = o as Record<string, unknown>;
      if (hasBy && r.by !== "human") continue;      // 人が押した物だけを手本にする
      const f = typeof r.f === "string" ? r.f.trim().slice(0, 30) : "";
      if (!f) continue;
      /** 2026-11-14: 押す対象でない入れ物は**並びから除く**（ゴミを学ばない） */
      if (!isLearnableName(f)) continue;
      seq.push({ t: num(r.t), k: typeof r.k === "string" ? r.k.slice(0, 10) : null, f });
    }
    if (seq.length >= 2) return [seq];
  }
  /**
   * 写真が無い記録: `field_order`（押した順番の名前の配列）から作る。
   *   ⚠ 時刻と種類は無い（null）＝順番だけ分かる。
   */
  const fo = row.field_order;
  if (Array.isArray(fo)) {
    const seq = (fo as unknown[])
      .map((x) => String(x ?? "").trim().slice(0, 30))
      .filter((f) => !!f && isLearnableName(f))
      .map((f) => ({ t: null, k: null, f }));
    if (seq.length >= 2) return [seq];
  }
  return [];
}

/**
 * 「A B A B A B…」の交互クリック（＝人の順ではなく**拡張のトグル跡**）を見つける。
 *
 * 2026-11-13 竹内さん「自動検索のところちゃんと学習されるようになっているのか」:
 *   実測で 40件中24件にこの形があった（`room_layout_id[]` ⇄ `左の1K｜label` が10回）。
 *   人がある欄を10往復押す事はまず無い（同じ所を押すと**選択が外れる**ので、
 *   人がやると「選べていない」事に気づいて止める）。
 *   → **3往復以上**（同じ2つの間を行き来）を含む並びは学習に使わない。
 *
 * @param seq 操作の並び（f＝欄の名前）
 * @returns 交互クリックと見なすなら true
 */
export function looksLikeToggleLoop(seq: ReadonlyArray<{ f?: string | null }>): boolean {
  if (!Array.isArray(seq) || seq.length < 6) return false;
  const f = seq.map((x) => String(x?.f ?? ""));
  // 隣り合う2つの組み (a,b) が、a b a b a b と3往復以上続くか
  let alt = 0;
  for (let i = 2; i < f.length; i++) {
    if (f[i] && f[i] === f[i - 2] && f[i] !== f[i - 1]) alt++;
    else alt = 0;
    if (alt >= 4) return true;   // 3往復＝6回の所で4回の一致（余裕を見て4）
  }
  // 同じ欄が3回以上連続（押し直し）も、人の順としては使わない
  let run = 1;
  for (let i = 1; i < f.length; i++) {
    if (f[i] && f[i] === f[i - 1]) { run++; if (run >= 4) return true; }
    else run = 1;
  }
  return false;
}

/**
 * 押す順番を学ぶ（純関数）。
 *   ・直前の操作（f）→ その次に押された物 を数える
 *   ・同じ欄の続き（値の入力中）は数えない
 *   ・`min` 回以上そろった物だけ返す（1回は偶然かもしれない）
 */
export function learnNextPress(
  sequences: ReadonlyArray<ReadonlyArray<{ f: string }>>,
  opt: { min?: number; top?: number } = {},
): Record<string, NextStat> {
  const min = opt.min ?? 2;
  const top = opt.top ?? 200;
  const tally: Record<string, Record<string, number>> = {};
  const list = Array.isArray(sequences) ? sequences : [];
  for (const seq of list) {
    if (!Array.isArray(seq) || seq.length < 2) continue;
    for (let j = 1; j < seq.length; j++) {
      const a = seq[j - 1]?.f;
      const b = seq[j]?.f;
      if (!a || !b || a === b) continue;
      (tally[a] ||= {})[b] = (tally[a][b] ?? 0) + 1;
    }
  }
  const out: Record<string, NextStat> = {};
  const keys = Object.keys(tally);
  keys.sort((x, y) => {
    const sx = Object.values(tally[x]).reduce((s, n) => s + n, 0);
    const sy = Object.values(tally[y]).reduce((s, n) => s + n, 0);
    return sy - sx;
  });
  for (const from of keys.slice(0, top)) {
    const dest = tally[from];
    const names = Object.keys(dest).sort((a, b) => dest[b] - dest[a]);
    const n = dest[names[0]] ?? 0;
    const total = names.reduce((s, x) => s + dest[x], 0);
    if (n < min) continue;
    out[from] = { next: names[0], n, total };
  }
  return out;
}

/** 要素ごとの押した位置をまとめる（回数の多い実測に寄せる） */
export function learnPoints(rows: ReadonlyArray<MotionRow>): Record<string, PointStat> {
  const out: Record<string, PointStat> = {};
  for (const row of rows) {
    const f = row.point_fields;
    if (!f || typeof f !== "object") continue;
    for (const [name, v] of Object.entries(f as Record<string, unknown>)) {
      if (!v || typeof v !== "object") continue;
      /**
       * 2026-11-14 竹内さん「ゴミデータが入らないようになっているか」:
       *   押す対象でない入れ物（`div`・`img`・`td` など）は**学ばない**。
       */
      if (!isLearnableName(name)) continue;
      const r = v as Record<string, unknown>;
      const x = frac(r.x), y = frac(r.y), n = num(r.n) ?? 0;
      if (x == null || y == null || n <= 0) continue;
      const key = String(name).slice(0, 30);
      const old = out[key];
      // 2026-11-13 竹内さん「どこがダウンドロップでどこが入力する部分か」: 要素の種類も残す
      const w = typeof r.w === "string" ? r.w.slice(0, 10) : null;
      // 回数の多い方（新しい実測）を採る。同じ回数なら新しい行を採る（後の行）
      if (!old || n >= old.n) out[key] = { x, y, n, ...(w ? { w } : (old?.w ? { w: old.w } : {})) };
    }
  }
  return out;
}

/**
 * 2026-11-14 竹内さん「ボタンなのかプルダウンなのか、どこで展開されるのかも意識して学習して改善する」:
 *   **押したら何が開くか**を欄ごとにまとめる（純関数）。
 *   ・`modal`        … 小窓（所在地絞り込み・沿線）が開く
 *   ・`options`      … プルダウンの選択肢が開く
 *   ・`form`         … 条件の欄が増える／変わる
 *   ・`result`       … 結果の一覧に変わる
 *   ・`modal_close`  … 開いていた小窓が閉じる（確定してリストへ等）
 *   ・`none`         … 見た目に変化が無い
 *   ⚠ 学ぶのは**開き方の種類**だけ（中身・入力値は扱わない）。
 *   ⚠ `div`/`img` などの入れ物の名前は学ばない（`isLearnableName`）。
 */
/**
 * 2026-11-14 竹内さん「最新の学びが反映されるようになっているのか」:
 *   `opens`（押したら何が開くか）は **v2.7.32 の録画から**入る新しい記録なので、
 *   それ以前の記録では空になる（実測 opens 0個）。
 *   だが**名前を見れば開き方はほぼ分かる**:
 *     ・`所在地絞り込み` / `沿線・駅絞り込み` → **modal**（小窓が開く）
 *     ・`確定してリストへ` / `とじる` / `×` → **modal_close**（小窓が閉じる）
 *     ・`検索` / `go_search` → **result**（結果の一覧に変わる）
 *     ・`区` / `町字` / `沿線` / `駅` を選ぶ label → その場で選ぶだけ＝**none**
 *   → 記録が無い欄だけ**名前から補う**（`w_src:"name"` と同じ考え方・確かさは低い）。
 *   ⚠ 実際の記録（opens）が入っている欄は**そちらを優先**（推測で上書きしない）。
 */
export function guessOpensFromName(name: unknown): string | null {
  const n = String(name ?? "").trim();
  if (!n) return null;
  if (!isLearnableName(n)) return null;
  /**
   * ⚠ 自分の UI（AIXLINX の小窓）は学ばない（学習の入口で弾いているが、古い記録に残っている）。
   */
  if (/AIXLINX|aixlinx|#axlx-|axlx-bar/i.test(n)) return null;
  /**
   * 実際の名前は `左の所在地絞り込み＋｜span` のように **場所と印が付く**。
   *   ⚠ 完全一致で見ると1つも当たらない（実測 0個）。→ **含む**で見る。
   */
  // ① 小窓を開くボタン
  if (/所在地絞り込み|沿線・駅絞り込み/.test(n)) return "modal";
  // ② 小窓の中で次の段へ進む（中の画面が変わる）
  if (/駅の設定へ進む|設定へ進む|地域の設定へ進む|区を選ぶ|町字を選ぶ|沿線を選ぶ/.test(n)) return "form";
  // ③ 小窓を閉じる・確定する
  if (/確定してリストへ|確定|とじる|閉じる/.test(n)) return "modal_close";
  // ④ 検索（結果に変わる）
  if (/go_search|住居検索|物件を検索|^左の検索|｜span$/.test(n) && /検索/.test(n)) return "result";
  // ⑤ プルダウン（欄の名前がそのまま select の name）
  if (/^(rental_cost\d?|square_meter_[lh]|structured_date|update_date|transportation_id)$/.test(n)) return "options";
  return null;
}

/**
 * 記録から学んだ開き方に、**名前からの推測**を足す（記録を優先）。
 *   ⚠ 推測した物は `n: 0` と `stage` 無しで入れる（「実測ではない」と分かる形）。
 */
export function withGuessedOpens(
  learned: Record<string, { opens: string; n: number; stage?: string }>,
  names: Iterable<string>,
): Record<string, { opens: string; n: number; stage?: string; guessed?: boolean }> {
  const out: Record<string, { opens: string; n: number; stage?: string; guessed?: boolean }> = { ...learned };
  for (const nm of names) {
    if (out[nm]) continue;              // 実測がある欄は触らない
    const g = guessOpensFromName(nm);
    if (!g) continue;
    out[nm] = { opens: g, n: 0, guessed: true };
  }
  return out;
}

export function learnOpens(rows: ReadonlyArray<MotionRow>): Record<string, { opens: string; n: number; stage?: string }> {  const acc: Record<string, { opens: Record<string, number>; n: number; stage: string | null }> = {};
  for (const row of rows) {
    const v = (row as unknown as Record<string, unknown>).opens;
    if (!v || typeof v !== "object" || Array.isArray(v)) continue;
    for (const [name, raw] of Object.entries(v as Record<string, unknown>)) {
      if (!isLearnableName(name)) continue;
      const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
      const kind = String(r.opens ?? "").trim();
      const n = num(r.n) ?? 0;
      if (!kind || n <= 0) continue;
      const key = String(name).slice(0, 30);
      const cur = acc[key] || { opens: {}, n: 0, stage: null };
      cur.opens[kind] = (cur.opens[kind] || 0) + n;
      cur.n += n;
      const st = typeof r.stage === "string" ? r.stage.slice(0, 10) : null;
      if (st) cur.stage = st;
      acc[key] = cur;
    }
  }
  const out: Record<string, { opens: string; n: number; stage?: string }> = {};
  for (const [k, v] of Object.entries(acc)) {
    let best = "", bn = -1;
    for (const [kind, cnt] of Object.entries(v.opens)) if (cnt > bn) { best = kind; bn = cnt; }
    if (!best) continue;
    out[k] = { opens: best, n: v.n, ...(v.stage ? { stage: v.stage } : {}) };
  }
  return out;
}

/** 動きの癖（速さ・曲がり・狙う位置・スクロール）をまとめる */
export function learnMotion(rows: ReadonlyArray<MotionRow>): MotionStat {  const speeds: number[] = [], curves: number[] = [], dx: number[] = [], dy: number[] = [], dyScroll: number[] = [];
  let moves = 0, points = 0, scrolls = 0;
  for (const r of rows) {
    const mn = num(r.moves_n) ?? 0;
    if (mn > 0) {
      moves += mn;
      const s = num(r.move_speed_px_s);
      if (s != null && s > 0) speeds.push(s);
      const c = num(r.move_curve);
      if (c != null && c >= 1) curves.push(c);
    }
    const pn = num(r.points_n) ?? 0;
    if (pn > 0) {
      points += pn;
      const x = num(r.point_x), y = num(r.point_y);
      if (x != null) dx.push(x);
      if (y != null) dy.push(y);
    }
    const sn = num(r.scrolls_n) ?? 0;
    if (sn > 0) {
      scrolls += sn;
      const d = num(r.scroll_dy);
      if (d != null && d > 0) dyScroll.push(d);
    }
  }
  const clamp = (v: number, lo: number, hi: number) => Math.round(Math.max(lo, Math.min(hi, v)) * 100) / 100;
  return {
    speed_px_s: speeds.length ? clamp(median(speeds) ?? 0, 100, 4000) : null,
    curve: curves.length ? clamp(median(curves) ?? 1, 1, 2) : null,
    aim: (dx.length && dy.length) ? { x: clamp(median(dx) ?? 0.5, 0.2, 0.8), y: clamp(median(dy) ?? 0.5, 0.2, 0.8) } : null,
    scroll_dy: dyScroll.length ? Math.round(Math.max(50, Math.min(1500, median(dyScroll) ?? 0))) : null,
    moves, points, scrolls,
  };
}

/**
 * 学習の束を作る（この1関数が「学習担当のブレイン」の芯）。
 * @param rows 元にした記録（新しい順でなくてよい）
 * @param nowMs 生成時刻（テストで固定できるように）
 */
/**
 * 2026-11-14 竹内さん「データベースと統括もちゃんと関連しなきゃいけない」
 *   「これで統括に確認したらすべて把握している状態にする。弱い部分も統括はすべて把握する」:
 *   **実際の検索の結果（`search_audits`）も渡せるようにする**。
 *   ⚠ これが無いと、統括は人の動きだけを見て「渡してよい」と言ってしまう
 *     （実測: 60回中56回が途中で止まっていたのに `ready` を出していた）。
 * @param audits 直近の検索の集計（`summarizeAudits`）。省略可（テスト・古い呼び出しを壊さない）。
 */
export function buildHumanLearnBundle(
  rows: ReadonlyArray<MotionRow>,
  nowMs: number = Date.now(),
  audits: import("./learn-audit-summary").AuditSummary | null = null,
  commands: import("./learn-command-summary").CommandSummary | null = null,
  /**
   * 2026-11-14 竹内さん「所在地での検索の動かし方や、物件の取得、次のページへの移動の仕方で
   *   統括が弱い部分の学習を強化する」「これらの思考や考え方は統括の部分で重要な考え方にする」:
   *   **場面ごとの手順**（`search_audits.filled.ops` の人の実測・`app/lib/learn-flow-steps.ts`）。
   *   ⚠ 人の動きの記録（`human_motion_learn`）とは**別の表**から作るので、引数で受け取る。
   */
  sceneMeta: {
    scene_flows?: import("./learn-flow-steps").SceneFlow[] | null;
    scene_missing?: number;
    scene_missing_names?: string;
    stopped_scene?: string | null;
  } | null = null,
): HumanLearnBundle {
  const list = Array.isArray(rows) ? rows : [];
  // ① 押す順番（写真ごとの並びから）
  /**
   * 2026-11-13 竹内さん「ほかに抜けている箇所はあるのか。原因見つけて改善する」:
   *   ⚠ 録画モードは1.5〜3.5秒ごとに写真を撮るので、**同じ操作の並びが何枚も送られる**。
   *     そのまま数えると「確定してリストへ → required_time」が 77回のように**水増し**され、
   *     確からしさ（n/total が 100%）が本当の意味を失う（実際に全部 100% になっていた）。
   *   → **同じ検索（同じ日の同じ並び）は1回だけ数える**。
   *     ⚠ 別の日・別の時刻に同じ順で押したのは**本物の繰り返し**なので残す
   *       （同じ日の中の重複だけを畳む）。
   *   ⚠ 並びが伸びていく途中（1個→2個→3個…）は、一番長い物だけを採る（短い重複は捨てる）。
   */
  const seqGroups = new Map<string, Array<{ f: string }>>();
  for (const r of list) {
    // 同じ日の中の重複を畳むための印（UTC の日付）
    const day = String(r.created_at ?? "").slice(0, 10);
    for (const s of sequencesOf(r)) {
      /**
       * 2026-11-13 竹内さん「自動検索のところちゃんと学習されるようになっているのか」:
       *   ⚠ 実測で **40件中24件が「A B A B A B…」の交互クリック**だった
       *     （`room_layout_id[]` ⇄ `左の1K｜label` が10回）。
       *     これは人が押した順ではなく、**拡張がチェックをトグルさせてしまった跡**。
       *     これを学ぶと「次はこれを押す」が**でたらめ**になる（実際 next が20/20回になっていた）。
       *   → **交互（A B A B…が3往復以上）を含む並びは学習に使わない**（記録は残す）。
       */
      if (looksLikeToggleLoop(s)) continue;
      const key = day + "|" + s.map((x) => String(x.f ?? "")).join(">");
      const cur = seqGroups.get(key);
      if (!cur || s.length > cur.length) seqGroups.set(key, s);
    }
  }
  // 短い並びで、より長い並びの先頭と完全に一致する物は捨てる（同じ操作の途中経過）
  const entries = Array.from(seqGroups.entries()).sort((a, b) => b[1].length - a[1].length);
  const seqs: Array<Array<{ f: string }>> = [];
  for (const [key, s] of entries) {
    const isPrefix = entries.some(([k2]) => k2 !== key && k2.endsWith(key.slice(key.indexOf("|") + 1)) && k2.length > key.length);
    if (!isPrefix) seqs.push(s);
  }
  const next = learnNextPress(seqs, { min: 2 });

  // ② 押した位置
  const points = learnPoints(list);

  // ②' 押したら何が開くか（2026-11-14）
  const opens = learnOpens(list);

  // ③ 動き
  const motion = learnMotion(list);

  // ④ 押された回数の多いボタン
  const btnTally: Record<string, number> = {};
  for (const [name, v] of Object.entries(points)) btnTally[name] = v.n;
  const buttons = Object.entries(btnTally)
    .map(([name, n]) => ({ name, n }))
    .sort((a, b) => b.n - a.n)
    .slice(0, 30);

  // ⑤ サイトごとの手順（同じ「直前→次」をサイト別にまとめる）
  /**
   * 2026-11-13 竹内さん「ほかに抜けている箇所はあるのか」:
   *   ⚠ ここも**同じ日の同じ検索を何度も数えていた**（録画は数秒ごとに撮るため）。
   *     `next` と同じく「同じ日の同じ並びは1回」に畳んでから数える。
   */
  const siteFlow: Record<string, Record<string, Record<string, number>>> = {};
  const flowSeen = new Set<string>();
  for (const r of list) {
    const site = String(r.site || "").trim() || "unknown";
    const day = String(r.created_at ?? "").slice(0, 10);
    for (const s of sequencesOf(r)) {
      // 2026-11-13: 交互クリック（拡張のトグル跡）は手順として学ばない
      if (looksLikeToggleLoop(s)) continue;
      const sig = day + "|" + s.map((x) => String(x.f ?? "")).join(">");
      if (flowSeen.has(sig)) continue;   // 同じ日の同じ検索は1回だけ数える
      flowSeen.add(sig);
      for (let j = 1; j < s.length; j++) {
        const a = s[j - 1]?.f, b = s[j]?.f;
        if (!a || !b || a === b) continue;
        ((siteFlow[site] ||= {})[a] ||= {})[b] = ((siteFlow[site][a] ||= {})[b] ?? 0) + 1;
      }
    }
  }
  const site_flow: Record<string, Array<{ from: string; to: string; n: number }>> = {};
  for (const [site, froms] of Object.entries(siteFlow)) {
    const flat: Array<{ from: string; to: string; n: number }> = [];
    for (const [from, dests] of Object.entries(froms)) {
      for (const [to, n] of Object.entries(dests)) if (n >= 2) flat.push({ from, to, n });
    }
    site_flow[site] = flat.sort((a, b) => b.n - a.n).slice(0, 40);
  }

  // ⑥ 操作の間
  /**
   * 2026-11-13 竹内さん「ほかに抜けている箇所はあるのか。原因見つけて改善する」:
   *   ⚠ 旧は `move_ms`（**マウス移動にかかった時間**）を「操作と操作の間」として使っていた。
   *     移動時間は数百ms の別物で、**人が「次を押すまで待つ時間」ではない**
   *     （実測: 514ms と出ていたが、これは移動時間）。
   *   → 記録が持っている `gap_ms`（操作と操作の間）を先に使い、無ければ `move_ms` で代用する。
   *     `gap_ms` は拡張（human-learn-record）が「記録の束」で送っている。
   */
  const gapFromGap = list.map((r) => num(r.gap_ms)).filter((v): v is number => v != null && v > 0);
  /**
   * 2026-11-13: 上の2つが無い時は、`shot_ops` の `g`（操作と操作の間）から作る。
   *   これが**一番本来の値**（人が次を押すまで実際に待った時間）。
   */
  const gapFromOps: number[] = [];
  for (const r of list) {
    if (!Array.isArray(r.shot_ops)) continue;
    for (const o of r.shot_ops) {
      if (!o || typeof o !== "object") continue;
      const g = num((o as Record<string, unknown>).g);
      if (g != null && g > 0 && g <= 60000) gapFromOps.push(g);
    }
  }
  const gapSamples = gapFromGap.length
    ? gapFromGap
    : (gapFromOps.length ? gapFromOps : list.map((r) => num(r.move_ms)).filter((v): v is number => v != null && v > 0));

  /**
   * 2026-11-13 竹内さん「画面の写真から判断できる。そこの部分強化するようにする。
   *   画像を見れば学習できるし弱い部分等は学習の統括が判断して学習を繰り返していく」:
   *   写真から読んだ**欄の種類**を集めて、数値の記録に**埋める**（名前だけでは分からなかった種類）。
   *   ⚠ 写真が無い（`shot_learn` が無い）行は今まで通り数値だけで学ぶ。
   */
  const photoFields: Array<{ name: string; kind: string }> = [];
  /**
   * 2026-11-13: **操作の並び（shot_ops）にも種類（w）が入っている**（2.7.20 から）。
   *   写真の読み（shot_learn）が無くても、ここから欄の種類を学べる。
   */
  for (const r of list) {
    if (!Array.isArray(r.shot_ops)) continue;
    for (const o of r.shot_ops) {
      if (!o || typeof o !== "object") continue;
      const x = o as Record<string, unknown>;
      const nm1 = typeof x.f === "string" ? x.f.trim().slice(0, 30) : "";
      const kd1 = typeof x.w === "string" ? x.w.toLowerCase().slice(0, 10) : "";
      if (nm1 && kd1) photoFields.push({ name: nm1, kind: kd1 });
    }
  }
  for (const r of list) {
    const sl = r.shot_learn;
    if (!sl || typeof sl !== "object") continue;
    const fs2 = (sl as Record<string, unknown>).fields;
    if (!Array.isArray(fs2)) continue;
    for (const f of fs2) {
      if (!f || typeof f !== "object") continue;
      const o = f as Record<string, unknown>;
      const nm2 = typeof o.name === "string" ? o.name.trim().slice(0, 30) : "";
      const kd = typeof o.kind === "string" ? o.kind.toLowerCase().slice(0, 10) : "";
      if (nm2 && kd) photoFields.push({ name: nm2, kind: kd });
    }
  }
  let weak: Array<{ kind: string; name: string; why: string; next: string }> = [];
  /**
   * 2026-11-13 竹内さん「今弱い部分学習する。今のデータから学習する」:
   *   ⚠ 実測で弱い所 **40件がすべて `kind_unknown`**（押した記録に種類が無い・旧版の記録）。
   *     写真が無いので今まで埋められなかった。
   *   → **名前から種類を推す**（`guessKindFromName`）。`label.one_city` → チェック、
   *     `rental_cost1` → プルダウン、`required_time` → 直接入力、`確定してリストへ｜span` → 押す。
   *   ⚠ 推測した物は `w_src: "name"` と**確かさ**を残す（写真で読んだ物と区別する＝ごまかさない）。
   */
  const guessed: Array<{ name: string; kind: string; conf: number }> = [];
  for (const [name, v] of Object.entries(points)) {
    if (v.w) continue;                       // もう種類がある
    const g = guessKindFromName(name);
    if (!g) continue;
    (points as Record<string, PointStat>)[name] = { ...v, w: g.kind, w_src: "name", w_conf: g.conf } as never;
    guessed.push({ name, kind: g.kind, conf: g.conf });
  }  if (photoFields.length) {
    const rec = reconcilePoints(points as never, photoFields as never);
    Object.keys(points).forEach((k) => { if (rec.points[k]) points[k] = rec.points[k] as never; });
    weak = findWeakPoints(points as never, photoFields as never, rec.fixed as never);
  } else if (Object.keys(points).length) {    // 写真が1枚も無い時も、名前から推した分を除いた「まだ分からない物」を弱い所に残す
    weak = findWeakPoints(points as never, [], []);
  }
  /**
   * 2026-11-14 竹内さん「学習の統括が強化されるように、その点も徹底する」:
  /**
   *   弱い所を**次にやる事**に変える（統括の判断）。優先度順・根拠つき。
   *   さらに**モード別**（通常／自動／AIX）に「足りているか・何を足すか」も決める。
   *   ⚠ モード別の計算（by_mode）が済んでから呼ぶ。
   */
  // 元にした期間
  const times = list.map((r) => (r.created_at ? Date.parse(String(r.created_at)) : NaN)).filter((t) => Number.isFinite(t));
  const sites = Array.from(new Set(list.map((r) => String(r.site || "")).filter(Boolean)));
  /**
   * 2026-11-14 竹内さん「DBにあって反映できていないものはあるか」:
   *   **版の内訳**と、**材料（操作の並び）が揃っている記録の数**を出す。
   *   ⚠ 実測で直近200件が全部 2.7.29 だった＝新しい版の学習が現場に入っていない。
   *     数字で言えるようにしておく（人が「なぜ学びが増えないか」を追える）。
   */
  const versions: Record<string, number> = {};
  for (const r of list) {
    const v = String(r.ext_version ?? "").trim() || "(空)";
    versions[v] = (versions[v] ?? 0) + 1;
  }
  const withOps = list.filter((r) => {
    const x = r as unknown as Record<string, unknown>;
    return (Array.isArray(x.shot_ops) && x.shot_ops.length > 0)
      || (Array.isArray(x.field_order) && x.field_order.length > 0);
  }).length;

  /**
   * 2026-11-13 竹内さん「録画した画像もみて押し方や仕組みなども学習おねがい
   *   抜けている部分徹底的に学習できるように」:
   *   **写真（画面）ごとの仕組み**を学ぶ。画像そのものは見ずに、
   *   写真の行が持つ「URL・直前の操作・写真から読んだ欄」から画面を判定してまとめる。
   *   ⚠ 入れるのは画面の種類・欄の名前・順番だけ（中身は入れない）。
   */
  const shotRows = list.filter((r) => {
    const x = r as unknown as Record<string, unknown>;
    /**
     * 2026-11-14 竹内さん「データベースの写真から学習する」:
     *   ⚠ 旧は `shot_ops` か `shot_learn` か `url` が要った。実測では**写真200枚すべて `shot_ops` 空**・
     *     `shot_learn` も空なので、**写真から何も学べていなかった**。
     *   → `field_order`（押した順番）や `point_fields`（押した欄）があれば対象にする。
     *     写真の行は必ず `shot_taken` が true なので、`shot_key` があれば写真つきとして扱う。
     */
    return Array.isArray(x.shot_ops) || (x.shot_learn && typeof x.shot_learn === "object") || typeof x.url === "string"
      || (Array.isArray(x.field_order) && x.field_order.length > 0)
      || (x.point_fields && typeof x.point_fields === "object")
      || (x.shot_taken === true && typeof x.shot_key === "string" && x.shot_key.length > 0);
  });
  const shotLearn = shotRows.length
    ? learnFromShots(shotRows.map((r) => {
      const x = r as unknown as Record<string, unknown>;
      /**
       * 2026-11-14 竹内さん「データベースの写真から学習する」:
       *   ⚠ `shot_ops` が空の行ばかり（実測 200/200）なので、**押した順番と欄**も渡す。
       *     → 写真の行からでも「どの画面で何を触るか」を学べる。
       */
      return {
        url: x.url, shot_ops: x.shot_ops, shot_learn: x.shot_learn, created_at: x.created_at,
        point_fields: x.point_fields, field_order: x.field_order,
      };
    }))
    : { screens: {}, total: 0, withOps: 0 };

  /**
   * 2026-11-14 竹内さん「画面録画したのみたら一連の動き学習できるからいまみてみて」:
   *   録画の**一連の動き**から「この手順で押す」の型を作る。
   *   ⚠ 同じ日の同じ並びは1回だけ（録画は数秒ごとに撮るので水増しする）。
   *   ⚠ 交互クリック（トグル跡）は除く。
   */
  const seqForFlow: Array<Array<{ f: string }>> = [];
  const seenFlow = new Set<string>();
  for (const r of list) {
    const day = String(r.created_at ?? "").slice(0, 10);
    for (const s of sequencesOf(r)) {
      if (looksLikeToggleLoop(s)) continue;
      const key = day + "|" + s.map((x) => String(x.f ?? "")).join(">");
      if (seenFlow.has(key)) continue;
      seenFlow.add(key);
      seqForFlow.push(s);
    }
  }
  const sequenceFlow = seqForFlow.length ? learnSequenceFromShots(seqForFlow, { min: 2 }) : null;

  /**
   * 2026-11-14 竹内さん「自動で強化必要な部分を強化する。できていない部分もDBに理解させて強化する」:
   *   **モード別**に学ぶ（normal / staff / aix / brain …）。
   *   ⚠ 統括が「自動の時に足りない物」と「通常の時に足りない物」を**分けて**判断できるようにする。
   *   ⚠ 記録が3件未満のモードは作らない（偶然を学ばない）。
   */
  const modeBuckets = new Map<string, MotionRow[]>();
  for (const r of list) {
    const m = String(r.mode ?? "").trim();
    if (!m) continue;                       // モードが空の記録（旧版）は全体の学びにだけ使う
    if (!modeBuckets.has(m)) modeBuckets.set(m, []);
    modeBuckets.get(m)!.push(r);
  }
  const by_mode: NonNullable<HumanLearnBundle["by_mode"]> = {};
  const mode_counts: Record<string, number> = {};
  for (const [m, sub] of modeBuckets) {
    mode_counts[m] = sub.length;
    if (sub.length < 3) continue;
    const subSeqs: Array<Array<{ f: string }>> = [];
    const seen = new Set<string>();
    for (const r of sub) {
      const day = String(r.created_at ?? "").slice(0, 10);
      for (const s of sequencesOf(r)) {
        if (looksLikeToggleLoop(s)) continue;
        const key = day + "|" + s.map((x) => String(x.f ?? "")).join(">");
        if (seen.has(key)) continue;
        seen.add(key);
        subSeqs.push(s);
      }
    }
    const subNext = learnNextPress(subSeqs, { min: 2 });
    const subFlow = (() => {
      const shotRowsSub = sub.filter((r) => {
        const x = r as unknown as Record<string, unknown>;
        /**
         * 2026-11-14: `shot_ops` が空でも `field_order` / `point_fields` があれば学べる
         *   （実測で写真200枚すべて shot_ops が空だった）。
         */
        return Array.isArray(x.shot_ops) || (x.shot_learn && typeof x.shot_learn === "object")
          || (Array.isArray(x.field_order) && x.field_order.length > 0)
          || (x.point_fields && typeof x.point_fields === "object");
      });
      if (!shotRowsSub.length) return {};
      const lf = learnFromShots(shotRowsSub.map((r) => {
        const x = r as unknown as Record<string, unknown>;
        return {
          url: x.url, shot_ops: x.shot_ops, shot_learn: x.shot_learn,
          point_fields: x.point_fields, field_order: x.field_order,
        };
      }));
      const out: Record<string, { n: number; steps: Array<{ from: string; to: string; n: number }> }> = {};
      for (const [sc, v] of Object.entries(lf.screens)) out[sc] = { n: v.n, steps: v.steps.slice(0, 12) };
      return out;
    })();
    const subGaps = sub.map((r) => num(r.gap_ms)).filter((v): v is number => v != null && v > 0);
    by_mode[m] = {
      rows: sub.length,
      next: subNext,
      screen_flow: subFlow,
      gaps: { median_ms: median(subGaps), samples: subGaps.length },
      points_n: sub.reduce((s, r) => s + (num(r.points_n) ?? 0), 0),
    };
  }

  /**
   * 2026-11-14 竹内さん「ゴミデータが入らないようになっているか／学習は統括の部分が管轄して整理もできているのか」:
   *   **入る前**にゴミを数え、統括に渡す（統括が「除く・畳む」を判断する）。
   *   ⚠ 実際の除去は `sequencesOf`（isLearnableName）・`looksLikeToggleLoop`・同じ日の畳み込みが行う。
   */
  const garbage: Array<{ kind: string; n: number }> = [];
  {
    let toggle = 0, junk = 0, dup = 0, longRun = 0;
    const seenDay = new Set<string>();
    for (const r of list) {
      const rawOps = Array.isArray(r.shot_ops) ? (r.shot_ops as unknown[]) : [];
      const names = rawOps
        .map((o) => (o && typeof o === "object" ? String((o as Record<string, unknown>).f ?? "").trim() : ""))
        .filter(Boolean);
      if (names.length) {
        // 押す対象でない入れ物
        junk += names.filter((n) => !isLearnableName(n)).length;
        // 交互クリック
        for (const s of sequencesOf({ ...r, shot_ops: names.map((f) => ({ f })) } as never)) {
          if (looksLikeToggleLoop(s)) toggle++;
        }
        // 同じ欄の4連打
        let run = 1;
        for (let i = 1; i < names.length; i++) {
          if (names[i] === names[i - 1]) { run++; if (run >= 4) { longRun++; break; } }
          else run = 1;
        }
        // 同じ日の同じ並び
        const day = String(r.created_at ?? "").slice(0, 10);
        const sig = day + "|" + names.join(">");
        if (seenDay.has(sig)) dup++;
        else seenDay.add(sig);
      }
      const fo = (r as unknown as Record<string, unknown>).field_order;
      if (Array.isArray(fo)) junk += fo.map((x) => String(x ?? "")).filter((n) => n && !isLearnableName(n)).length;
    }
    if (toggle) garbage.push({ kind: "交互クリック（トグル跡）", n: toggle });
    if (junk) garbage.push({ kind: "押す対象でない入れ物", n: junk });
    if (dup) garbage.push({ kind: "同じ日の同じ並び（水増し）", n: dup });
    if (longRun) garbage.push({ kind: "同じ欄の4連打", n: longRun });
  }

  /**
   * 2026-11-14 竹内さん「学習の統括が強化されるように、その点も徹底する」:
   *   弱い所を**次にやる事**に変える（統括の判断）。優先度順・根拠つき。
   *   さらに**モード別**（通常／自動／AIX）に「足りているか・何を足すか」も決める。
   */
  const learnPlan = planLearnFromWeak(weak, guessed, Object.fromEntries(
    Object.entries(by_mode).map(([m, v]) => [
      m,
      {
        rows: v.rows,
        next: Object.keys(v.next).length,
        steps: Object.values(v.screen_flow).reduce((s, x) => s + x.steps.length, 0),
        gaps: v.gaps,
      },
    ])),
    garbage, mode_counts);

  /**
   * 2026-11-14 竹内さん「通常モードで行っているのはスタッフ等人間が実際の動きをしているので
   *   そこを理解して学習する」:
   *   **人が押した操作**と**拡張が押した操作**を分けて数える（手本にできるのは人の動き）。
   */
  const humanOpsCount = (() => {
    let n = 0;
    for (const r of list) {
      const x = r as unknown as Record<string, unknown>;
      const ops = Array.isArray(x.shot_ops) ? (x.shot_ops as unknown[]) : [];
      for (const o of ops) {
        if (o && typeof o === "object" && (o as Record<string, unknown>).by === "human") n++;
      }
    }
    return n;
  })();
  const autoOpsCount = (() => {
    let n = 0;
    for (const r of list) {
      const x = r as unknown as Record<string, unknown>;
      const ops = Array.isArray(x.shot_ops) ? (x.shot_ops as unknown[]) : [];
      for (const o of ops) {
        if (o && typeof o === "object" && (o as Record<string, unknown>).by === "auto") n++;
      }
    }
    return n;
  })();

  /**
   * 2026-11-14 竹内さん「足りていない部分や弱い部分はきょうかするようにする」
   *   「いままでの画像から統括がまなぶことできないのか」:
   *   **同じ画像が続いている**記録を数える（`shot_ops` の `k:"same"`）。
   *   ⚠ 実測: 100枚が全部同じ画像だった（＝止まっている／別のタブを撮っている）。
   *     これは「学べていない」だけでなく、**撮影の仕組みが壊れている**疑い。
   */
  const sameRuns = (() => {
    let maxSame = 0, n = 0;
    for (const r of list) {
      const x = r as unknown as Record<string, unknown>;
      const ops = Array.isArray(x.shot_ops) ? (x.shot_ops as unknown[]) : [];
      for (const o of ops) {
        if (!o || typeof o !== "object") continue;
        const y = o as Record<string, unknown>;
        if (y.k !== "same") continue;
        const v = Number(y.same) || 0;
        if (v > 0) { n++; if (v > maxSame) maxSame = v; }
      }
    }
    return { n, max_same: maxSame };
  })();

  /**
   * 2026-11-14 竹内さん「画像のメモリも重ければ容量小さくする。統括がこのような部分もはんだんできるようにする」:
   *   **写真の容量と枚数**を統括に渡す（メモリ・Storage が重くなっていないか判断できる）。
   */
  const shotBytes = (() => {
    let total = 0, n = 0, max = 0;
    for (const r of list) {
      const x = r as unknown as Record<string, unknown>;
      const b = typeof x.shot_b64 === "string" ? x.shot_b64.length : 0;
      const w = num(x.shot_w), h = num(x.shot_h);
      if (b > 100) { total += b; n++; if (b > max) max = b; }
      else if (w != null && h != null && w > 0 && h > 0) { n++; }
    }
    return { n, total_bytes: total, max_bytes: max };
  })();

  /**
   * 2026-11-14 竹内さん「学習の統括の部分判断できるようにちゃんと強化していく」:
   *   `learn_plan` は「弱い所の一覧」で、**判断**をしていなかった（どれから直すか・今使えるか）。
   *   → 統括（`learn-supervisor.ts`）に**1つの結論**と**次にやる事**を決めさせる。
   *   ⚠ サイト別にも判断する（リアプロと itandi は性質が違う）。
   */
  const supervisor: SupervisorAdvice = superviseLearn({
    rows: list.length,
    next: Object.keys(next).length,
    points: Object.keys(points).length,
    opens: Object.keys(opens).length,
    screens: Object.keys(shotLearn.screens).length,
    sequence: (sequenceFlow && sequenceFlow.sequence ? sequenceFlow.sequence.length : 0),
    gap_ms: median(gapSamples),
    weak,
    mode_counts,
    site_counts: (() => {
      const sc: Record<string, number> = {};
      for (const r of list) {
        const s = String(r.site ?? "").trim() || "(空)";
        sc[s] = (sc[s] ?? 0) + 1;
      }
      return sc;
    })(),
    with_ops: list.filter((r) => {
      const x = r as unknown as Record<string, unknown>;
      return (Array.isArray(x.shot_ops) && x.shot_ops.length > 0) || (Array.isArray(x.field_order) && x.field_order.length > 0);
    }).length,
    prev: null,
    site: "all",
    /** 2026-11-14: 「押したら何が開くか」のうち**推測**で埋めた数（実測ではない） */
    guessed_opens: Object.values(opens).filter((v) => v && (v as { guessed?: boolean }).guessed).length,
    /** 写真がある記録の数（写真の割合を実データから出す） */
    shot_rows: list.filter((r) => {
      const x = r as unknown as Record<string, unknown>;
      return x.shot_taken === true || (typeof x.shot_key === "string" && x.shot_key.length > 0);
    }).length,
    /**
     * 2026-11-14 竹内さん「これで統括に確認したらすべて把握している状態にする」:
     *   **実際の検索の結果**（完走率・どこで止まるか・なぜ失敗したか）を統括に渡す。
     */
    audits: audits
      ? {
        runs: audits.runs,
        finished: audits.finished,
        abandoned: audits.abandoned,
        finish_rate: audits.finish_rate,
        stalled_at: audits.stalled_at,
        causes: audits.causes,
        bad: audits.bad,
        top_problem: audits.top_problem,
      }
      : null,
  /**
   * 2026-11-14 竹内さん「統括側に足りていない部分があれば強化する形とする」:
     *   **現場への指示の詰まり**も統括に渡す（検索が動いていても指示が届かなければ現場は止まる）。
     */
    commands: commands
      ? {
        total: commands.total,
        done: commands.done,
        failed: commands.failed,
        pending: commands.pending,
        running: commands.running,
        errors: commands.errors,
        top_problem: commands.top_problem,
        mode_absent: commands.mode_absent,
      }
      : null,
    /** 2026-11-14: 人が押した操作の数（手本にできる動き） */
    human_ops: humanOpsCount,
    /** 2026-11-14: 拡張が押した操作の数（機械の動き＝手本にしない） */
    auto_ops: autoOpsCount,
    /** 2026-11-14: 同じ画面が続いた記録（撮影の仕組みが壊れている疑い） */
    same_runs: sameRuns,
    /** 2026-11-14: 写真の容量と枚数（メモリ・Storage が重くないか） */
    shot_bytes: shotBytes,
    /**
     * 2026-11-14 竹内さん「所在地での検索の動かし方や、物件の取得、次のページへの移動の仕方で
     *   統括が弱い部分の学習を強化する」「これらの思考や考え方は統括の部分で重要な考え方にする」:
     *   **場面ごとの手順**（`search_audits.filled.ops` の人の実測）を渡す。
     *   ⚠ 写真が0枚でも、ここには人の順番が残っている＝一番強い材料。
     */
    scene_flows: Array.isArray(sceneMeta?.scene_flows) ? (sceneMeta!.scene_flows as never) : null,
    scene_missing: num(sceneMeta?.scene_missing),
    scene_missing_names: typeof sceneMeta?.scene_missing_names === "string" ? sceneMeta.scene_missing_names : "",
    stopped_scene: typeof sceneMeta?.stopped_scene === "string" ? sceneMeta.stopped_scene : null,
  } as SupervisorInput);

  /**
   * サイト別の統括の判断（リアプロ／itandi）。
   *   ⚠ 記録が無いサイトは作らない（「0件」を並べても判断にならない）。
   */
  const supervisor_by_site: Record<string, SupervisorAdvice> = {};
  for (const siteName of ["realpro", "itandi"]) {
    const sub = list.filter((r) => String(r.site ?? "").trim() === siteName);
    if (!sub.length) continue;
    const subNext = by_mode[siteName] ? null : null;   // （モード別とは別軸・下で計算）
    void subNext;
    const sPoints = learnPoints(sub);
    const sOpens = learnOpens(sub);
    /** 写真として学べる行（操作の並び・押した欄・順番がある物）だけを、型の合う形にそろえる */
    const sShotRows: Array<{ url?: unknown; shot_ops?: unknown; shot_learn?: unknown; point_fields?: unknown; field_order?: unknown }> = [];
    for (const r of sub) {
      const x = r as unknown as Record<string, unknown>;
      const hasMat = (Array.isArray(x.shot_ops) && x.shot_ops.length > 0)
        || (Array.isArray(x.field_order) && x.field_order.length > 0)
        || (x.point_fields && typeof x.point_fields === "object");
      if (!hasMat) continue;
      sShotRows.push({ url: x.url, shot_ops: x.shot_ops, shot_learn: x.shot_learn, point_fields: x.point_fields, field_order: x.field_order });
    }
    const sShots = learnFromShots(sShotRows);
    /** 一連の動きの数（`sequencesOf` は1行ずつ受け取る） */
    let sSeqN = 0;
    for (const r of sub) {
      try { sSeqN += sequencesOf(r).length; } catch (_) {}
    }
    const sSeq = { length: sSeqN } as { length: number };
    const sGaps: number[] = [];
    for (const r of sub) {
      const g = num(r.gap_ms);
      if (g != null && g > 0) sGaps.push(g);
    }
    /**
     * ⚠ `findWeakPoints` は「写真から読んだ欄の一覧（ShotField[]）」を受け取る。
     *   `sShots.screens` は**画面ごとのまとめ**なのでそのまま渡せない。
     *   → サイト別では写真の欄を平坦にして渡す（読めていなければ空＝弱い所は出ない）。
     */
    const sShotFields: Array<{ name: string; kind: string }> = [];
    for (const sc of Object.values(sShots.screens)) {
      for (const f of (sc.fields || [])) sShotFields.push({ name: f.name, kind: f.kind });
    }
    const sWeak = findWeakPoints(sPoints, sShotFields, []);
    const sModeCounts: Record<string, number> = {};
    for (const r of sub) {
      const m = String(r.mode ?? "").trim();
      if (m) sModeCounts[m] = (sModeCounts[m] ?? 0) + 1;
    }
    supervisor_by_site[siteName] = superviseLearn({
      rows: sub.length,
      next: Object.keys(learnNextPress(
        (() => {
          const seen2 = new Set<string>();
          const out2: Array<Array<{ f: string }>> = [];
          for (const r of sub) {
            const day = String(r.created_at ?? "").slice(0, 10);
            for (const sq of sequencesOf(r)) {
              if (looksLikeToggleLoop(sq)) continue;
              const key = day + "|" + sq.map((x) => String(x.f ?? "")).join(">");
              if (seen2.has(key)) continue;
              seen2.add(key);
              out2.push(sq);
            }
          }
          return out2;
        })(),
        { min: 2 },
      )).length,
      points: Object.keys(sPoints).length,
      opens: Object.keys(sOpens).length,
      screens: Object.keys(sShots.screens).length,
      sequence: sSeq.length,
      gap_ms: median(sGaps),
      weak: sWeak,
      mode_counts: sModeCounts,
      site_counts: { [siteName]: sub.length },
      with_ops: sub.filter((r) => {
        const x = r as unknown as Record<string, unknown>;
        return (Array.isArray(x.shot_ops) && x.shot_ops.length > 0) || (Array.isArray(x.field_order) && x.field_order.length > 0);
      }).length,
      /**
       * 2026-11-14 竹内さん「ちゃんと読み取って統括が理解して最善の指示おこなえるように」:
       *   **サイト別にも人の手本と機械の動き**を分けて渡す
       *   （itandi は人の手本が無いのに realpro の数字で判断していた）。
       */
      human_ops: (() => {
        let n = 0;
        for (const r of sub) {
          const x = r as unknown as Record<string, unknown>;
          const ops = Array.isArray(x.shot_ops) ? (x.shot_ops as unknown[]) : [];
          for (const o of ops) if (o && typeof o === "object" && (o as Record<string, unknown>).by === "human") n++;
        }
        return n;
      })(),
      auto_ops: (() => {
        let n = 0;
        for (const r of sub) {
          const x = r as unknown as Record<string, unknown>;
          const ops = Array.isArray(x.shot_ops) ? (x.shot_ops as unknown[]) : [];
          for (const o of ops) if (o && typeof o === "object" && (o as Record<string, unknown>).by === "auto") n++;
        }
        return n;
      })(),
      prev: null,
      site: siteName,
    });
  }
  const bundle: HumanLearnBundle = {
    v: 1,
    generated_at: new Date(nowMs).toISOString(),
    source: {
      rows: list.length,
      from: times.length ? new Date(Math.min(...times)).toISOString() : null,
      to: times.length ? new Date(Math.max(...times)).toISOString() : null,
      sites,
      ...(Object.keys(versions).length ? { versions } : {}),
      with_ops: withOps,
      /** 2026-11-14: 人の動きと機械の動きを分けて載せる */
      human_ops: humanOpsCount,
      auto_ops: autoOpsCount,
    },
    next,
    points,
    motion,
    buttons,
    site_flow,
    /**
     * 2026-11-14 竹内さん「どこで展開されるのかも意識して学習して改善する」:
     *   押したら何が開くか（modal / options / form / result）を欄ごとに渡す。
     *   ⚠ `opens` は新しい記録（v2.7.32〜）なので、それ以前は空。
     *     → **名前から分かる物だけ推測で補う**（実測がある欄は実測を優先）。
     */
    opens: withGuessedOpens(opens, [...Object.keys(points), ...Object.keys(next)]),
    gaps: { median_ms: median(gapSamples), samples: gapSamples.length },
    supervisor,
    ...(Object.keys(supervisor_by_site).length ? { supervisor_by_site } : {}),
    ...(weak.length ? { weak } : {}),
    ...(Object.keys(shotLearn.screens).length ? { screen_flow: shotLearn.screens, shots: { total: shotLearn.total, with_ops: shotLearn.withOps } } : {}),
    ...(learnPlan.items.length || learnPlan.filled || (learnPlan.cleanup && learnPlan.cleanup.length) || (learnPlan.mode_plan && learnPlan.mode_plan.length) ? { learn_plan: learnPlan } : {}),
    ...(Object.keys(by_mode).length ? { by_mode } : {}),
    /**
     * 2026-11-14: `mode_counts` は by_mode と**別**に出す。
     *   ⚠ 旧は `{ by_mode, mode_counts }` とまとめていたので、by_mode が空（3件未満だけ）だと
     *     **件数の内訳まで消えていた**（どのモードで何件動いたか分からない）。
     */
    ...(Object.keys(mode_counts).length ? { mode_counts } : {}),
    ...(sequenceFlow && sequenceFlow.sequence.length ? { sequence_flow: sequenceFlow } : {}),
    lines: [],
  };


  bundle.lines = describeBundle(bundle);
  /**
   * 2026-11-14 竹内さん「なんでここ統括がちゃんと学習する絶対ルールなのに連携できていないのか」:
   *   → **投げっぱなしが原因の1つだった**（Vercel は応答を返した時点で打ち切るので、
   *     書き込みが完了する前に終わることがある）。しかも失敗しても誰も気づけなかった。
   *   → この関数は**同期**（純関数に近い）なので、ここでは await できない。
   *     保存は**呼ぶ側（API）が待つ**形にする（`saveSupervisorForBundle` を export し、
   *     `/api/human-learn-profile` が `await` する）。
   *     ⚠ 保存に失敗しても**学習の束は返す**（現場を止めない）。失敗は理由つきで残す。
   */
  try {
    const b = bundle as unknown as Record<string, unknown>;
    b.__supervisor_to_save = true;
  } catch (_) {}
  return bundle;
}

/**
 * 統括の判断を**待って**保存する（2026-11-14 竹内さん「なんで…連携できていないのか」）。
 *
 *   ⚠ `buildHumanLearnBundle` は**同期**（純関数に近い）なので、中で await できない。
 *     旧は `void (async () => {...})()` の**投げっぱなし**で、しかも失敗を握り潰していた
 *     （＝Vercel が先に応答して書き込みが消える・RLS で弾かれても気づけない）。
 *   → 保存だけを**別の非同期関数**にして、呼ぶ側（API）が `await` する。
 *
 * @returns 保存の結果（`{ all, by_site }`）。失敗しても投げない（束は返している）。
 */
export async function saveSupervisorForBundle(
  bundle: HumanLearnBundle,
): Promise<{ all: { ok: boolean; skipped?: string; error?: string }; by_site: Record<string, { ok: boolean; skipped?: string; error?: string }> }> {
  const out: { all: { ok: boolean; skipped?: string; error?: string }; by_site: Record<string, { ok: boolean; skipped?: string; error?: string }> } = {
    all: { ok: false, skipped: "not_attempted" },
    by_site: {},
  };
  try {
    const { saveSupervisorLog } = await import("./learn-supervisor-db");
    const sv = bundle.supervisor;
    if (!sv) { out.all = { ok: false, skipped: "no_supervisor" }; return out; }
    const base = {
      next_n: Object.keys(bundle.next || {}).length,
      points_n: Object.keys(bundle.points || {}).length,
      opens_n: Object.keys(bundle.opens || {}).length,
      screens_n: Object.keys(bundle.screen_flow || {}).length,
      sequence_n: (bundle.sequence_flow && Array.isArray(bundle.sequence_flow.sequence)) ? bundle.sequence_flow.sequence.length : 0,
      with_ops: Number((bundle.source as unknown as Record<string, unknown>)?.with_ops) || 0,
      guessed_opens: 0,
      rows: Number(bundle.source?.rows) || 0,
      bundle_at: bundle.generated_at,
    };
    out.all = await saveSupervisorLog("all", sv, base);
    const per = (bundle.supervisor_by_site || {}) as Record<string, typeof sv>;
    for (const [sn, one] of Object.entries(per)) {
      if (!one) continue;
      out.by_site[sn] = await saveSupervisorLog(sn, one, { ...base, bundle_at: bundle.generated_at });
    }
  } catch (e) {
    out.all = { ok: false, error: String((e && (e as Error).message) || e).slice(0, 200) };
  }
  return out;
}

/** 何を学んだかを人が読める1行ずつに（画面・報告用） */
export function describeBundle(b: HumanLearnBundle): string[] {
  const out: string[] = [];
  const pct = (x: number) => Math.round(x * 100) + "%";
  out.push(`元にした記録: ${b.source.rows}件${b.source.sites.length ? "（" + b.source.sites.join("・") + "）" : ""}`);
  /**
   * 2026-11-14 竹内さん「DBにあって反映できていないものはあるか」:
   *   **材料が揃っているか**と**版の内訳**を出す（学びが増えない理由を数字で言えるように）。
   */
  if (typeof b.source.with_ops === "number") {
    const missing = b.source.rows - b.source.with_ops;
    out.push(`材料（操作の並び）がある記録: ${b.source.with_ops}件${missing > 0 ? `（${missing}件は材料が無く順番を学べない）` : ""}`);
  }
  /**
   * 2026-11-14 竹内さん「ちゃんと読み取って統括が理解して最善の指示おこなえるように」:
   *   **人の手本と機械の動き**を人が読める形でも出す。
   *   ⚠ 自動検索を良くするのは**人の手本**。機械の動きを学ぶと自分の癖を強めるだけ。
   */
  if (typeof b.source.human_ops === "number" || typeof b.source.auto_ops === "number") {
    const h = Number(b.source.human_ops) || 0;
    const a = Number(b.source.auto_ops) || 0;
    const t = h + a;
    if (t > 0) {
      out.push(`手本にできる動き: 人 ${h}回 / 機械 ${a}回（人の割合 ${Math.round((h / t) * 100)}%）`);
    }
  }
  if (b.source.versions && Object.keys(b.source.versions).length) {
    const top = Object.entries(b.source.versions).sort((a, x) => x[1] - a[1]).slice(0, 4);
    out.push(`記録した版: ${top.map(([v, n]) => `${v} ${n}件`).join("・")}`);
  }
  const nx = Object.keys(b.next);
  out.push(`押す順番: ${nx.length}通りを学びました`);
  nx.slice(0, 5).forEach((from) => {
    const v = b.next[from];
    out.push(`  ・「${from}」の次は「${v.next}」（${v.n}/${v.total}回）`);
  });
  const pt = Object.keys(b.points);
  out.push(`押す場所: ${pt.length}個の要素（${b.motion.points}回分）`);
  b.buttons.slice(0, 5).forEach((x) => {
    const p = b.points[x.name];
    out.push(`  ・${x.name} … ${x.n}回・横${p ? pct(p.x) : "?"}・縦${p ? pct(p.y) : "?"}`);
  });
  /**
   * 2026-11-14 竹内さん「ボタンなのかプルダウンなのか、どこで展開されるのかも意識して学習して改善する」:
   *   押したら**何が開くか**を1行で出す（人が読んで「学べている」と分かる形）。
   */
  const op = Object.keys(b.opens || {});
  if (op.length) {
    const label: Record<string, string> = {
      modal: "小窓が開く", options: "プルダウンの一覧が開く", form: "入力欄が変わる",
      result: "結果の一覧に変わる", modal_close: "小窓が閉じる", none: "変化なし",
    };
    out.push(`開き方: ${op.length}個の要素で学びました`);
    op.slice(0, 5).forEach((k) => {
      const v = b.opens![k];
      out.push(`  ・${k} … ${label[v.opens] || v.opens}（${v.guessed ? "名前から推測" : `${v.n}回`}）`);
    });
  }
  /**
   * 2026-11-13 竹内さん「どこがダウンドロップでどこが入力する部分かなども学習できているかな」:
   *   要素の種類（プルダウン／チェック／直接入力／押すだけ）を**日本語で**まとめて出す。
   */
  const WJ: Record<string, string> = { select: "プルダウン（開いて選ぶ）", checkbox: "チェック", radio: "チェック（1つ）", text: "直接入力", button: "押すだけ", link: "押すだけ", file: "ファイル", other: "その他" };
  const byKind: Record<string, string[]> = {};
  for (const [name, v] of Object.entries(b.points)) {
    if (!v.w) continue;
    (byKind[v.w] ||= []).push(name);
  }
  const kindKeys = Object.keys(byKind);
  if (kindKeys.length) {
    out.push(`欄の種類: ${kindKeys.length}種類を学びました`);
    for (const k of ["select", "checkbox", "radio", "text", "button", "link", "file", "other"]) {
      const names = byKind[k];
      if (!names || !names.length) continue;
      out.push(`  ・${WJ[k] || k}: ${names.length}個（${names.slice(0, 4).join("・")}${names.length > 4 ? "…" : ""}）`);
    }
  } else {
    out.push("欄の種類: まだ学んでいません（2.7.20 以降の操作で貯まります）");
  }
  out.push(b.motion.speed_px_s != null
    ? `動き: 速さ ${b.motion.speed_px_s}px/秒・曲がり ${b.motion.curve ?? "?"}（${b.motion.moves}回の動き）`
    : `動き: まだ材料が足りません（${b.motion.moves}回）`);
  if (b.gaps.median_ms != null) out.push(`操作の間: 中央値 ${Math.round(b.gaps.median_ms)}ms（${b.gaps.samples}件）`);
  /**
   * 2026-11-13 竹内さん「弱い部分等は学習の統括が判断して学習を繰り返していく」:
   *   弱い所を**人が読める形**で出す（統括はこれを見て次の学習を決める）。
   */
  if (b.weak && b.weak.length) {
    out.push(`弱い所: ${b.weak.length}件（次に学ぶ事）`);
    const KN: Record<string, string> = {
      kind_conflict_in_photo: "種類が割れている",
      kind_unknown: "種類が分からない",
      photo_vs_record: "写真と記録が違う",
      pressed_disabled: "押せない欄を押した",
    };
    b.weak.slice(0, 6).forEach((w) => {
      out.push(`  ・${KN[w.kind] || w.kind}: ${w.name} … ${w.why} → ${w.next}`);
    });
  } else {
    out.push("弱い所: なし（今の所そろっています）");
  }
  /**
   * 2026-11-13 竹内さん「学習の統括が強化されるように、その点も徹底する」:
   *   **次に何を学ぶか**（統括の判断）を出す。優先度順・やる事つき。
   */
  if (b.learn_plan) {
    const lp = b.learn_plan;
    out.push("");
    out.push("▼ 学習の統括: 次にやる事");
    out.push("  " + lp.summary);
    lp.items.slice(0, 8).forEach((x, i) => {
      out.push(`  ${i + 1}. ${x.name} … ${x.action}`);
    });
    if (!lp.items.length) out.push("  なし（今の所そろっています）");
  }
  /**
   * 2026-11-14 竹内さん「通常と自動のところで自動で強化必要な部分強化する」:
   *   **モードごと**の判断を出す（通常／スタッフ／AIX）。
   */
  if (b.learn_plan && Array.isArray(b.learn_plan.mode_plan) && b.learn_plan.mode_plan.length) {
    out.push("");
    out.push("▼ モードごとの判断");
    for (const m of b.learn_plan.mode_plan) {
      out.push(`  ・${m.verdict}`);
      if (m.action && m.action !== "追加で強化する所は無し") out.push(`    → ${m.action}`);
    }
  }
  /**
   * 2026-11-14 竹内さん「学習は統括の部分が管轄して整理もできているのか」:
   *   **整理（ゴミの扱い）**を出す。何を除いたか・何が残っているか。
   */
  if (b.learn_plan && Array.isArray(b.learn_plan.cleanup) && b.learn_plan.cleanup.length) {
    out.push("");
    out.push("▼ ゴミの整理（統括の判断）");
    for (const c of b.learn_plan.cleanup) {
      out.push(`  ・${c.kind}: ${c.n}件 … ${c.verdict}`);
      if (c.action && c.action !== "なし（除外の規則を入れた）" && c.action !== "なし（畳む規則は入っている）") out.push(`    → ${c.action}`);
    }
  }
  /**
   * 2026-11-14 竹内さん「画面録画したのみたら一連の動き学習できるから」:
   *   **一連の動き**（押す順番を1本にした物）を出す。
   */
  if (b.sequence_flow && b.sequence_flow.sequence.length) {
    const sf = b.sequence_flow;
    out.push("");
    out.push(`▼ 一連の動き（${sf.samples}本の並びから）`);
    out.push("  " + sf.sequence.slice(0, 18).join(" → ") + (sf.sequence.length > 18 ? " → …" : ""));
    for (const g of sf.groups) {
      out.push(`  【${g.name}】${g.steps.slice(0, 8).join(" → ")}${g.steps.length > 8 ? " → …" : ""}（${g.n}本）`);
    }
  }
  /**
   * 2026-11-13 竹内さん「録画した画像もみて押し方や仕組みなども学習おねがい」:
   *   **写真から学んだ画面ごとの仕組み**を出す（地域・駅の小窓では何をどの順で押すか）。
   *   ⚠ 中身（入力した値・お客様の情報）は出さない。欄の名前と順番だけ。
   */
  if (b.screen_flow && Object.keys(b.screen_flow).length) {
    const SJ: Record<string, string> = { modal: "小窓（地域・駅）", form: "条件の入力", result: "結果の一覧", other: "その他" };
    out.push("");
    out.push(`▼ 写真から学んだ画面ごとの仕組み${b.shots ? `（写真 ${b.shots.total}枚・操作つき ${b.shots.with_ops}枚）` : ""}`);
    for (const [screen, s] of Object.entries(b.screen_flow)) {
      if (!s || !s.n) continue;
      out.push(`  【${SJ[screen] || screen}】${s.n}枚`);
      if (s.steps.length) {
        // 回数の多い順に矢印でつなぐ（同じ元からは1本）
        const used = new Set<string>();
        const flow: Array<{ from: string; to: string; n: number }> = [];
        for (const x of s.steps) { if (used.has(x.from)) continue; used.add(x.from); flow.push(x); }
        out.push("    順番: " + flow.slice(0, 5).map((x) => `${x.from} → ${x.to}`).join(" / "));
      }
      if (s.lastPressed.length) {
        out.push("    最後に押す物: " + s.lastPressed.slice(0, 3).map((x) => `${x.name}（${x.n}枚）`).join("・"));
      }
      if (s.fields.length) {
        const KJ: Record<string, string> = { select: "プルダウン", text: "直接入力", checkbox: "チェック", radio: "1つ選ぶ", button: "押す", link: "リンク" };
        out.push("    見えた欄: " + s.fields.slice(0, 5).map((f) => `${f.name}=${KJ[f.kind] || f.kind}`).join("・"));
      }
    }
  } else if (b.shots && b.shots.total) {
    out.push("");
    out.push(`▼ 写真から学んだ仕組み: まだ（写真 ${b.shots.total}枚・操作つき ${b.shots.with_ops}枚。操作が付くと学べます）`);
  }
  return out;
}

/** 拡張が読む形に小さくする（DB から返す時・storage に置く時） */
export function compactBundle(b: HumanLearnBundle): HumanLearnBundle {
  const next: Record<string, NextStat> = {};
  Object.entries(b.next).slice(0, 120).forEach(([k, v]) => { next[k] = v; });
  const points: Record<string, PointStat> = {};
  Object.entries(b.points)
    .sort((a, c) => c[1].n - a[1].n)
    .slice(0, 120)
    .forEach(([k, v]) => { points[k] = v; });
  return { ...b, next, points, buttons: b.buttons.slice(0, 30) };
}
