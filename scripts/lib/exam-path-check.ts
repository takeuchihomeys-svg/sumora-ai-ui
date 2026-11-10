// scripts/lib/exam-path-check.ts — 流す前に「その試験の問題が、直した所（統括の連携の表の行）の道を通るか」を LLM なしで確かめる（強化の一覧 D2）
//
// 2026-11-10 作業員8（統括役の頼み）: 11/11 作業員1 の4問・作業員4 の5問が、変えた道を一度も通らず「悪化0」になっていた（効き目を測れていない）。
//   ①依頼の作業ツリーで変えたファイル → 連携の表（app/lib/conductor-linkage.ts）の行（files に入っている物）
//   ②各問題の前の答え（brain-exam-baseline の一番新しい行）の印（exam-miss-stage.markersOf）が、その行の writes に前方一致するか
//   どの問題も通らなければ知らせる（止めない）。判断のブレイン（brain-core 共用）しか当たらない直し・表に無いファイルだけの直しは「分からない」で知らせない。
//   止める: EXAM_PATH_CHECK=off
import type { ConductorLink } from "../../app/lib/conductor-linkage";

/** 変えたファイルに当たる連携の表の行（files の頭が一致・「（…）」の注は外して比べる） */
export function touchedLinks(changed: readonly string[], links: readonly ConductorLink[]): ConductorLink[] {
  const norm = (f: string) => f.replace(/[（(].*$/, "").trim();
  return links.filter((l) => l.files.some((f) => changed.includes(norm(f))));
}

/** 印が行の writes に当たるか（「log:」だけの広い印は数えない） */
const markerHits = (m: string, l: ConductorLink) => l.writes.some((w) => w !== "log:" && (m.startsWith(w) || (w.endsWith(":") && m.startsWith(w))));

export type PathCheck =
  | { verdict: "unknown"; why: string }
  | { verdict: "ok" | "none"; links: string[]; passing: string[]; notPassing: string[]; noAnswer: string[] };

/**
 * 判定（純）。markersById: 問題 → 前の答えの印（null＝前の答えが無い）。
 *   brain の行（共用・どの問題も decision:llm を持つ）だけが当たる時は unknown（道の確かめにならない）
 */
export function pathCheck(i: { changed: readonly string[]; links: readonly ConductorLink[]; markersById: Record<string, string[] | null> }): PathCheck {
  const hit = touchedLinks(i.changed, i.links).filter((l) => l.id !== "brain");
  if (!hit.length) return { verdict: "unknown", why: "連携の表の行（brain 以外）に当たる変更が無い" };
  const passing: string[] = [], notPassing: string[] = [], noAnswer: string[] = [];
  for (const [id, ms] of Object.entries(i.markersById)) {
    if (!ms) { noAnswer.push(id); continue; }
    (ms.some((m) => hit.some((l) => markerHits(m, l))) ? passing : notPassing).push(id);
  }
  if (!passing.length && !notPassing.length) return { verdict: "unknown", why: "前の答えのある問題が無い" };
  return { verdict: passing.length ? "ok" : "none", links: hit.map((l) => l.id), passing, notPassing, noAnswer };
}
