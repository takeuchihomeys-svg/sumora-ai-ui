// scripts/lib/claude-split-learned.ts — 台帳 #799 ③: 本番（Claude）と試験（DeepSeek）の割れの型の表を毎晩の結果から育てる（純関数＋置き場の読み・LLM なし・DB なし）
// 2026-11-26 作業員L（統括役の頼み・竹内さん 11/26「試験の質もっと上げれないか？」）:
//   claude-check-gate の SPLIT_SCENES は 11/25 の晩の Claude 16問から手で1行（物件・確認 75%）。Claude の確かめの組（cc-*・a-claude-* 等の Claude の行）が増えるたびに、
//   同じ問題の DeepSeek の行と道の系統（返信・確認・見積・物件・内覧…）を比べ、系統ごとの一致率を数え直す。一致率が線（既定 0.85）より低く n が足りる系統を
//   「割れやすい型」として置き場（<exam-cache>/claude-split-learned.json）に書く。関所（claude-check-gate.splitScenesNow）は手の表と覚えた表を重ねて使う
//   （同じ系統は覚えた表の数を使う・覚えた表で割れが小さくなった系統は外れる）。返信の系統は型にしない（ほとんどの問題に当たる＝関所が全部に掛かる）。
//   書くのは晩の費用0の仕事（scripts/build-claude-split.ts）。止める: CLAUDE_SPLIT_LEARNED=off（手の表だけ）
import { readFileSync } from "node:fs";
import type { SplitScene } from "./claude-check-gate";

export type SplitRow = { id: string; claude: boolean; fam: string; head?: string | null; at?: number };

/**
 * 版をそろえる（純関数・作業員A の audit-model-split の考え「同じコードの版どうしで比べる」）: 問題ごとに、一番新しい Claude の組（at が最大）の版（head）の Claude の行と、
 *   同じ版の DeepSeek の行だけを残す。同じ版の DeepSeek の行が無い問題は、その Claude の組に時刻が一番近い1つの版の DeepSeek の行で補う（近い版）。
 *   版が分からない行（head なし）は、どの版とも同じとは見なさない（時刻の近さでだけ使う）。返すのは残した行と、同じ版でそろった問題の数
 */
export function alignByHead(rows: readonly SplitRow[]): { rows: SplitRow[]; sameHead: number; nearHead: number } {
  const by = new Map<string, SplitRow[]>();
  for (const r of rows) by.set(r.id, [...(by.get(r.id) ?? []), r]);
  const out: SplitRow[] = []; let sameHead = 0, nearHead = 0;
  for (const xs of by.values()) {
    const cs = xs.filter((r) => r.claude); if (!cs.length) continue;
    const last = cs.reduce((a, b) => ((b.at ?? 0) > (a.at ?? 0) ? b : a));
    const cRows = cs.filter((r) => (last.head ? r.head === last.head : r === last));
    const ds = xs.filter((r) => !r.claude);
    let dRows = last.head ? ds.filter((r) => r.head === last.head) : [];
    if (dRows.length) sameHead++;
    else if (ds.length) {
      const near = ds.reduce((a, b) => (Math.abs((b.at ?? 0) - (last.at ?? 0)) < Math.abs((a.at ?? 0) - (last.at ?? 0)) ? b : a));
      dRows = ds.filter((r) => (near.head ? r.head === near.head : r === near)); nearHead++;
    }
    out.push(...cRows, ...dRows);
  }
  return { rows: out, sameHead, nearHead };
}
export type LearnedSplitFile = { v: 1; builtAt: string; minN: number; maxRate: number; families: Record<string, { agree: number; n: number }>; scenes: SplitScene[] };

const maj = (xs: string[]) => { const c = new Map<string, number>(); for (const x of xs) c.set(x, (c.get(x) ?? 0) + 1); return [...c].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null; };

/** 問題ごとに Claude の多数の系統と DeepSeek の多数の系統を比べ、系統ごとに一致を数える（どちらかがその系統を選んだ問題をその系統で数える・純関数） */
export function splitFamiliesOf(rows: readonly SplitRow[]): Record<string, { agree: number; n: number }> {
  const by = new Map<string, { c: string[]; d: string[] }>();
  for (const r of rows) { const x = by.get(r.id) ?? { c: [], d: [] }; (r.claude ? x.c : x.d).push(r.fam); by.set(r.id, x); }
  const out: Record<string, { agree: number; n: number }> = {};
  for (const { c, d } of by.values()) {
    const a = maj(c), b = maj(d); if (!a || !b) continue;
    for (const f of new Set([a, b])) { const o = (out[f] ??= { agree: 0, n: 0 }); o.n++; if (a === b) o.agree++; }
  }
  return out;
}
/** 割れやすい型（返信は外す・n が minN 以上で一致率が maxRate 未満・純関数） */
export function learnedScenesOf(fams: Record<string, { agree: number; n: number }>, day: string, minN = 5, maxRate = 0.85): SplitScene[] {
  return Object.entries(fams).filter(([f, v]) => f !== "返信" && v.n >= minN && v.agree / v.n < maxRate)
    .sort((x, y) => x[1].agree / x[1].n - y[1].agree / y[1].n)
    .map(([f, v]) => ({ id: `learned_${f}`, label: `${f} の AIX か返信か（覚えた表）`, families: [f], rate: Math.round((v.agree / v.n) * 100) / 100, n: v.n, since: day }));
}
/** 手の表と覚えた表を重ねる（純関数）: 覚えた表が n を持つ系統は、手の行からその系統を外す（覚えた表で割れが小さい系統は型から外れる） */
export function mergeSplitScenes(hand: readonly SplitScene[], learned: LearnedSplitFile | null): SplitScene[] {
  if (!learned) return [...hand];
  const known = new Set(Object.entries(learned.families).filter(([, v]) => v.n >= learned.minN).map(([f]) => f));
  const rest = hand.map((s) => ({ ...s, families: s.families.filter((f) => !known.has(f)) })).filter((s) => s.families.length);
  return [...rest, ...learned.scenes];
}
export function loadLearnedSplit(file: string, env: Record<string, string | undefined> = process.env): LearnedSplitFile | null {
  if ((env.CLAUDE_SPLIT_LEARNED ?? "").trim().toLowerCase() === "off") return null;
  try { const j = JSON.parse(readFileSync(file, "utf8")) as LearnedSplitFile; return j && j.v === 1 && j.families && Array.isArray(j.scenes) ? j : null; } catch { return null; }
}
