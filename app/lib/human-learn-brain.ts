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

import { reconcilePoints, findWeakPoints, learnFromShots, guessKindFromName, planLearnFromWeak } from "./shot-learn";

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
  source: { rows: number; from: string | null; to: string | null; sites: string[] };
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
  /** ⑥ 操作と操作の間（中央値 ms） */
  gaps: { median_ms: number | null; samples: number };
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
export function sequencesOf(row: MotionRow): Array<Array<{ t: number | null; k: string | null; f: string }>> {
  const raw = row.shot_ops;
  if (!Array.isArray(raw)) return [];
  const seq: Array<{ t: number | null; k: string | null; f: string }> = [];
  for (const o of raw as unknown[]) {
    if (!o || typeof o !== "object") continue;
    const r = o as Record<string, unknown>;
    const f = typeof r.f === "string" ? r.f.trim().slice(0, 30) : "";
    if (!f) continue;
    seq.push({ t: num(r.t), k: typeof r.k === "string" ? r.k.slice(0, 10) : null, f });
  }
  return seq.length >= 2 ? [seq] : [];
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

/** 動きの癖（速さ・曲がり・狙う位置・スクロール）をまとめる */
export function learnMotion(rows: ReadonlyArray<MotionRow>): MotionStat {
  const speeds: number[] = [], curves: number[] = [], dx: number[] = [], dy: number[] = [], dyScroll: number[] = [];
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
export function buildHumanLearnBundle(rows: ReadonlyArray<MotionRow>, nowMs: number = Date.now()): HumanLearnBundle {
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
   * 2026-11-13 竹内さん「学習の統括が強化されるように、その点も徹底する」:
   *   弱い所を**次にやる事**に変える（統括の判断）。優先度順・根拠つき。
   */
  const learnPlan = planLearnFromWeak(weak, guessed);

  // 元にした期間
  const times = list.map((r) => (r.created_at ? Date.parse(String(r.created_at)) : NaN)).filter((t) => Number.isFinite(t));
  const sites = Array.from(new Set(list.map((r) => String(r.site || "")).filter(Boolean)));

  /**
   * 2026-11-13 竹内さん「録画した画像もみて押し方や仕組みなども学習おねがい
   *   抜けている部分徹底的に学習できるように」:
   *   **写真（画面）ごとの仕組み**を学ぶ。画像そのものは見ずに、
   *   写真の行が持つ「URL・直前の操作・写真から読んだ欄」から画面を判定してまとめる。
   *   ⚠ 入れるのは画面の種類・欄の名前・順番だけ（中身は入れない）。
   */
  const shotRows = list.filter((r) => {
    const x = r as unknown as Record<string, unknown>;
    return Array.isArray(x.shot_ops) || (x.shot_learn && typeof x.shot_learn === "object") || typeof x.url === "string";
  });
  const shotLearn = shotRows.length
    ? learnFromShots(shotRows.map((r) => {
      const x = r as unknown as Record<string, unknown>;
      return { url: x.url, shot_ops: x.shot_ops, shot_learn: x.shot_learn, created_at: x.created_at };
    }))
    : { screens: {}, total: 0, withOps: 0 };

  const bundle: HumanLearnBundle = {
    v: 1,
    generated_at: new Date(nowMs).toISOString(),
    source: {
      rows: list.length,
      from: times.length ? new Date(Math.min(...times)).toISOString() : null,
      to: times.length ? new Date(Math.max(...times)).toISOString() : null,
      sites,
    },
    next,
    points,
    motion,
    buttons,
    site_flow,
    gaps: { median_ms: median(gapSamples), samples: gapSamples.length },
    ...(weak.length ? { weak } : {}),
    ...(Object.keys(shotLearn.screens).length ? { screen_flow: shotLearn.screens, shots: { total: shotLearn.total, with_ops: shotLearn.withOps } } : {}),
    ...(learnPlan.items.length || learnPlan.filled ? { learn_plan: learnPlan } : {}),
    lines: [],
  };
  bundle.lines = describeBundle(bundle);
  return bundle;
}

/** 何を学んだかを人が読める1行ずつに（画面・報告用） */
export function describeBundle(b: HumanLearnBundle): string[] {
  const out: string[] = [];
  const pct = (x: number) => Math.round(x * 100) + "%";
  out.push(`元にした記録: ${b.source.rows}件${b.source.sites.length ? "（" + b.source.sites.join("・") + "）" : ""}`);
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
