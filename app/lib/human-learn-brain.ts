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

/** 1行分（`human_motion_learn` の必要な列だけ） */
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
};

/** 押した位置（要素ごと） */
export type PointStat = { x: number; y: number; n: number; /** 要素の種類（select/checkbox/text/button/link/other） */ w?: string };
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
  const seqs: Array<Array<{ f: string }>> = [];
  for (const r of list) for (const s of sequencesOf(r)) seqs.push(s);
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
  const siteFlow: Record<string, Record<string, Record<string, number>>> = {};
  for (const r of list) {
    const site = String(r.site || "").trim() || "unknown";
    for (const s of sequencesOf(r)) {
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
  const gapSamples = list.map((r) => num(r.move_ms)).filter((v): v is number => v != null && v > 0);

  // 元にした期間
  const times = list.map((r) => (r.created_at ? Date.parse(String(r.created_at)) : NaN)).filter((t) => Number.isFinite(t));
  const sites = Array.from(new Set(list.map((r) => String(r.site || "")).filter(Boolean)));

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
